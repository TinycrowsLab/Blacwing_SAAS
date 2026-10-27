import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { PREAMBLE_PLACEHOLDERS, fillPreamble, type PreamblePlaceholder } from './base-preamble.js';
import { composePrompt, type RunContext } from './compose.js';
import {
  BASE_PROMPT_KEY,
  PROMPT_KEYS,
  PromptError,
  hashPromptBody,
  parsePromptFile,
  type ParsedPrompt,
} from './prompt.js';

/**
 * The prompt linter (`pnpm lint:prompts`, #652, CONTEXT_PACK §4.6). It checks every file under
 * `prompts/` before it can merge:
 *
 *  - `front-matter`: the file parses, its persona and version match the path, and the name is `<semver>.md`;
 *  - `base-preamble`: every persona composes with the `_base` preamble and the preamble leads the prompt;
 *  - `placeholder`: persona bodies hold no `{placeholder}` (they are not filled at run time) and the
 *    preamble uses only the known, complete placeholder set;
 *  - `standard-id`: every standard identifier that looks like a citation is well formed;
 *  - `forbidden-content`: payload-shaped text matches the reviewed denylist (`packages/agents/lint/`).
 *
 * The rules are pure: they take sources and a denylist and return findings. The file-system collector and
 * the CLI sit beside them. Findings name the file and line; they never echo matched payload text.
 */

export const PROMPTS_DIR_FILE = 'packages/agents/prompts';
export const DENYLIST_FILE = 'packages/agents/lint/denylist.json';

const PROMPT_FILE_NAME = /^\d+\.\d+\.\d+\.md$/;
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

const LIMIT = { id: 64, description: 200, pattern: 500, reason: 300 } as const;

const denylistRuleSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case'),
    description: z.string().trim().min(1).max(LIMIT.description),
    pattern: z.string().min(1).max(LIMIT.pattern),
    flags: z
      .string()
      .regex(/^[imsu]*$/, 'flags must be a subset of imsu')
      .default('i'),
  })
  .superRefine((rule, ctx) => {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, rule.flags);
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: 'is not a valid regular expression',
      });
      return;
    }
    if (re.test('')) {
      ctx.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: 'must not match the empty string',
      });
    }
  });

const allowEntrySchema = z.strictObject({
  rule: z.string().min(1).max(LIMIT.id),
  file: z.string().min(1),
  /** The exact matched text this entry excuses, in `file` only. */
  token: z.string().min(1),
  reason: z.string().trim().min(1).max(LIMIT.reason),
});

/** The reviewed denylist and allowlist (documented in `packages/agents/lint/README.md`). */
const denylistSchema = z
  .strictObject({
    rules: z.array(denylistRuleSchema).min(1),
    allowlist: z.array(allowEntrySchema).default([]),
  })
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const [i, rule] of list.rules.entries()) {
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', i, 'id'],
          message: `duplicate rule id ${rule.id}`,
        });
      }
      seen.add(rule.id);
    }
  });
export type Denylist = z.infer<typeof denylistSchema>;

/** Parses and validates the denylist file. Throws on any malformed rule, so a broken list fails CI. */
export function parseDenylist(text: string): Denylist {
  return denylistSchema.parse(JSON.parse(text));
}

/** One prompt file as the linter sees it. `dir` and `name` come from its path under `prompts/`. */
export interface PromptSource {
  /** Repo-relative path shown in findings, e.g. `packages/agents/prompts/planner/1.0.0.md`. */
  readonly file: string;
  /** Directory name: a persona key or `_base`. */
  readonly dir: string;
  /** File name, expected to be `<semver>.md`. */
  readonly name: string;
  readonly text: string;
}

interface PromptLintDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
  /** The matched text, used only for allowlist matching and never printed for forbidden content. */
  readonly token: string;
}

export interface PromptLintResult {
  readonly checked: number;
  readonly diagnostics: readonly PromptLintDiagnostic[];
}

interface StandardCheck {
  readonly candidate: RegExp;
  readonly valid: RegExp;
  readonly format: string;
  readonly normalise?: (token: string) => string;
}

/**
 * Identifier-shaped tokens are checked against their format. A bare name ("ASVS", "CWE") is prose and
 * not checked, so a malformed citation is caught even when it is written badly.
 */
const STANDARD_CHECKS: readonly StandardCheck[] = [
  {
    candidate: /\bWSTG-[\w-]*/g,
    valid: /^WSTG-[A-Z]{4}(?:-\d{2})?$/,
    format: 'WSTG-<CATEGORY> or WSTG-<CATEGORY>-<NN>',
  },
  { candidate: /\bCWE-[\w#]*/g, valid: /^CWE-[1-9]\d{0,4}$/, format: 'CWE-<number>' },
  {
    candidate: /\bA\d[\dx]?\b/g,
    valid: /^A(?:0[1-9]|10)$/,
    format: 'A01 to A10 (OWASP Top 10)',
  },
  {
    candidate: /\bAPI\d[\dx]*\b/g,
    valid: /^API(?:0[1-9]|10)$/,
    format: 'API01 to API10 (OWASP API Top 10)',
  },
  {
    candidate: /\bASVS\b\s*v?\d[^\s,;:)`'"]*/g,
    valid: /^ASVS v5\.0\.0(?:-V\d+(?:\.\d+){0,2})?$/,
    format: 'ASVS v5.0.0 or ASVS v5.0.0-V<chapter>[.<section>[.<item>]]',
    normalise: (token) => token.replace(/\.+$/, ''),
  },
];

/** Run context used to compose each persona against the preamble. Values are fixed and benign. */
const SAMPLE_CONTEXT: RunContext = {
  saId: 'SA-LINT-0000',
  approverIdentity: 'prompt-lint',
  assetScope: ['lint.example'],
  testWindow: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
  maxIntrusiveness: 'passive',
  roles: ['viewer'],
};

const SAMPLE_VALUES: Readonly<Record<PreamblePlaceholder, string>> = {
  saId: 'SA-LINT-0000',
  approverIdentity: 'prompt-lint',
  assetScope: 'lint.example',
  testWindow: '2026-01-01T00:00:00Z to 2026-01-02T00:00:00Z',
  maxIntrusiveness: 'passive',
  roles: 'viewer',
};

type Report = (diagnostic: PromptLintDiagnostic) => void;

function finding(
  file: string,
  line: number,
  rule: string,
  message: string,
  token = '',
): PromptLintDiagnostic {
  return { file, line, rule, message, token };
}

/** Validates the file name, directory and front-matter. Returns the parsed prompt when it is usable. */
function checkFrontMatter(source: PromptSource, report: Report): ParsedPrompt | undefined {
  const fail = (message: string): void => {
    report(finding(source.file, 1, 'front-matter', message));
  };
  if (!(PROMPT_KEYS as readonly string[]).includes(source.dir)) {
    fail(`unknown persona directory "${source.dir}"`);
  }
  if (!PROMPT_FILE_NAME.test(source.name)) fail('file name must be <semver>.md');
  let prompt: ParsedPrompt;
  try {
    prompt = parsePromptFile(source.text);
  } catch (e) {
    if (e instanceof PromptError) {
      fail(e.message);
      return undefined;
    }
    throw e;
  }
  if (prompt.meta.persona !== source.dir) {
    fail(`front-matter persona "${prompt.meta.persona}" does not match directory "${source.dir}"`);
  }
  if (`${prompt.meta.version}.md` !== source.name) {
    fail(`front-matter version "${prompt.meta.version}" does not match the file name`);
  }
  return prompt;
}

interface CompiledRule {
  readonly id: string;
  readonly description: string;
  readonly re: RegExp;
}

/** Runs every content rule on every line: forbidden content, standard IDs and placeholders. */
function scanLines(source: PromptSource, rules: readonly CompiledRule[], report: Report): void {
  const isBase = source.dir === BASE_PROMPT_KEY;
  const lines = source.text.split(/\r\n|\r|\n/);
  lines.forEach((text, index) => {
    const line = index + 1;
    for (const rule of rules) {
      for (const match of text.matchAll(rule.re)) {
        if (match[0].length === 0) continue;
        report(
          finding(
            source.file,
            line,
            rule.id,
            `payload-shaped content: ${rule.description}`,
            match[0],
          ),
        );
      }
    }
    for (const check of STANDARD_CHECKS) {
      for (const match of text.matchAll(check.candidate)) {
        const token = match[0];
        const id = check.normalise ? check.normalise(token) : token;
        if (!check.valid.test(id)) {
          report(
            finding(
              source.file,
              line,
              'standard-id',
              `malformed standard identifier "${token}"; expected ${check.format}`,
              token,
            ),
          );
        }
      }
    }
    for (const match of text.matchAll(PLACEHOLDER)) {
      const key = match[1] ?? '';
      if (!isBase) {
        report(
          finding(
            source.file,
            line,
            'placeholder',
            `unresolvable placeholder {${key}}: persona prompts are not filled at composition`,
            match[0],
          ),
        );
      } else if (!(PREAMBLE_PLACEHOLDERS as readonly string[]).includes(key)) {
        report(
          finding(
            source.file,
            line,
            'placeholder',
            `unknown preamble placeholder {${key}}`,
            match[0],
          ),
        );
      }
    }
  });
}

/** Every persona must compose with the base preamble, and the preamble must lead the composed prompt. */
function checkComposition(
  usable: readonly { readonly source: PromptSource; readonly prompt: ParsedPrompt }[],
  report: Report,
): void {
  const base = usable.find((u) => u.prompt.meta.persona === BASE_PROMPT_KEY);
  const personas = usable.filter((u) => u.prompt.meta.persona !== BASE_PROMPT_KEY);
  if (base === undefined) {
    if (personas.length > 0) {
      report(
        finding(
          PROMPTS_DIR_FILE,
          1,
          'base-preamble',
          'no valid _base preamble; personas cannot be composed',
        ),
      );
    }
    return;
  }
  let expected: string;
  try {
    expected = fillPreamble(base.prompt.body, SAMPLE_VALUES).trimEnd();
  } catch (e) {
    if (e instanceof PromptError) {
      report(finding(base.source.file, 1, 'base-preamble', e.message));
      return;
    }
    throw e;
  }
  for (const { source, prompt } of personas) {
    try {
      const composed = composePrompt(
        {
          persona: prompt.meta.persona,
          body: prompt.body,
          version: prompt.meta.version,
          sha256: hashPromptBody(prompt.body),
        },
        SAMPLE_CONTEXT,
        { preamble: base.prompt.body },
      );
      if (!composed.systemPrompt.startsWith(expected)) {
        report(
          finding(
            source.file,
            1,
            'base-preamble',
            'composed prompt does not start with the base preamble',
          ),
        );
      }
    } catch (e) {
      if (e instanceof PromptError) {
        report(finding(source.file, 1, 'base-preamble', e.message));
        continue;
      }
      throw e;
    }
  }
}

/** Lints prompt sources against the denylist. Every finding is reported unless an allowlist entry excuses it. */
export function lintPromptSources(
  sources: readonly PromptSource[],
  denylist: Denylist,
): PromptLintResult {
  const found: PromptLintDiagnostic[] = [];
  const usedAllow = new Set<number>();
  const report: Report = (d) => {
    const index = denylist.allowlist.findIndex(
      (a) => a.rule === d.rule && a.file === d.file && a.token === d.token,
    );
    if (index >= 0) {
      usedAllow.add(index);
      return;
    }
    found.push(d);
  };
  const rules: CompiledRule[] = denylist.rules.map((r) => ({
    id: r.id,
    description: r.description,
    re: new RegExp(r.pattern, `${r.flags}g`),
  }));

  const usable: { source: PromptSource; prompt: ParsedPrompt }[] = [];
  for (const source of sources) {
    const prompt = checkFrontMatter(source, report);
    if (prompt !== undefined) usable.push({ source, prompt });
    scanLines(source, rules, report);
  }

  const base = sources.find((s) => s.dir === BASE_PROMPT_KEY);
  if (base !== undefined) {
    for (const key of PREAMBLE_PLACEHOLDERS) {
      if (!base.text.includes(`{${key}}`)) {
        report(finding(base.file, 1, 'placeholder', `base preamble lacks {${key}}`));
      }
    }
  }
  checkComposition(usable, report);

  denylist.allowlist.forEach((entry, index) => {
    if (!usedAllow.has(index)) {
      found.push(
        finding(
          DENYLIST_FILE,
          1,
          'allowlist',
          `unused allowlist entry for ${entry.rule} "${entry.token}" in ${entry.file}; remove it`,
        ),
      );
    }
  });

  found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { checked: sources.length, diagnostics: found };
}

/** Reads every file under `promptsDir/<dir>/` as a source. Stray root-level files are not prompts and are skipped. */
export function collectPromptSources(promptsDir: string): PromptSource[] {
  const sources: PromptSource[] = [];
  const dirs = readdirSync(promptsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const dir of dirs) {
    const files = readdirSync(join(promptsDir, dir.name), { withFileTypes: true })
      .filter((f) => f.isFile())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const file of files) {
      sources.push({
        file: `${PROMPTS_DIR_FILE}/${dir.name}/${file.name}`,
        dir: dir.name,
        name: file.name,
        text: readFileSync(join(promptsDir, dir.name, file.name), 'utf8'),
      });
    }
  }
  return sources;
}
