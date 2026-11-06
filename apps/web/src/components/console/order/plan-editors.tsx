'use client';

// The editors behind each underlined value of the plan (experience spec §3.3 optional details, §10.2, §10.3). Every
// input is forgiving: paths become prefix chips, limits are clamped with a note, a pasted header splits itself.
import { useId, useState } from 'react';

import { FocusPicker } from './focus-picker';
import { CARE, type Care, composeObjective, readObjective } from './shared';
import {
  bearerize,
  headerNameError,
  normalizePaths,
  parseCost,
  parseMinutes,
  parseRequests,
  type Range,
  slugifyRole,
  splitHeaderPaste,
} from '../../../lib/normalize';
import { usd } from '../../../lib/plan-text';
import { buttonClass, Icon, INPUT_CLASS, InlineMessage, OptionCard } from '../design';
import { ChipInput } from '../design-client';

import type { AccountValue } from './secrets';
import type { Workspace } from '../../../lib/schemas';

export function ObjectiveEditor({ value, onChange }: { readonly value: string; readonly onChange: (v: string) => void }) {
  const [state, setState] = useState(() => readObjective(value));
  return (
    <FocusPicker
      keys={state.keys}
      onKeys={(keys) => {
        setState({ ...state, keys });
        onChange(composeObjective(keys, state.text));
      }}
      text={state.text}
      onText={(text) => {
        setState({ ...state, text });
        onChange(composeObjective(state.keys, text));
      }}
    />
  );
}

export function CareEditor({ value, onChange }: { readonly value: Care; readonly onChange: (v: Care) => void }) {
  return (
    <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
      <legend className="sr-only">How careful</legend>
      {(['passive', 'active_safe'] as const).map((c) => (
        <OptionCard
          key={c}
          name="plan-care"
          value={c}
          checked={value === c}
          onChange={() => {
            onChange(c);
          }}
          title={CARE[c].label}
          description={CARE[c].line}
        />
      ))}
      <p className="m-0 text-[12.5px] text-muted-foreground">
        Either way, anything that would change data waits for your yes, and destructive requests are never sent.
      </p>
    </fieldset>
  );
}

export function PathsEditor({
  value,
  onChange,
  origin,
  locked,
  onText,
}: {
  readonly value: readonly string[];
  readonly onChange: (v: readonly string[]) => void;
  readonly origin: string | null;
  readonly locked: readonly string[];
  /** The typed text not yet turned into a chip (the plan's Update includes it). */
  readonly onText: (text: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <ChipInput
        label={<span className="sr-only">Paths to avoid</span>}
        values={value}
        onChange={onChange}
        parse={(text, existing) => {
          const r = normalizePaths(text, origin, existing);
          return { values: r.paths, error: r.error };
        }}
        placeholder="/admin, /billing, or a full link on this site"
        locked={locked}
        describe={(v) => (v === '/' ? 'the whole site' : `${v} and everything under it`)}
        onText={onText}
      />
      <p className="m-0 text-[12.5px] text-muted-foreground">
        A path keeps Claude out of it and everything under it. Spaces, commas and new lines separate paths, so paste a
        whole list (write a space inside a path as <code className="font-mono">%20</code>).
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Signed-in testing

export interface AccountRow {
  readonly role: string;
  readonly headerName: string;
  readonly headerValue: string;
  readonly note?: string | null;
}

export const MAX_ACCOUNTS = 3;
const EMPTY_ROW: AccountRow = { role: '', headerName: 'Authorization', headerValue: '' };

/** The rows as the API takes them, or the one thing to fix. */
export function checkAccounts(rows: readonly AccountRow[]): { accounts: AccountValue[] } | { error: string } {
  const accounts: AccountValue[] = [];
  for (const [i, r] of rows.entries()) {
    const n = rows.length > 1 ? ` (account ${i + 1})` : '';
    const role = slugifyRole(r.role);
    if (role === null) return { error: `Give each account a role name, like customer or admin${n}.` };
    const headerError = headerNameError(r.headerName.trim());
    if (headerError !== null) return { error: `${headerError}${n}` };
    if (r.headerValue.trim() === '') return { error: `Paste the header value${n}.` };
    accounts.push({ role, headerName: r.headerName.trim(), headerValue: r.headerValue.trim() });
  }
  if (new Set(accounts.map((a) => a.role)).size !== accounts.length) return { error: 'Each role needs its own name.' };
  return { accounts };
}

/** "Authorization: Bearer x" pasted anywhere splits into header and value; a bare JWT gets "Bearer ". */
function settle(row: AccountRow, field: 'headerName' | 'headerValue', text: string): AccountRow {
  const split = splitHeaderPaste(text);
  if (split !== null && (field === 'headerValue' || /:\s*\S/.test(text))) {
    const b = bearerize(split.header, split.value);
    return { ...row, headerName: split.header, headerValue: b.value, note: b.note ?? `Split into ${split.header} and its value.` };
  }
  if (field === 'headerName') return { ...row, headerName: text, note: null };
  const b = bearerize(row.headerName, text);
  // The "Added Bearer" note stays while the value still starts with the Bearer we added.
  const kept = row.note !== undefined && row.note !== null && /^Bearer\s/.test(row.headerValue) && /^Bearer\s/.test(text);
  return { ...row, headerValue: b.value, note: b.note ?? (kept ? (row.note ?? null) : null) };
}

export function AccountsEditor({
  rows,
  onRows,
  missingValues,
}: {
  readonly rows: readonly AccountRow[];
  readonly onRows: (rows: readonly AccountRow[]) => void;
  /** The plan has accounts whose values this tab does not know (after a reload). */
  readonly missingValues: boolean;
}) {
  const id = useId();
  const signedIn = rows.length > 0;
  const set = (i: number, row: AccountRow): void => {
    onRows(rows.map((r, j) => (j === i ? row : r)));
  };
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="m-0 grid gap-2.5 border-0 p-0 sm:grid-cols-2">
        <legend className="sr-only">Signed-in testing</legend>
        <OptionCard
          name="plan-accounts"
          value="visitor"
          checked={!signedIn}
          onChange={() => {
            onRows([]);
          }}
          title="As a visitor"
          description="No sign-in: what anyone on the internet can reach."
        />
        <OptionCard
          name="plan-accounts"
          value="accounts"
          checked={signedIn}
          onChange={() => {
            if (!signedIn) onRows([EMPTY_ROW]);
          }}
          title="With test accounts"
          description="Up to 3 roles, so Claude can check who sees whose data."
        />
      </fieldset>
      {signedIn ? (
        <div className="flex flex-col gap-3">
          {missingValues ? (
            <InlineMessage tone="gold">
              Values are never sent back to the browser. Paste them again to keep these accounts.
            </InlineMessage>
          ) : null}
          {rows.map((r, i) => {
            const slug = slugifyRole(r.role);
            const taken = slug !== null && rows.slice(0, i).some((x) => slugifyRole(x.role) === slug);
            return (
              <div key={i} className="flex flex-col gap-2 rounded-[12px] border border-border p-3">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,1.6fr)_auto]">
                  <label className="flex flex-col gap-1 text-[12px] font-medium text-foreground" htmlFor={`${id}-r${i}`}>
                    Role
                    <input
                      id={`${id}-r${i}`}
                      value={r.role}
                      placeholder="customer"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={taken || undefined}
                      onChange={(e) => {
                        set(i, { ...r, role: e.target.value });
                      }}
                      className={`${INPUT_CLASS} h-10`}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] font-medium text-foreground" htmlFor={`${id}-h${i}`}>
                    Header
                    <input
                      id={`${id}-h${i}`}
                      value={r.headerName}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => {
                        set(i, settle(r, 'headerName', e.target.value));
                      }}
                      className={`${INPUT_CLASS} h-10 font-mono text-[13px]`}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] font-medium text-foreground" htmlFor={`${id}-v${i}`}>
                    Value
                    <input
                      id={`${id}-v${i}`}
                      type="password"
                      value={r.headerValue}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Bearer … or paste the whole header"
                      onChange={(e) => {
                        set(i, settle(r, 'headerValue', e.target.value));
                      }}
                      className={`${INPUT_CLASS} h-10 font-mono text-[13px]`}
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove account ${i + 1}`}
                    onClick={() => {
                      onRows(rows.filter((_, j) => j !== i));
                    }}
                    className={buttonClass('ghost', 'h-10 self-end px-3')}
                  >
                    <Icon name="x" size={15} />
                  </button>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
                  {taken ? (
                    <span className="text-bad">
                      Another account is already <code className="font-mono">{slug}</code>. Give this role its own name.
                    </span>
                  ) : slug !== null && slug !== r.role ? (
                    <span>
                      Saved as <code className="font-mono text-foreground">{slug}</code>
                    </span>
                  ) : null}
                  {r.note === undefined || r.note === null ? null : <span className="text-gold-ink">{r.note}</span>}
                </div>
              </div>
            );
          })}
          {rows.length < MAX_ACCOUNTS ? (
            <button
              type="button"
              onClick={() => {
                onRows([...rows, EMPTY_ROW]);
              }}
              className="inline-flex h-9 items-center gap-1.5 self-start rounded-lg px-2 text-[13px] font-medium text-gold-ink hover:bg-gold-soft focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
            >
              <Icon name="plus" size={14} />
              Add another role
            </button>
          ) : null}
          <p className="m-0 flex items-start gap-2 text-[12.5px] leading-5 text-muted-foreground">
            <Icon name="lock" size={14} className="mt-[3px] shrink-0" />
            Use throwaway accounts. Claude never sees these values; Blackwing adds them to requests itself.
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Limits

export interface LimitValues {
  readonly minutes: number;
  readonly requests: number;
  readonly costUsd: number;
}

type Settings = Workspace['settings'];

const same = (a: LimitValues, b: LimitValues): boolean =>
  a.minutes === b.minutes && a.requests === b.requests && a.costUsd === b.costUsd;

function CustomField({
  label,
  initial,
  parse,
  onValue,
}: {
  readonly label: string;
  readonly initial: string;
  readonly parse: (text: string) => ReturnType<typeof parseMinutes>;
  readonly onValue: (v: number | null) => void;
}) {
  const id = useId();
  const [text, setText] = useState(initial);
  const r = parse(text);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[12px] font-medium text-foreground">
        {label}
      </label>
      <input
        id={id}
        value={text}
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!r.ok || undefined}
        onChange={(e) => {
          setText(e.target.value);
          const next = parse(e.target.value);
          onValue(next.ok ? next.value : null);
        }}
        className={`${INPUT_CLASS} h-10`}
      />
      {r.ok ? (
        r.note === null ? null : <span className="text-[11.5px] leading-4 text-gold-ink">{r.note}</span>
      ) : (
        <span className="text-[11.5px] leading-4 text-bad">{r.message}</span>
      )}
    </div>
  );
}

export function LimitsEditor({
  value,
  onChange,
  settings,
}: {
  readonly value: LimitValues;
  /** Null while a custom value cannot be read yet. */
  readonly onChange: (v: LimitValues | null) => void;
  readonly settings: Settings;
}) {
  const preset = settings.presets.find((p) => same(p, value));
  const [custom, setCustom] = useState(preset === undefined);
  const [parts, setParts] = useState<{ minutes: number | null; requests: number | null; costUsd: number | null }>(value);
  const r = (k: keyof Settings['limits']): Range => settings.limits[k];
  const update = (next: typeof parts): void => {
    setParts(next);
    onChange(
      next.minutes === null || next.requests === null || next.costUsd === null
        ? null
        : { minutes: next.minutes, requests: next.requests, costUsd: next.costUsd },
    );
  };
  return (
    <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
      <legend className="sr-only">Limits</legend>
      <div className="grid gap-2.5 sm:grid-cols-3">
        {settings.presets.map((p) => (
          <OptionCard
            key={p.key}
            name="plan-limits"
            value={p.key}
            checked={!custom && preset?.key === p.key}
            onChange={() => {
              setCustom(false);
              update({ minutes: p.minutes, requests: p.requests, costUsd: p.costUsd });
            }}
            title={p.label}
            description={
              <>
                {p.minutes} min · {p.requests.toLocaleString()} requests
                <br />
                Most it can cost <b className="font-medium text-foreground">{usd(p.costUsd)}</b>
              </>
            }
          />
        ))}
      </div>
      <OptionCard
        name="plan-limits"
        value="custom"
        checked={custom}
        onChange={() => {
          setCustom(true);
        }}
        title="Custom"
        description="Type it the way you think of it: 45m, 1h30, 1.5k, $12."
      />
      {custom ? (
        <div className="rounded-[12px] border border-gold-line bg-gold-soft p-3">
        <div className="grid gap-2.5 sm:grid-cols-3">
          <CustomField
            label="Longest it can run"
            initial={`${value.minutes} min`}
            parse={(t) => parseMinutes(t, r('minutes'))}
            onValue={(v) => {
              update({ ...parts, minutes: v });
            }}
          />
          <CustomField
            label="Most requests"
            initial={value.requests.toLocaleString('en-US')}
            parse={(t) => parseRequests(t, r('requests'))}
            onValue={(v) => {
              update({ ...parts, requests: v });
            }}
          />
          <CustomField
            label="Most it can cost"
            initial={`$${value.costUsd}`}
            parse={(t) => parseCost(t, r('costUsd'))}
            onValue={(v) => {
              update({ ...parts, costUsd: v });
            }}
          />
        </div>
        </div>
      ) : null}
      <p className="m-0 text-[12.5px] text-muted-foreground">Claude stops at the first limit it reaches.</p>
    </fieldset>
  );
}

export function ReleaseEditor({
  value,
  onChange,
}: {
  readonly value: 'hold' | 'auto';
  readonly onChange: (v: 'hold' | 'auto') => void;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
      <legend className="sr-only">Proven issues</legend>
      <OptionCard
        name="plan-release"
        value="hold"
        checked={value === 'hold'}
        onChange={() => {
          onChange('hold');
        }}
        title="Wait for my release"
        description="Nothing reaches the report until you release it."
      />
      <OptionCard
        name="plan-release"
        value="auto"
        checked={value === 'auto'}
        onChange={() => {
          onChange('auto');
        }}
        title="Release proven issues automatically"
        description="Only issues the validator proved. You can still dismiss them."
      />
    </fieldset>
  );
}
