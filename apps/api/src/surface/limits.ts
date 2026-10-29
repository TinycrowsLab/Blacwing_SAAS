/**
 * Hard caps of the console surface view (GRAPH-006). A surface above the node cap is served as its highest-degree
 * subset with `truncated: true`; the full counts stay in `totals`. These are constants of the view, not tuning knobs,
 * so a deployment cannot widen them past what the browser can draw.
 */
export const GRAPH_VIZ_MAX_NODES = 2000;
export const GRAPH_VIZ_MAX_EDGES = 4000;

/** Default and largest page of nodes (`limit`). A larger `limit` is refused with `INVALID_QUERY`, not clamped. */
export const GRAPH_VIZ_DEFAULT_LIMIT = 100;
export const GRAPH_VIZ_MAX_LIMIT = 200;

/** Longest `kinds` parameter accepted: every kind name, comma separated, with room to spare. */
export const GRAPH_VIZ_KINDS_PARAM_MAX = 200;
