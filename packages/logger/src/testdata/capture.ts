// Test helper: a pino destination that keeps every written line in memory.
import type { DestinationStream } from 'pino';

export type LogRecord = Readonly<Record<string, unknown>>;

export interface Capture {
  /** Pass as `createLogger(name, { destination })`. */
  readonly destination: DestinationStream & { flushSync(): void };
  /** Raw lines, exactly as pino wrote them (each ends with a newline). */
  readonly lines: string[];
  /** How many times `flushSync` was called. */
  readonly flushes: () => number;
  /** Every line parsed as JSON (throws if any line is not valid JSON). */
  readonly records: () => LogRecord[];
  /** The last line parsed as JSON. */
  readonly last: () => LogRecord;
  /** All output as one string. */
  readonly text: () => string;
}

export function capture(): Capture {
  const lines: string[] = [];
  let flushes = 0;
  const records = (): LogRecord[] => lines.map((line) => JSON.parse(line) as LogRecord);
  return {
    destination: {
      write(line: string): void {
        lines.push(line);
      },
      flushSync(): void {
        flushes += 1;
      },
    },
    lines,
    flushes: () => flushes,
    records,
    last: () => {
      const all = records();
      const record = all[all.length - 1];
      if (record === undefined) throw new Error('no log line was written');
      return record;
    },
    text: () => lines.join(''),
  };
}
