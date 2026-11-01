// Reads the eval target manifests (EVAL-001) for the eval tenant seed. Each `eval/targets/**/target.json` is
// validated with the shared schema (`@blackwing/contracts`), so a malformed manifest fails the seed loudly.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evalTargetSchema } from '@blackwing/contracts';

import type { EvalSeedTarget } from './eval-plan.js';

/** The repository's `eval/targets` directory, resolved from this file (packages/db/src/seed). */
export const EVAL_TARGETS_DIR = fileURLToPath(new URL('../../../../eval/targets', import.meta.url));

/** Every `target.json` under `dir`, depth first and sorted, so the seed order is stable. */
function manifestFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const full = path.join(dir, entry);
      if (!statSync(full).isDirectory()) return [];
      const manifest = path.join(full, 'target.json');
      return existsSync(manifest) ? [manifest] : manifestFiles(full);
    });
}

/**
 * Loads and validates every eval target manifest. Throws when a manifest fails the schema or two manifests share
 * a name (the eval tenant keys its assets by name).
 */
export function loadEvalSeedTargets(dir: string = EVAL_TARGETS_DIR): EvalSeedTarget[] {
  const targets = manifestFiles(dir).map((file) => {
    const manifest = evalTargetSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    return {
      name: manifest.name,
      title: manifest.title,
      assetType: manifest.assetType,
      service: manifest.service,
      port: manifest.port,
    };
  });
  const names = targets.map((target) => target.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`eval targets: duplicate target names in ${dir}`);
  }
  return targets;
}
