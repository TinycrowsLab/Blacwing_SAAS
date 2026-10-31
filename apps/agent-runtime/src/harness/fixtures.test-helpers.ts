import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { vi, type Mock } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createRuntimeMetrics, type RuntimeMetrics } from '../metrics.js';

import type { HarnessScaffoldDeps, HarnessScaffoldedEvent } from './scaffold.js';
import type { PocHarnessManifest } from '@blackwing/contracts';

/** Test fixtures for the PoC-harness scaffold. Benign local lab targets only (CONTEXT_PACK §10, CLAUDE.md). */

export const ASSET_ID = '018f3b2a-7c1d-7a00-8000-000000000001';
const MANIFEST_ID = '018f3b2a-7c1d-7a00-8000-000000000002';
export const CANDIDATE_ID = '018f3b2a-7c1d-7a00-8000-000000000003';
export const OTHER_CANDIDATE_ID = '018f3b2a-7c1d-7a00-8000-000000000004';
export const SESSION_ID = 'sess-harness-1';
const ORDER_URL = 'http://app.example.test/orders/{id}';

const endpoint = { assetId: ASSET_ID, urlTemplate: ORDER_URL };
const HEX_SHA256_LENGTH = 64;
const DIGEST_FILL = 'b'.repeat(HEX_SHA256_LENGTH);

/** A valid active_safe manifest that names one captured input (`inputs/order-id.json`). */
export function validManifest(candidateId: string = CANDIDATE_ID): PocHarnessManifest {
  return {
    id: MANIFEST_ID,
    candidateId,
    intrusivenessClass: 'active_safe',
    reversalRef: null,
    targets: [endpoint],
    steps: [
      {
        kind: 'http_request',
        ref: 'fetch-order',
        params: { method: 'GET', endpoint, roleKey: 'viewer', inputRef: 'inputs/order-id.json' },
      },
      { kind: 'oob_check', ref: 'await-callback', params: { channel: 'dns', windowMs: 30_000 } },
    ],
    expectedObservation: { type: 'oob', fired: true, evidenceRefs: ['evidence/oob-1'] },
    negativeControl: [
      {
        kind: 'http_request',
        ref: 'fetch-order-benign',
        params: { method: 'GET', endpoint, roleKey: 'owner', inputRef: 'inputs/order-id.json' },
      },
    ],
    inputsRef: ['inputs/order-id.json'],
    toolchain: [{ name: 'curl', version: '8.5.0', imageDigestRef: `sha256:${DIGEST_FILL}` }],
    env: { TARGET_LABEL: 'juice-shop-local' },
  };
}

export interface ScaffoldFixture {
  readonly workspaceDir: string;
  readonly orderIdPath: string;
  readonly audit: Mock<(event: HarnessScaffoldedEvent) => Promise<void>>;
  readonly metrics: RuntimeMetrics;
  readonly deps: HarnessScaffoldDeps;
}

/**
 * Builds a workspace and a source directory with a captured text input. The caller sets `workspaceDir` and
 * `sourceDir` to fresh temp paths, so tests never share state.
 */
export async function createScaffoldFixture(
  workspaceDir: string,
  sourceDir: string,
): Promise<ScaffoldFixture> {
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(join(sourceDir, 'captured'), { recursive: true });
  const orderIdPath = join(sourceDir, 'captured', 'order-id.json');
  await writeFile(orderIdPath, '42\n');
  const audit = vi.fn<(event: HarnessScaffoldedEvent) => Promise<void>>(() => Promise.resolve());
  const metrics = createRuntimeMetrics();
  const deps: HarnessScaffoldDeps = {
    workspaceDir,
    resolveInput: (ref) =>
      Promise.resolve(ref === 'inputs/order-id.json' ? { path: orderIdPath } : null),
    audit,
    metrics,
    log: createLogger('agent-runtime-test', { destination: { write: () => undefined } }),
  };
  return { workspaceDir, orderIdPath, audit, metrics, deps };
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
