// `pnpm lint:prompts` (#652): lints every persona prompt and the base preamble, and fails the run on any
// finding. Each finding prints as a GitHub workflow error command, so the PR shows it inline at file and line.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectPromptSources, lintPromptSources, parseDenylist } from './prompt-lint.js';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Escapes a message for a workflow command (`%`, CR and LF). */
function escapeMessage(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

const denylist = parseDenylist(readFileSync(join(PKG_ROOT, 'lint', 'denylist.json'), 'utf8'));
const sources = collectPromptSources(join(PKG_ROOT, 'prompts'));
const { checked, diagnostics } = lintPromptSources(sources, denylist);

for (const d of diagnostics) {
  process.stdout.write(
    `::error file=${d.file},line=${String(d.line)},title=prompt-lint ${d.rule}::${escapeMessage(d.message)}\n`,
  );
}
process.stdout.write(
  `prompt-lint: ${String(checked)} file(s) checked, ${String(diagnostics.length)} finding(s)\n`,
);
process.exitCode = diagnostics.length > 0 ? 1 : 0;
