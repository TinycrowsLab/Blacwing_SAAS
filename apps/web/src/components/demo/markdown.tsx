/* eslint-disable @typescript-eslint/no-magic-numbers -- slicing markdown delimiters */
// Tiny safe markdown subset for model text: paragraphs, bullet and numbered lists, **bold**, `code`.
// Builds React elements only (no HTML injection).
import type { ReactNode } from 'react';

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return (
        <code key={i} className="rounded bg-surface-2 px-1 py-px font-mono text-[0.92em]">
          {part.slice(1, -1)}
        </code>
      );
    return part;
  });
}

interface Block {
  kind: 'p' | 'ul' | 'ol';
  lines: string[];
}

function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      out.push({ kind: 'p', lines: [] });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const num = /^\d+[.)]\s+(.*)$/.exec(line);
    const kind = bullet ? 'ul' : num ? 'ol' : 'p';
    const body = bullet?.[1] ?? num?.[1] ?? line;
    const last = out.at(-1);
    if (last?.kind === kind && (kind !== 'p' || last.lines.length > 0))
      last.lines.push(body);
    else out.push({ kind, lines: [body] });
  }
  return out.filter((b) => b.lines.length > 0);
}

function BlockView({ b }: { readonly b: Block }) {
  if (b.kind === 'p')
    return (
      <p className="m-0">
        {b.lines.flatMap((l, j) => (j === 0 ? inline(l) : [' ', ...inline(l)]))}
      </p>
    );
  const Tag = b.kind;
  return (
    <Tag className={`m-0 pl-5 ${b.kind === 'ul' ? 'list-disc' : 'list-decimal'}`}>
      {b.lines.map((l, j) => (
        <li key={j}>{inline(l)}</li>
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
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
