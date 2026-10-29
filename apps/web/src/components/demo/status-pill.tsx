// DEMO-STORY: a status label with a text value (never colour alone, for accessibility).
const TONE: Record<string, string> = {
  pending_gate1: 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-50',
  approved: 'bg-sky-100 text-sky-900 dark:bg-sky-900 dark:text-sky-50',
  rejected: 'bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-50',
  running: 'bg-sky-100 text-sky-900 dark:bg-sky-900 dark:text-sky-50',
  queued: 'bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-50',
  completed: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-50',
  failed: 'bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-50',
  confirmed: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-50',
  verified: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-50',
};

export function StatusPill({ value }: { readonly value: string }) {
  const tone = TONE[value] ?? 'bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-50';
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${tone}`}>{value.replace(/_/g, ' ')}</span>;
}
