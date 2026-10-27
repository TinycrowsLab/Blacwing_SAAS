import type { RunState } from '@blackwing/contracts';
import type { EventBus } from '@blackwing/events';

/**
 * The ports the run event stream composes (#65). The bus adapter is the Valkey event bus of
 * `@blackwing/events`, and the run reader is the tenant-scoped run store; both are wired by the process
 * entry point, so the transport never reaches past these interfaces.
 */

/** The authenticated caller. Authentication (token validity, revocation) happens before the handler. */
export interface RunEventsPrincipal {
  readonly type: 'user' | 'service';
  readonly id: string;
  /** The caller's tenant. Absent means no tenant context: the stream fails closed. */
  readonly tenantId: string | null;
  readonly roles: readonly string[];
}

/** A run as the stream needs it. */
export interface RunEventsRunRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly state: RunState;
}

/** Reads a run inside one tenant. `null` for a run that does not exist there (never another tenant's row). */
export interface RunEventsRunReader {
  getRun(tenantId: string, runId: string): Promise<RunEventsRunRecord | null>;
}

/** The event bus of one tenant. The tenant forms the Valkey key prefix, so a bus cannot address another tenant. */
export type RunEventsBusFactory = (tenantId: string) => EventBus;
