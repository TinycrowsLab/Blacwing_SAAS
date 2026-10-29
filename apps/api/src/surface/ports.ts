import type { AuditEventInput } from '@blackwing/audit';
import type { RunState } from '@blackwing/contracts';
import type { RunSurface, RunSurfaceQuery } from '@blackwing/memory';

/**
 * The ports the surface view composes (GRAPH-006). The run store, the graph reader, the Cedar engine and the audit
 * writer are supplied by the composition root; the service never reaches past these interfaces.
 */

/** The authenticated caller. Authentication (token validity, revocation) happens before the handler. */
export interface SurfacePrincipal {
  readonly type: 'user' | 'service';
  /** User id (or service-account id): the actor recorded on the audit event and the Cedar principal. */
  readonly id: string;
  /** The caller's tenant. Absent means no tenant context: the view fails closed. */
  readonly tenantId: string | null;
  readonly roles: readonly string[];
  readonly tokenId?: string;
}

/** A run as the view needs it: its state, and the users who own its asset (for the asset-ownership rule). */
export interface SurfaceRunRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly state: RunState;
  readonly ownerUserIds: readonly string[];
}

/** Reads a run inside one tenant. `null` for a run that does not exist there (never another tenant's row). */
export interface SurfaceRunReader {
  getRun(tenantId: string, runId: string): Promise<SurfaceRunRecord | null>;
}

/** Reads one page of a run's surface inside one tenant, in one snapshot (the GRAPH-004 repository, in production). */
export interface SurfaceGraphReader {
  readRunSurface(tenantId: string, runId: string, query: RunSurfaceQuery): Promise<RunSurface>;
}

/** Appends one audit event (`run.surface.viewed`). The composition root binds it to `AuditEmitter.emitAudit`. */
export type SurfaceAuditWriter = (event: AuditEventInput) => Promise<void>;
