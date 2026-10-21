/** Client-side counters the console emits. Names match the issue's observability contract. */
export type ClientEventName = 'error_boundary_trip' | 'permission_denied_view';

/** Redaction-safe payload: event, route name and the two support identifiers. Nothing else can be added. */
export interface ClientEvent {
  readonly event: ClientEventName;
  readonly route: string;
  readonly code?: string;
  readonly traceId?: string;
}

export type ClientEventSink = (event: ClientEvent) => void;

const MAX_SEGMENT_CHARS = 40;
const MAX_SEGMENTS = 8;
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9A-Za-z_-]{20,})$/;

/** Reduces a pathname or route name to a low-cardinality name: ids become `:id`, query and hash are dropped. */
export function routeName(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? '';
  const segments = clean
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (ID_SEGMENT.test(s) ? ':id' : s))
    .map((s) => s.replace(/[^A-Za-z0-9_.:()-]/g, '_').slice(0, MAX_SEGMENT_CHARS));
  return `/${segments.slice(0, MAX_SEGMENTS).join('/')}`;
}

/** No-op until telemetry (CONSOLE/OBS) wires a sink; nothing is written to the console by default. */
let sink: ClientEventSink = () => undefined;

/** Replaces the sink (telemetry wiring and tests). Returns a function restoring the previous one. */
export function setClientEventSink(next: ClientEventSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

/** Emits a client event. Only whitelisted fields are copied, so callers cannot leak extra data. */
export function emitClientEvent(
  event: ClientEventName,
  route: string,
  ids: { code?: string | undefined; traceId?: string | undefined } = {},
): void {
  const payload: ClientEvent = {
    event,
    route: routeName(route),
    ...(ids.code !== undefined && SAFE_TOKEN.test(ids.code) ? { code: ids.code } : {}),
    ...(ids.traceId !== undefined && SAFE_TOKEN.test(ids.traceId) ? { traceId: ids.traceId } : {}),
  };
  try {
    sink(payload);
  } catch {
    // Telemetry must never break rendering.
  }
}
