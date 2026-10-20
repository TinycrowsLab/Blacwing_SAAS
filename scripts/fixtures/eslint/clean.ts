// Lint fixture: idiomatic code that must produce no lint messages at all. It exercises the same
// constructs the failing fixtures get wrong, done right.
import { readFile } from 'node:fs/promises';

import type { Stats } from 'node:fs';

const RETRY_LIMIT = 3;

export interface Settings {
  readonly name: string;
  readonly retries: number;
}

export function retriesLeft(settings: Settings, used: number): number {
  return Math.max(RETRY_LIMIT, settings.retries) - used;
}

export function firstName(names: readonly string[]): string | undefined {
  return names[0];
}

export async function readSettings(file: string): Promise<Settings> {
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'name' in raw &&
    typeof raw.name === 'string' &&
    'retries' in raw &&
    typeof raw.retries === 'number'
  ) {
    return { name: raw.name, retries: raw.retries };
  }
  throw new TypeError(`invalid settings in ${file}`);
}

export function isFile(stats: Stats): boolean {
  return stats.isFile();
}
