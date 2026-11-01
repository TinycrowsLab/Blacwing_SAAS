import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { evalTargetSchema } from './eval-target.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TARGETS_DIR = path.join(REPO_ROOT, 'eval/targets');

/** Every `target.json` under eval/targets (the public targets and the synthetic labs under synthetic/). */
function manifestFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (!statSync(full).isDirectory()) return [];
    const manifest = path.join(full, 'target.json');
    try {
      statSync(manifest);
      return [manifest];
    } catch {
      return manifestFiles(full);
    }
  });
}

const PUBLIC = ['juice-shop', 'crapi', 'vampi', 'dvga', 'dvwa', 'webgoat'];
const SYNTHETIC = ['bola-api', 'ssrf-lab'];

/** A committed manifest by its directory under eval/targets (for example `juice-shop` or `synthetic/bola-api`). */
const loadManifest = (dir: string): unknown =>
  JSON.parse(readFileSync(path.join(TARGETS_DIR, dir, 'target.json'), 'utf8'));
const dirOf = (name: string): string => (SYNTHETIC.includes(name) ? `synthetic/${name}` : name);

describe('eval target manifests (EVAL-001)', () => {
  it('every target.json under eval/targets validates against the schema', () => {
    const files = manifestFiles(TARGETS_DIR);
    expect(files.length).toBe(PUBLIC.length + SYNTHETIC.length);
    for (const file of files) {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const result = evalTargetSchema.safeParse(raw);
      expect(result.success, `${file}: ${result.error?.message ?? ''}`).toBe(true);
    }
  });

  it('covers every public target and both synthetic labs by name', () => {
    for (const name of PUBLIC)
      expect(loadManifest(dirOf(name))).toMatchObject({ name, synthetic: false });
    for (const name of SYNTHETIC)
      expect(loadManifest(dirOf(name))).toMatchObject({ name, synthetic: true });
  });

  it('pins every registry image by sha256 digest', () => {
    for (const name of PUBLIC) {
      const manifest = evalTargetSchema.parse(loadManifest(dirOf(name)));
      expect(manifest.source).toMatchObject({ kind: 'registry' });
      expect(manifest.source.kind === 'registry' && manifest.source.image).toMatch(
        /@sha256:[0-9a-f]{64}$/,
      );
    }
  });

  it('keeps grey-box as the primary mode for every target', () => {
    for (const name of [...PUBLIC, ...SYNTHETIC]) {
      const manifest = evalTargetSchema.parse(loadManifest(dirOf(name)));
      expect(manifest.primaryMode).toBe('grey_box');
    }
  });

  it('keeps every target licence eval-only (never redistributed)', () => {
    for (const name of PUBLIC) {
      expect(evalTargetSchema.parse(loadManifest(dirOf(name))).licence.redistributed).toBe(false);
    }
  });
});

describe('evalTargetSchema rejects unsafe or malformed manifests', () => {
  const valid = (): Record<string, unknown> =>
    structuredClone(loadManifest('juice-shop')) as Record<string, unknown>;

  it('accepts the committed Juice Shop manifest as a baseline', () => {
    expect(evalTargetSchema.safeParse(valid()).success).toBe(true);
  });

  it.each([
    [
      'a bare image tag (no digest)',
      (m: Record<string, unknown>) => {
        m.source = { kind: 'registry', image: 'bkimminich/juice-shop:v17.1.1' };
      },
    ],
    [
      'a digest that is not sha256 hex',
      (m: Record<string, unknown>) => {
        m.source = { kind: 'registry', image: 'bkimminich/juice-shop@sha256:xyz' };
      },
    ],
    [
      'a non-loopback base URL',
      (m: Record<string, unknown>) => {
        m.baseUrl = 'http://10.0.0.5:13000';
      },
    ],
    [
      'a base URL on the metadata address',
      (m: Record<string, unknown>) => {
        m.baseUrl = 'http://169.254.169.254/latest';
      },
    ],
    [
      'a plaintext password field (secrets never in manifests, §8.7)',
      (m: Record<string, unknown>) => {
        m.credentials = [
          {
            role: 'admin',
            username: 'admin',
            password: 'hunter2',
            secretRef: 'openbao://secret/data/eval/targets/juice-shop/admin',
          },
        ];
      },
    ],
    [
      'a secret reference outside OpenBao KV v2',
      (m: Record<string, unknown>) => {
        m.credentials = [{ role: 'admin', username: 'admin', secretRef: 'file:///etc/shadow' }];
      },
    ],
    [
      'duplicate credential roles',
      (m: Record<string, unknown>) => {
        const ref = 'openbao://secret/data/eval/targets/juice-shop/admin';
        m.credentials = [
          { role: 'admin', username: 'a', secretRef: ref },
          { role: 'admin', username: 'b', secretRef: ref },
        ];
      },
    ],
    [
      'a primary mode that is not in modes',
      (m: Record<string, unknown>) => {
        m.modes = ['black_box'];
        m.primaryMode = 'grey_box';
      },
    ],
    [
      'a spec path that escapes the target directory',
      (m: Record<string, unknown>) => {
        m.specs = [{ kind: 'openapi', path: '../../../etc/passwd' }];
      },
    ],
    [
      'an absolute spec path',
      (m: Record<string, unknown>) => {
        m.specs = [{ kind: 'openapi', path: '/etc/passwd' }];
      },
    ],
    [
      'a ground-truth file that does not match the name',
      (m: Record<string, unknown>) => {
        m.groundTruth = 'eval/ground-truth/other.json';
      },
    ],
    [
      'a redistributable licence',
      (m: Record<string, unknown>) => {
        m.licence = { ...(m.licence as object), redistributed: true };
      },
    ],
    [
      'an unknown top-level key (strict object)',
      (m: Record<string, unknown>) => {
        m.extra = true;
      },
    ],
    [
      'a synthetic flag that disagrees with the source kind',
      (m: Record<string, unknown>) => {
        m.synthetic = true;
      },
    ],
    [
      'an unknown asset type',
      (m: Record<string, unknown>) => {
        m.assetType = 'database';
      },
    ],
    [
      'an unsupported schema version',
      (m: Record<string, unknown>) => {
        m.schemaVersion = 2;
      },
    ],
    [
      'a Dockerfile outside eval/targets',
      (m: Record<string, unknown>) => {
        m.source = {
          kind: 'local',
          dockerfile: 'infra/docker/Dockerfile',
          baseImage: 'node:22.23.3-alpine@sha256:' + 'a'.repeat(64),
        };
        m.synthetic = true;
      },
    ],
    [
      'a port outside the TCP range',
      (m: Record<string, unknown>) => {
        m.port = 70000;
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const manifest = valid();
    mutate(manifest);
    expect(evalTargetSchema.safeParse(manifest).success).toBe(false);
  });
});
