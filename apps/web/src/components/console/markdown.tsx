/* eslint-disable @typescript-eslint/no-magic-numbers -- slicing markdown delimiters */
// Tiny safe markdown subset for model text: headings, paragraphs, (nested) bullet and numbered lists, tables, **bold**,
// `code`.
// Builds React elements only (no HTML injection).
import type { ReactNode } from 'react';

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function inline(text: string, line = 0): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${line}-${i}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return (
        <code key={key} className="rounded bg-surface-2 px-1 py-px font-mono text-[0.92em]">
          {part.slice(1, -1)}
        </code>
      );
    return part;
  });
}

interface Block {
  kind: 'h' | 'p' | 'ul' | 'ol' | 'table';
  lines: string[];
  /** Leading-space count per line, used to indent nested list items. */
  indents: number[];
}

const NEST_STEP = 2;
const isTableRow = (line: string): boolean => line.startsWith('|') && line.endsWith('|');
const isTableRule = (line: string): boolean => /^\|[\s|:-]+\|$/.test(line);
const cells = (line: string): string[] =>
  line
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim());

function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      out.push({ kind: 'p', lines: [], indents: [] });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const num = /^\d+[.)]\s+(.*)$/.exec(line);
    const kind = heading ? 'h' : isTableRow(line) ? 'table' : bullet ? 'ul' : num ? 'ol' : 'p';
    const body = heading?.[1] ?? bullet?.[1] ?? num?.[1] ?? line;
    const indent = raw.length - raw.trimStart().length;
    const last = out.at(-1);
    if (last?.kind === kind && kind !== 'h' && (kind !== 'p' || last.lines.length > 0)) {
      last.lines.push(body);
      last.indents.push(indent);
    } else out.push({ kind, lines: [body], indents: [indent] });
  }
  return out.filter((b) => b.lines.length > 0);
}

function BlockView({ b }: { readonly b: Block }) {
  if (b.kind === 'h') return <p className="m-0 font-semibold">{inline(b.lines[0] ?? '')}</p>;
  if (b.kind === 'p')
    return (
      <p className="m-0">
        {b.lines.flatMap((l, j) => (j === 0 ? inline(l, j) : [' ', ...inline(l, j)]))}
      </p>
    );
  if (b.kind === 'table') {
    const [head, ...rows] = b.lines.filter((l) => !isTableRule(l)).map((l) => cells(l));
    return (
      <div className="overflow-x-auto rounded-[10px] border border-border">
        <table className="w-full border-collapse text-left text-[13px]">
          <thead className="bg-surface-2">
            <tr>
              {head?.map((c, i) => (
                <th key={i} className="px-3 py-1.5 font-semibold">
                  {inline(c, i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, j) => (
              <tr key={j} className="border-t border-border">
                {r.map((c, i) => (
                  <td key={i} className="px-3 py-1.5 align-top">
                    {inline(c, i)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const Tag = b.kind;
  return (
    <Tag className={`m-0 pl-5 ${b.kind === 'ul' ? 'list-disc' : 'list-decimal'}`}>
      {b.lines.map((l, j) => (
        <li key={j} style={{ marginLeft: `${((b.indents[j] ?? 0) / NEST_STEP) * 0.75}rem` }}>
          {inline(l, j)}
        </li>
      ))}
    </Tag>
  );
}

export function Markdown({
  text,
  className = '',
}: {
  readonly text: string;
  readonly className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {blocks(text).map((b, i) => (
        <BlockView key={i} b={b} />
      ))}
    </div>
  );
}

/** Plain one-line text for places that cannot render markdown (lane task, activity rows). */
export const stripMarkdown = (text: string): string =>
  text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
