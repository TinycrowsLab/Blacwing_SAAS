/* Presentational values (pixel sizes, opacity steps, poll and tick intervals) come from design/ and are not domain constants. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- design-system pixel and timing values, see design/README.md */
// Design kit: the components of design/ ("Blackwing Design System", section 06) built on the
// tokens in packages/ui (CSS variables, never hex). Server-safe: no hooks in this file.
import Link from 'next/link';

import type { CSSProperties, ReactNode } from 'react';

/** Line icon paths from the design system (stroke 1.5 to 2, 24 grid). */
const ICONS = {
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
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  plusCircle: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z M12 8v8 M8 12h8',
  home: 'M3 11l9-8 9 8 M5 9.5V21h14V9.5 M10 21v-6h4v6',
  help: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3 M12 17h.01',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  right: 'M9 6l6 6-6 6',
  hand: 'M18 11V6a2 2 0 0 0-4 0v5 M14 10V4a2 2 0 0 0-4 0v6 M10 10.5V6a2 2 0 0 0-4 0v8 M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4L2.4 16a2 2 0 0 1 2.8-2.9L7 15',
  user: 'M12 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M4 21a8 8 0 0 1 16 0',
  team: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M22 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 21h16',
  replay: 'M3 12a9 9 0 1 0 3-6.7 M3 4v5h5',
  reply: 'M9 17l-5-5 5-5 M4 12h11a5 5 0 0 1 5 5v2',
  file: 'M14 2H6v20h12V6z M14 2v4h4',
  spark: 'M12 3v4 M12 17v4 M3 12h4 M17 12h4 M6 6l2.5 2.5 M15.5 15.5 18 18 M6 18l2.5-2.5 M15.5 8.5 18 6',
  enter: 'M20 5v7a3 3 0 0 1-3 3H5 M9 11l-4 4 4 4',
  repeat: 'M17 1l4 4-4 4 M3 11V9a4 4 0 0 1 4-4h14 M7 23l-3-4 3-4 M21 13v2a4 4 0 0 1-4 4H3',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
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
  | 'neutral'
  | 'gold'
  | 'slate'
  | 'you'
  | 'claude';

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
  gold: { fg: 'text-gold-ink', bg: 'bg-gold-soft' },
  slate: { fg: 'text-slate', bg: 'bg-slate-soft' },
  you: { fg: 'text-gold-ink', bg: 'bg-gold-soft shadow-[inset_0_0_0_1px_var(--gold-line)]' },
  claude: { fg: 'text-slate', bg: 'bg-slate-soft' },
};

/** Severity bars: the design draws 1 to 4 bars, filled up to the level. */
const SEVERITY: Record<string, { tone: Tone; level: number }> = {
  critical: { tone: 'crit', level: 4 },
  high: { tone: 'high', level: 3 },
  medium: { tone: 'med', level: 2 },
  low: { tone: 'low', level: 1 },
  info: { tone: 'info', level: 0 },
};

function SeverityBars({ level }: { readonly level: number }) {
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
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border text-xs font-medium',
        pill ? 'h-[26px] rounded-full px-3' : 'h-6 rounded-md px-2.5',
        t.fg,
        bordered ? `border-current ${t.bg}` : `${t.bg} border-transparent`,
      ].join(' ')}
    >
      {icon ? (
        <Icon
          name={icon}
          size={12}
          className={pulse ? 'motion-safe:animate-[bwpulse_1.4s_ease-in-out_infinite]' : undefined}
        />
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
    running: { tone: 'neutral', icon: 'dot', label: 'Testing', pulse: true },
    queued: { tone: 'muted', icon: 'clock', label: 'Queued' },
    'pending gate1': { tone: 'gold', icon: 'clock', label: 'Awaiting your approval' },
    approved: { tone: 'ok', icon: 'check', label: 'Approved' },
    rejected: { tone: 'bad', icon: 'x', label: 'Rejected' },
    completed: { tone: 'ok', icon: 'check', label: 'Completed' },
    failed: { tone: 'bad', icon: 'x', label: 'Failed' },
    cancelled: { tone: 'muted', icon: 'minus', label: 'Cancelled' },
    paused: { tone: 'warn', icon: 'pause', label: 'Paused' },
    killed: { tone: 'kill', icon: 'kill', label: 'Stopped' },
    not_confirmed: { tone: 'bad', icon: 'x', label: 'Not proven' },
    'not confirmed': { tone: 'bad', icon: 'x', label: 'Not proven' },
    confirmed: { tone: 'gold', icon: 'check', label: 'Proven, awaiting your release' },
    validating: { tone: 'slate', icon: 'clock', label: 'Proving' },
    suspected: { tone: 'muted', icon: 'info', label: 'Kept back' },
    released: { tone: 'ok', icon: 'check', label: 'Released' },
    dismissed: { tone: 'muted', icon: 'minus', label: 'Dismissed' },
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
    <span className="inline-flex items-center rounded-md border border-border bg-surface px-2 py-0.5 font-mono text-xs font-medium text-foreground">
      {children}
    </span>
  );
}

/** Gauge and countdown colour: primary under 80 %, warn from 80 %, bad from 100 %. */
export function gaugeTone(pct: number): 'primary' | 'warn' | 'bad' {
  if (pct >= 100) return 'bad';
  return pct >= 80 ? 'warn' : 'primary';
}

const BUTTON_BASE =
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap border text-[13.5px] font-medium no-underline transition-[filter,background-color,border-color,transform] duration-150 active:translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus focus-visible:border-gold-ink disabled:cursor-not-allowed disabled:shadow-none disabled:active:translate-y-0 motion-reduce:transition-none';

/** Disabled buttons go grey; the kill button stays red and fades instead. */
const DISABLED_GREY =
  'disabled:border-border disabled:bg-surface-2 disabled:text-muted-foreground';

/**
 * One primary per screen: `primary` is gold (dark label, inset gold-ink edge: bright gold alone is not a boundary).
 * `deny` is ink, the safe heavy choice. `kill` is the one solid red, for Stop only.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'deny' | 'kill' | 'danger-soft';

const BUTTON: Record<ButtonVariant, string> = {
  // Border colour lives in each variant: a shared border-transparent would beat border-input-strong in the CSS order.
  primary: `border-transparent bg-gold text-on-gold font-semibold shadow-[inset_0_0_0_1px_rgba(138,99,16,.28)] hover:bg-gold-hi ${DISABLED_GREY}`,
  secondary: `border-input-strong bg-card text-foreground hover:bg-surface-2 ${DISABLED_GREY}`,
  ghost: `border-transparent bg-transparent text-muted-foreground hover:bg-surface-2 hover:text-foreground ${DISABLED_GREY}`,
  deny: `border-transparent bg-text text-bg font-semibold hover:brightness-110 focus-visible:shadow-[0_0_0_2px_var(--bg),0_0_0_5px_var(--text)] ${DISABLED_GREY}`,
  kill: 'border-transparent bg-kill text-on-kill font-semibold hover:brightness-110 focus-visible:ring-kill-soft disabled:opacity-40',
  'danger-soft': `border-bad bg-transparent text-bad hover:bg-bad-soft ${DISABLED_GREY}`,
};

/** Button classes, for use on `<button>` or `<Link>`. Disabled state is set with the `disabled` attribute. */
export function buttonClass(variant: ButtonVariant = 'primary', extra = ''): string {
  const defaults = [
    /(^|\s)h-/.test(extra) ? '' : 'h-10',
    /(^|\s)rounded-/.test(extra) ? '' : 'rounded-[10px]',
    /(^|\s)px-/.test(extra) ? '' : 'px-4',
  ];
  return [BUTTON_BASE, BUTTON[variant], ...defaults, extra].join(' ');
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
  const content = (
    <>
      {icon ? <Icon name={icon} size={15} /> : null}
      {children}
    </>
  );
  // Route handlers (report downloads) are not pages: a plain link, so Next never prefetches them.
  return href.startsWith('/api/') ? (
    <a href={href} className={buttonClass(variant, className)}>
      {content}
    </a>
  ) : (
    <Link href={href} className={buttonClass(variant, className)}>
      {content}
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
      className={`overflow-hidden rounded-[14px] border border-border bg-card ${className}`}
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

/** Text input grammar: 44 px, 10 px radius, the input boundary colour, gold focus. Use `aria-invalid` for errors. */
export const INPUT_CLASS =
  'h-11 w-full rounded-[10px] border border-input-strong bg-card px-3.5 text-[14px] text-foreground placeholder:text-muted-foreground focus-visible:border-gold-ink focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus aria-[invalid=true]:border-bad disabled:bg-surface-2 disabled:text-muted-foreground';

export function PageHeader({
  crumbs,
  title,
  chips,
  actions,
}: {
  readonly crumbs: readonly { label: string; href?: string; mono?: boolean }[];
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
                  <span
                    className={
                      c.mono
                        ? 'rounded-md border border-border bg-surface px-2 py-0.5 font-mono text-xs font-medium text-foreground'
                        : undefined
                    }
                  >
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

/** Filter pill: the active one is `bg-text text-bg`. */
export function filterPillClass(active: boolean): string {
  return `inline-flex h-7 items-center rounded-full px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${active ? 'bg-text text-bg' : 'bg-surface-2 text-text'}`;
}

const VERDICT_RING: Record<string, { tone: string; ring: string; label: string }> = {
  confirmed: { tone: 'text-ok', ring: 'border-2 border-current', label: 'Proven' },
  validating: {
    tone: 'text-slate',
    ring: 'border-2 border-current border-t-transparent motion-safe:animate-[bwspin_0.8s_linear_infinite]',
    label: 'Proving',
  },
  suspected: {
    tone: 'text-muted-foreground',
    ring: 'border-2 border-dashed border-current',
    label: 'Kept back',
  },
  released: { tone: 'text-ok', ring: 'border-2 border-current', label: 'Released' },
  dismissed: { tone: 'text-muted-foreground', ring: 'border-2 border-current', label: 'Dismissed' },
};

/** Candidate verdict: a 10 px ring and the word, in one colour. Unknown verdicts render as plain muted text. */
export function VerdictMark({ verdict }: { readonly verdict: string }) {
  const v = VERDICT_RING[verdict.toLowerCase()];
  if (v === undefined)
    return <span className="text-[11.5px] text-muted-foreground">{verdict}</span>;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11.5px] font-medium ${v.tone}`}>
      <span aria-hidden="true" className={`size-2.5 rounded-full ${v.ring}`} />
      {v.label}
    </span>
  );
}

const KIND_TAG: Record<string, string> = {
  http: 'bg-surface-2 text-text',
  tool: 'bg-primary-soft text-primary',
  blocked: 'bg-warn-soft text-warn',
  gate2: 'bg-warn text-white',
  finding: 'bg-high-soft text-high',
  callback: 'bg-ok-soft text-ok',
};

/** Activity feed kind tag (HTTP, Tool, Blocked, Gate 2, Finding, Callback). */
export function KindTag({
  kind,
  children,
}: {
  readonly kind: string;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center rounded-[5px] px-2 text-[11px] font-medium ${KIND_TAG[kind] ?? 'bg-surface-2 text-text'}`}
    >
      {children}
    </span>
  );
}

/** Banner: a warn (decision needed) or kill (run halted) strip, with an optional pinging dot. */
export function Banner({
  tone,
  ping = false,
  children,
  actions,
}: {
  readonly tone: 'warn' | 'kill';
  readonly ping?: boolean;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
}) {
  const colour = tone === 'warn' ? 'border-warn bg-warn-soft' : 'border-kill bg-kill-soft';
  const dot = tone === 'warn' ? 'bg-warn' : 'bg-kill';
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-[13.5px] text-foreground ${colour}`}
    >
      <span aria-hidden="true" className="relative flex size-2.5 shrink-0">
        {ping ? (
          <span
            className={`absolute inset-0 rounded-full ${dot} motion-safe:animate-[bwping_1.6s_ease-out_infinite]`}
          />
        ) : null}
        <span className={`relative size-2.5 rounded-full ${dot}`} />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {actions}
    </div>
  );
}

/** A refusal from the API, passed back on the page as ?error=<code>&message=<detail>. */
export function ErrorBanner({
  error,
  message,
}: {
  readonly error?: string | undefined;
  readonly message?: string | undefined;
}) {
  if (error === undefined) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-bad bg-bad-soft p-4 text-[13.5px] text-bad"
    >
      <Icon name="x" size={18} />
      <span>
        <strong className="font-semibold">{error}</strong>: {message ?? 'The action was refused.'}
      </span>
    </p>
  );
}

export function queryText(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Experience primitives (server-safe). The interactive ones (PendingButton, CopyField, ReasonField, ChipInput,
// Countdown) are in ./design-client, because this file has no hooks.

/** Keyboard hint, e.g. the `N` on New audit or the `D` on Deny. */
export function Kbd({ children, className = '' }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <kbd
      className={`inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-current px-1 font-mono text-[10.5px] font-medium leading-none opacity-60 ${className}`}
    >
      {children}
    </kbd>
  );
}

export type Voice = 'claude' | 'blackwing' | 'validator' | 'you';

const VOICE: Record<Voice, { label: string; className: string }> = {
  claude: { label: 'Claude', className: 'bg-slate-soft text-slate' },
  blackwing: { label: 'Blackwing', className: 'bg-surface-2 text-muted-foreground' },
  validator: { label: 'Blackwing · no model', className: 'bg-ok-soft text-ok' },
  you: { label: 'You', className: 'bg-gold-soft text-gold-ink shadow-[inset_0_0_0_1px_var(--gold-line)]' },
};

/**
 * Who is speaking, never blurred (spec §1): Claude (slate, its own words, not verified), Blackwing (grey, templates over
 * run events), the validator (green, replay, no model) and You (gold, your decisions). `children` overrides the label.
 */
export function VoiceTag({
  voice,
  children,
  title,
}: {
  readonly voice: Voice;
  readonly children?: ReactNode;
  readonly title?: string;
}) {
  const v = VOICE[voice];
  return (
    <span
      title={title ?? (voice === 'claude' ? "Claude's own words, not verified" : undefined)}
      className={`inline-flex h-[18px] shrink-0 items-center rounded-full px-[7px] text-[10.5px] font-semibold ${v.className}`}
    >
      {children ?? v.label}
    </span>
  );
}

/**
 * A whole-card choice: the `<label>` wraps the radio or checkbox, so a click anywhere selects it (bug: lost clicks).
 * Selected cards are gold-soft with a gold-ink edge. `index` shows the number key (1 to 9) the page binds.
 * `children` is shown under the card text only while the card is selected (e.g. the verification steps).
 */
export function OptionCard({
  type = 'radio',
  name,
  value,
  checked,
  onChange,
  title,
  description,
  badge,
  index,
  disabled = false,
  children,
}: {
  readonly type?: 'radio' | 'checkbox';
  readonly name: string;
  readonly value: string;
  readonly checked: boolean;
  readonly onChange: (value: string, checked: boolean) => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly badge?: ReactNode;
  readonly index?: number;
  readonly disabled?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <label
      className={`group relative flex min-h-16 cursor-pointer gap-3 rounded-[14px] border p-4 transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-focus ${checked ? 'border-gold-ink bg-gold-soft' : 'border-border bg-card hover:border-border-strong hover:bg-surface-2'} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <input
        type={type}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          onChange(value, e.target.checked);
        }}
        className="mt-0.5 size-[18px] shrink-0 accent-[var(--gold-ink)] focus-visible:outline-none"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[14.5px] font-semibold leading-5 text-foreground">{title}</span>
          {badge}
        </span>
        {description === undefined ? null : (
          <span className="text-[13px] leading-5 text-muted-foreground">{description}</span>
        )}
        {checked && children !== undefined ? <span className="mt-2 flex flex-col gap-2">{children}</span> : null}
      </span>
      {index === undefined ? null : <Kbd className="text-muted-foreground">{index}</Kbd>}
    </label>
  );
}

/** Every empty state is designed (spec §8): a title, one line of why, and at most one way forward. */
export function EmptyState({
  icon = 'info',
  title,
  body,
  action,
  className = '',
}: {
  readonly icon?: IconName;
  readonly title: ReactNode;
  readonly body?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-start gap-3 rounded-[14px] border border-dashed border-border-strong bg-card px-5 py-6 ${className}`}
    >
      <span className="flex size-9 items-center justify-center rounded-[10px] bg-gold-soft text-gold-ink">
        <Icon name={icon} size={18} />
      </span>
      <div className="flex flex-col gap-1">
        <p className="m-0 text-[14.5px] font-semibold text-foreground">{title}</p>
        {body === undefined ? null : <p className="m-0 max-w-prose text-[13px] leading-5 text-muted-foreground">{body}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * A decision, collapsed (spec §6): "Approved by Jatin, 14:02: "Our lab"" then "Recorded in the ledger · 3f2a9c".
 * `hash` is the ledger event hash (shown short).
 */
export function Receipt({
  tone = 'ok',
  title,
  detail,
  hash,
  className = '',
}: {
  readonly tone?: 'ok' | 'bad' | 'muted' | 'gold';
  readonly title: ReactNode;
  readonly detail?: ReactNode;
  readonly hash?: string | null;
  readonly className?: string;
}) {
  const t = {
    ok: { icon: 'check' as const, mark: 'bg-ok text-white', box: 'border-border bg-card' },
    bad: { icon: 'x' as const, mark: 'bg-text text-bg', box: 'border-border bg-card' },
    muted: { icon: 'minus' as const, mark: 'bg-surface-2 text-muted-foreground', box: 'border-border bg-card' },
    gold: { icon: 'check' as const, mark: 'bg-gold text-on-gold', box: 'border-gold-line bg-gold-soft' },
  }[tone];
  return (
    <div role="status" className={`flex items-start gap-3 rounded-[14px] border px-4 py-3 ${t.box} ${className}`}>
      <span className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${t.mark}`}>
        <Icon name={t.icon} size={12} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13.5px] font-medium leading-5 text-foreground">{title}</span>
        {detail === undefined ? null : <span className="text-[12.5px] leading-5 text-muted-foreground">{detail}</span>}
        <span className="text-[11.5px] text-muted-foreground">
          Recorded in the ledger
          {hash === undefined || hash === null ? null : (
            <>
              {' · '}
              <span className="font-mono">{hash.slice(0, 8)}</span>
            </>
          )}
        </span>
      </span>
    </div>
  );
}

/** An inline line under a field: what we understood (`ok`), what to fix (`bad`) or a neutral note. */
export function InlineMessage({
  tone = 'muted',
  children,
  id,
}: {
  readonly tone?: 'ok' | 'bad' | 'muted' | 'gold';
  readonly children: ReactNode;
  readonly id?: string;
}) {
  const t = {
    ok: { icon: 'check' as const, cls: 'text-ok' },
    bad: { icon: 'warn' as const, cls: 'text-bad' },
    muted: { icon: 'info' as const, cls: 'text-muted-foreground' },
    gold: { icon: 'info' as const, cls: 'text-gold-ink' },
  }[tone];
  return (
    <p
      id={id}
      role={tone === 'bad' ? 'alert' : undefined}
      className={`m-0 flex items-start gap-2 text-[12.5px] leading-[19px] ${t.cls}`}
    >
      <Icon name={t.icon} size={14} className="mt-[2px]" />
      <span className={tone === 'bad' ? '' : 'text-muted-foreground [&_b]:font-medium [&_b]:text-foreground'}>
        {children}
      </span>
    </p>
  );
}

/** A placeholder block for loading states. It fades in after 300 ms, so quick loads never flash it. */
export function Skeleton({ className = '' }: { readonly className?: string }) {
  return (
    <div aria-hidden="true" className={`bw-delayed ${className}`}>
      <div className="size-full rounded-[10px] bg-surface-2 motion-safe:animate-[bwpulse_1.4s_ease-in-out_infinite]" />
    </div>
  );
}
