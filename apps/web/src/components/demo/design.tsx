/* Presentational values (pixel sizes, opacity steps, poll and tick intervals) come from design/ and are not domain constants. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- design-system pixel and timing values, see design/README.md */
// DEMO-STORY design kit: the components of design/ ("Blackwing Design System", section 06) built on the
// tokens in packages/ui (CSS variables, never hex). Server-safe: no hooks in this file.
import Link from 'next/link';

import type { CSSProperties, ReactNode } from 'react';

/** Line icon paths from the design system (stroke 1.5 to 2, 24 grid). */
export const ICONS = {
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M21 21l-4.3-4.3',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.9 1.9 0 0 0 3.4 0',
  kill: 'M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z M15 9l-6 6 M9 9l6 6',
  pause: 'M8 5v14 M16 5v14',
  shield: 'M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5z M9 12l2 2 4-4',
  agent: 'M4 8h16v12H4z M12 4v4 M9 13h.01 M15 13h.01',
  warn: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z M12 9v4 M12 17h.01',
  x: 'M18 6 6 18 M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  ledger: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
  probe: 'M12 2v4 M12 18v4 M2 12h4 M18 12h4 M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z',
  clock: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z M12 6v6l4 2',
  info: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z M12 16v-4 M12 8h.01',
  dot: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
  web: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z M2 12h20 M12 2a15 15 0 0 1 0 20 M12 2a15 15 0 0 0 0 20',
  api: 'M4 7h16 M4 12h16 M4 17h10',
  host: 'M3 4h18v6H3z M3 14h18v6H3z M7 7h.01 M7 17h.01',
  approve: 'M9 11l3 3 8-8 M20 12v7H4V5h11',
  sign: 'M14 2H6v20h12V6z M14 2v4h4 M8 17c2-2 3 1 4-1s2 0 4 0',
  key: 'M8 11a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M11 14l10-10 M17 8l3 3',
  settings: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
  grid: 'M3 3h7v9H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 16h7v5H3z',
  term: 'M4 17l6-6-6-6 M12 19h8',
  undo: 'M9 14 4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-3',
  minus: 'M5 12h14',
  plus: 'M12 5v14 M5 12h14',
  chevron: 'M6 9l6 6 6-6',
  arrowLeft: 'M19 12H5 M12 19l-7-7 7-7',
  assets: 'M3 4h18v6H3z M3 14h18v6H3z M7 7h.01 M7 17h.01',
  auth: 'M14 2H6v20h12V6z M14 2v4h4 M8 17c2-2 3 1 4-1s2 0 4 0',
  assessments: 'M4 17l6-6-6-6 M12 19h8',
  approvals: 'M9 11l3 3 8-8 M20 12v7H4V5h11',
  findings: 'M8 6a4 4 0 0 1 8 0v1H8z M6 9h12v6a6 6 0 0 1-12 0z M12 9v12 M3 13h3 M18 13h3',
  reports: 'M14 2H6v20h12V6z M14 2v4h4 M9 13h6 M9 17h6',
  plusCircle: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z M12 8v8 M8 12h8',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 16,
  className,
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string | undefined;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: size >= 20 ? 1.5 : 1.75,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        flex: 'none',
      }}
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export type Tone =
  | 'ok'
  | 'warn'
  | 'bad'
  | 'primary'
  | 'muted'
  | 'kill'
  | 'crit'
  | 'high'
  | 'med'
  | 'low'
  | 'info'
  | 'navy'
  | 'neutral';

/** Foreground and background per tone, the same pairs the design's chip groups use. */
const TONE: Record<Tone, { fg: string; bg: string }> = {
  ok: { fg: 'text-ok', bg: 'bg-ok-soft' },
  warn: { fg: 'text-warn', bg: 'bg-warn-soft' },
  bad: { fg: 'text-bad', bg: 'bg-bad-soft' },
  primary: { fg: 'text-primary', bg: 'bg-primary-soft' },
  muted: { fg: 'text-muted-foreground', bg: 'bg-surface-2' },
  kill: { fg: 'text-on-kill', bg: 'bg-kill' },
  crit: { fg: 'text-crit-fg', bg: 'bg-crit' },
  high: { fg: 'text-high', bg: 'bg-high-soft' },
  med: { fg: 'text-med', bg: 'bg-med-soft' },
  low: { fg: 'text-low', bg: 'bg-low-soft' },
  info: { fg: 'text-sinfo', bg: 'bg-sinfo-soft' },
  navy: { fg: 'text-on-primary', bg: 'bg-navy-bar' },
  neutral: { fg: 'text-text', bg: 'bg-surface-2' },
};

/** Severity bars: the design draws 1 to 4 bars, filled up to the level. */
const SEVERITY: Record<string, { tone: Tone; level: number }> = {
  critical: { tone: 'crit', level: 4 },
  high: { tone: 'high', level: 3 },
  medium: { tone: 'med', level: 2 },
  low: { tone: 'low', level: 1 },
  info: { tone: 'info', level: 0 },
};

export function SeverityBars({ level }: { readonly level: number }) {
  return (
    <span aria-hidden="true" className="inline-flex h-2.5 items-end gap-px">
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="w-[2.5px] rounded-[1px] bg-current"
          style={{ height: `${3 + i * 1.75}px`, opacity: i <= level ? 1 : 0.25 }}
        />
      ))}
    </span>
  );
}

/** Badge: a fixed fact (6 px radius). Use `pill` for live states. */
export function Chip({
  tone = 'neutral',
  icon,
  pill = false,
  bordered = false,
  pulse = false,
  children,
  title,
}: {
  readonly tone?: Tone;
  readonly icon?: IconName | undefined;
  readonly pill?: boolean;
  readonly bordered?: boolean;
  readonly pulse?: boolean | undefined;
  readonly children: ReactNode;
  readonly title?: string | undefined;
}) {
  const t = TONE[tone];
  return (
    <span
      title={title}
      className={[
        'inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap border px-2.5 text-xs font-medium',
        pill ? 'rounded-full' : 'rounded-md',
        t.fg,
        bordered ? 'border-current bg-transparent' : `${t.bg} border-transparent`,
      ].join(' ')}
    >
      {icon ? (
        <Icon name={icon} size={12} className={pulse ? 'motion-safe:animate-pulse' : undefined} />
      ) : null}
      {children}
    </span>
  );
}

/** Severity chip: the level is in words and in bars, never colour alone. */
export function SeverityChip({ severity }: { readonly severity: string }) {
  const key = severity.toLowerCase();
  const s = SEVERITY[key] ?? { tone: 'info' as Tone, level: 0 };
  const label = key.charAt(0).toUpperCase() + key.slice(1);
  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1.5 rounded-md px-2 text-xs font-medium ${TONE[s.tone].fg} ${TONE[s.tone].bg}`}
    >
      <SeverityBars level={s.level} />
      {label}
    </span>
  );
}

/** Status chip: `ok` allowed or passed, `warn` needs approval, `bad` blocked or denied. */
export function StatusChip({ value }: { readonly value: string }) {
  const v = value.toLowerCase().replace(/_/g, ' ');
  const map: Record<string, { tone: Tone; icon?: IconName; label: string; pulse?: boolean }> = {
    running: { tone: 'primary', icon: 'dot', label: 'Running', pulse: true },
    queued: { tone: 'muted', icon: 'clock', label: 'Queued' },
    'pending gate1': { tone: 'warn', icon: 'clock', label: 'Awaiting Gate 1' },
    approved: { tone: 'ok', icon: 'check', label: 'Approved' },
    rejected: { tone: 'bad', icon: 'x', label: 'Rejected' },
    completed: { tone: 'ok', icon: 'check', label: 'Completed' },
    failed: { tone: 'bad', icon: 'x', label: 'Failed' },
    cancelled: { tone: 'muted', icon: 'minus', label: 'Cancelled' },
    confirmed: { tone: 'ok', icon: 'check', label: 'Confirmed' },
    validating: { tone: 'primary', icon: 'clock', label: 'Validating' },
    suspected: { tone: 'warn', icon: 'info', label: 'Suspected' },
  };
  const m = map[v] ?? { tone: 'muted' as Tone, label: v.charAt(0).toUpperCase() + v.slice(1) };
  return (
    <Chip
      tone={m.tone}
      icon={m.icon}
      pill
      pulse={m.pulse}
      bordered={m.tone === 'warn' || m.tone === 'bad'}
    >
      {m.label}
    </Chip>
  );
}

/** IDs, hashes and requests are set in JetBrains Mono. */
export function IdChip({ children }: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border bg-card px-2 py-0.5 font-mono text-xs font-medium text-foreground">
      {children}
    </span>
  );
}

const BUTTON_BASE =
  'inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 text-[13px] font-medium transition-[filter,background-color,border-color] duration-150 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none motion-reduce:transition-none';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'deny' | 'kill' | 'danger-soft';

const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-primary hover:brightness-90',
  secondary: 'border border-border-strong bg-card text-foreground hover:bg-surface-2',
  ghost: 'bg-transparent text-foreground hover:bg-surface-2',
  deny: 'bg-text text-bg hover:brightness-90',
  kill: 'bg-kill text-on-kill font-semibold shadow-[0_0_0_4px_var(--kill-soft)] hover:brightness-90',
  'danger-soft': 'border border-bad text-bad bg-transparent hover:bg-bad-soft',
};

/** Button classes, for use on `<button>` or `<Link>`. Disabled state is set with the `disabled` attribute. */
export function buttonClass(variant: ButtonVariant = 'primary', extra = ''): string {
  return [BUTTON_BASE, BUTTON[variant], extra].join(' ');
}

export function LinkButton({
  href,
  variant = 'secondary',
  icon,
  children,
  className = '',
}: {
  readonly href: string;
  readonly variant?: ButtonVariant;
  readonly icon?: IconName;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <Link href={href} className={buttonClass(variant, className)}>
      {icon ? <Icon name={icon} size={15} /> : null}
      {children}
    </Link>
  );
}

/** Card: 12 px radius, surface, 1 px border. Tables and cards share this shape. */
export function Card({
  children,
  className = '',
  style,
  as: Tag = 'section',
  'aria-labelledby': labelledBy,
  'aria-label': label,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly as?: 'section' | 'div' | 'article';
  readonly 'aria-labelledby'?: string;
  readonly 'aria-label'?: string;
}) {
  return (
    <Tag
      aria-labelledby={labelledBy}
      aria-label={label}
      style={style}
      className={`overflow-hidden rounded-xl border border-border bg-card ${className}`}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  meta,
  id,
}: {
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly id?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
      <h2 id={id} className="text-sm font-semibold text-foreground">
        {title}
      </h2>
      {meta ? <div className="text-xs text-muted-foreground">{meta}</div> : null}
    </div>
  );
}

/** Table: header on surface-2, rows 48 px comfortable. */
export function DataTable({
  head,
  children,
  label,
}: {
  readonly head: readonly string[];
  readonly children: ReactNode;
  readonly label: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full border-collapse text-[13px]">
        <thead className="bg-surface-2 text-left text-xs font-medium text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="h-9 px-4 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

/** Agent text is set in a dashed box and labelled. It is never shown as a system message. */
export function AgentText({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border-strong bg-code">
      <div className="border-b border-dashed border-border-strong px-3.5 py-2 text-xs font-medium text-muted-foreground">
        {label}
      </div>
      <div className="px-3.5 py-3 font-mono text-[12.5px] leading-5 text-foreground">
        {children}
      </div>
    </div>
  );
}

/** Field label, input and hint in the design's input grammar (42 px, 8 px radius, border-strong). */
export const INPUT_CLASS =
  'h-[42px] w-full rounded-lg border border-border-strong bg-card px-3 text-[13.5px] text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus disabled:bg-surface-2 disabled:text-muted-foreground';

export function PageHeader({
  crumbs,
  title,
  chips,
  actions,
}: {
  readonly crumbs: readonly { label: string; href?: string }[];
  readonly title: ReactNode;
  readonly chips?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-2">
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
            {crumbs.map((c, i) => (
              <li key={`${c.label}-${i}`} className="flex items-center gap-2">
                {i > 0 ? <span aria-hidden="true">/</span> : null}
                {c.href ? (
                  <Link href={c.href} className="hover:text-foreground">
                    {c.label}
                  </Link>
                ) : (
                  <span className="rounded-md border border-border bg-card px-2 py-0.5 font-mono text-xs font-medium text-foreground">
                    {c.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold leading-8 text-foreground">{title}</h1>
          {chips}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2.5">{actions}</div> : null}
    </div>
  );
}
