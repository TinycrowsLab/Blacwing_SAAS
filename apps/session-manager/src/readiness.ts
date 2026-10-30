/**
 * Readiness: `/readyz` is 200 only while the config is valid and every dependency (driver, Valkey) has
 * answered its latest probe. A failing dependency is retried with exponential backoff; a healthy one is
 * re-probed periodically, so a later outage flips readiness back to 503 (fail closed).
 */

export interface DependencyProbe {
  readonly name: string;
  /** Resolves when reachable. A rejection or a timeout marks the dependency down. */
  check(): Promise<void>;
}

export interface ReadinessOptions {
  readonly probes: readonly DependencyProbe[];
  /** First retry delay after a failure; doubles up to `maxBackoffMs`. */
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Re-probe interval while healthy. */
  readonly recheckMs?: number;
  /** Per-probe timeout. */
  readonly probeTimeoutMs?: number;
  readonly onChange?: (ready: boolean, state: Readonly<Record<string, boolean>>) => void;
  readonly onProbeFailure?: (name: string, attempt: number, nextDelayMs: number) => void;
}

export interface ReadinessMonitor {
  isReady(): boolean;
  state(): Readonly<Record<string, boolean>>;
  /** Starts the probe loops (idempotent). */
  start(): void;
  /** Runs every probe once now and resolves with the resulting readiness. */
  checkNow(): Promise<boolean>;
  /** Marks the process not ready (used while draining) and stops probing. */
  stop(): void;
}

const DEFAULT_INITIAL_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_RECHECK_MS = 5000;
const DEFAULT_PROBE_TIMEOUT_MS = 2000;

async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, rejectTimeout) => {
    timer = setTimeout(() => {
      rejectTimeout(new Error('probe timed out'));
    }, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createReadinessMonitor(options: ReadinessOptions): ReadinessMonitor {
  const initial = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const max = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const recheck = options.recheckMs ?? DEFAULT_RECHECK_MS;
  const probeTimeout = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const up = new Map<string, boolean>(options.probes.map((p) => [p.name, false]));
  const failures = new Map<string, number>();
  const timers = new Set<NodeJS.Timeout>();
  let started = false;
  let stopped = false;
  let lastReady = false;

  const snapshot = (): Readonly<Record<string, boolean>> => Object.freeze(Object.fromEntries(up));
  const computeReady = (): boolean => !stopped && [...up.values()].every(Boolean);

  const publish = (): void => {
    const ready = computeReady();
    if (ready !== lastReady) {
      lastReady = ready;
      options.onChange?.(ready, snapshot());
    }
  };

  /** Probes once; returns the delay before the next probe of this dependency. */
  const probeOnce = async (probe: DependencyProbe): Promise<number> => {
    try {
      await withTimeout(probe.check(), probeTimeout);
      up.set(probe.name, true);
      failures.set(probe.name, 0);
      publish();
      return recheck;
    } catch {
      const attempt = (failures.get(probe.name) ?? 0) + 1;
      failures.set(probe.name, attempt);
      up.set(probe.name, false);
      publish();
      const delay = Math.min(max, initial * 2 ** (attempt - 1));
      options.onProbeFailure?.(probe.name, attempt, delay);
      return delay;
    }
  };

  const loop = (probe: DependencyProbe): void => {
    if (stopped) return;
    void probeOnce(probe).then((delay) => {
      if (stopped) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        loop(probe);
      }, delay);
      timer.unref();
      timers.add(timer);
    });
  };

  return {
    isReady: computeReady,
    state: snapshot,
    start() {
      if (started || stopped) return;
      started = true;
      for (const probe of options.probes) loop(probe);
    },
    async checkNow() {
      await Promise.all(options.probes.map((probe) => probeOnce(probe)));
      return computeReady();
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      publish();
    },
  };
}
