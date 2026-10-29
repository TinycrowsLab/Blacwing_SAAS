import { naturalKey, type SurfaceEdgeKind, type SurfaceNode } from '@blackwing/contracts';

import { createSurfaceMetrics } from './metrics.js';
import { createCursorCodec } from '../pagination/cursor.js';

import type { SurfaceGraphReader, SurfacePrincipal, SurfaceRunRecord } from './ports.js';
import type { AuditEventInput } from '@blackwing/audit';
import type { RunSurface, RunSurfaceQuery } from '@blackwing/memory';

export const TENANT = '018f2a6e-1c00-7000-8000-00000000000a';
export const OTHER_TENANT = '018f2a6e-1c00-7000-8000-00000000000b';
export const RUN = '018f2a6e-1c01-7000-8000-000000000001';
export const USER = '018f2a6e-1c03-7000-8000-000000000001';
export const OTHER_USER = '018f2a6e-1c03-7000-8000-000000000002';
const CURSOR_SECRET_LENGTH = 40;
const CURSOR_SECRET = 'x'.repeat(CURSOR_SECRET_LENGTH);

const PROVENANCE = {
  runId: RUN,
  tool: 'nmap',
  confidence: 0.9,
  firstSeenAt: '2026-10-29T10:00:00.000Z',
  lastSeenAt: '2026-10-29T10:05:00.000Z',
};

export function principal(
  roles: readonly string[] = ['appsec_engineer'],
  overrides: Partial<SurfacePrincipal> = {},
): SurfacePrincipal {
  return { type: 'user', id: USER, tenantId: TENANT, roles, ...overrides };
}

export function runRecord(overrides: Partial<SurfaceRunRecord> = {}): SurfaceRunRecord {
  return { id: RUN, tenantId: TENANT, state: 'recon', ownerUserIds: [USER], ...overrides };
}

export function host(hostname: string, confidence = 0.9): SurfaceNode {
  return {
    kind: 'host',
    tenantId: TENANT,
    provenance: { ...PROVENANCE, confidence },
    hostname,
    inScope: true,
  };
}

export function service(hostname: string, port: number): SurfaceNode {
  return {
    kind: 'service',
    tenantId: TENANT,
    provenance: PROVENANCE,
    hostname,
    port,
    protocol: 'tcp',
  };
}

export function key(node: SurfaceNode): string {
  return naturalKey(node);
}

/** A graph reader that records every call and answers with a fixed surface (or one built per query). */
export class FakeGraph implements SurfaceGraphReader {
  readonly calls: { tenantId: string; runId: string; query: RunSurfaceQuery }[] = [];
  #answer: RunSurface | ((query: RunSurfaceQuery) => RunSurface);

  constructor(answer: RunSurface | ((query: RunSurfaceQuery) => RunSurface)) {
    this.#answer = answer;
  }

  readRunSurface(tenantId: string, runId: string, query: RunSurfaceQuery): Promise<RunSurface> {
    this.calls.push({ tenantId, runId, query });
    return Promise.resolve(typeof this.#answer === 'function' ? this.#answer(query) : this.#answer);
  }
}

export function surfaceOf(
  nodes: { node: SurfaceNode; degree: number }[],
  overrides: Partial<RunSurface> & {
    edges?: { kind: SurfaceEdgeKind; fromKey: string; toKey: string }[];
  } = {},
): RunSurface {
  return {
    totals: { nodes: nodes.length, edges: overrides.edges?.length ?? 0 },
    nodes,
    edges: [],
    edgesTruncated: false,
    ...overrides,
  };
}

export function auditRecorder(): {
  events: AuditEventInput[];
  write: (e: AuditEventInput) => Promise<void>;
} {
  const events: AuditEventInput[] = [];
  return {
    events,
    write: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
}

export function cursors() {
  return createCursorCodec(CURSOR_SECRET);
}

export function metrics() {
  return createSurfaceMetrics();
}
