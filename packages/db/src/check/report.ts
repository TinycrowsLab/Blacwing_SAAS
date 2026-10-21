// The drift report (DB-002): a Markdown file CI uploads as the `db-drift` job artifact, so a reviewer
// sees exactly which SQL is missing or which catalogue lines differ. It holds schema text only.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** One failed drift check and its evidence (SQL, diff lines or messages). */
export interface DriftSection {
  readonly title: string;
  readonly lines: readonly string[];
  /** Fenced-code language for the evidence (`sql`, `diff`) or plain bullet list when omitted. */
  readonly lang?: 'sql' | 'diff';
}

/** Renders sections as Markdown. */
export function formatDriftReport(sections: readonly DriftSection[]): string {
  return sections
    .map((section) => {
      const body =
        section.lang === undefined
          ? section.lines.map((line) => `- ${line}`).join('\n')
          : `\`\`\`${section.lang}\n${section.lines.join('\n')}\n\`\`\``;
      return `## ${section.title}\n\n${body}\n`;
    })
    .join('\n');
}

/** Appends `sections` to the report at `file` (no-op without a file or without sections). */
export function appendDriftReport(
  file: string | undefined,
  sections: readonly DriftSection[],
): void {
  if (file === undefined || file === '' || sections.length === 0) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${formatDriftReport(sections)}\n`);
}
