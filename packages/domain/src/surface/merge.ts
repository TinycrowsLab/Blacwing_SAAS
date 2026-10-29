import { type ScopeRules, uuidV7Schema } from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';

import { hostKey, technologyKey } from './fingerprint.js';
import { canonicalAddress, canonicalMethod, normaliseUrlTemplate } from './normalise.js';
import {
  nodeScopeDecision,
  parseSurfaceWriteRequest,
  requireSurfaceTenant,
  SURFACE_SOURCE_KINDS,
  type SurfaceEdge,
  type SurfaceNode,
  type SurfaceProvenance,
  type SurfaceSourceKind,
  surfaceNodeKey,
  type SurfaceWriteRequest,
} from './write.js';

/**
 * Convergence layer (RECON-016): merges the surface contributions of every recon source into one de-duplicated,
 * provenance-tracked model per run, and reads the merged projection the planner consumes.
 *
 * The rules are pure. Persistence sits behind {@link SurfaceModelStore}, which must run each `update` with
 * exclusive access to its (tenant, run) model and persist only when the callback returns. Merging is idempotent
 * (a replayed write adds nothing) and independent of arrival order.
 */

/** Counter per entity that becomes visible for the first time. Labelled by node `type`. */
export const SURFACE_NODES_METRIC = 'recon_surface_nodes_total';
/** Counter per entity that starts to disagree with itself (version, pinned IP or name). */
export const SURFACE_CONFLICTS_METRIC = 'recon_surface_conflicts_total';
/** Span around one merge write. */
export const SURFACE_MERGE_SPAN = 'surface.merge';
export const SURFACE_PAGE_MAX = 200;
export const SURFACE_PAGE_DEFAULT = 50;

const CURSOR_KEY = /^[0-9a-f]{64}$/;

type NodeType = SurfaceNode['type'];
export type SurfaceConflictField = 'version' | 'pinnedIp' | 'name';
const CONFLICT_FIELDS = ['version', 'pinnedIp', 'name'] as const;

/**
 * One source's statement about an entity: a provenance entry. Append-only, so the planner and the audit trail keep
 * the full history. The variable fields (version, pinned IP, name) are what this source saw.
 */
export interface SurfaceObservation {
  readonly runId: string;
  readonly sessionId: string;
  readonly persona: string;
  readonly tool: string;
  readonly toolVersion: string;
  readonly sourceKind: SurfaceSourceKind;
  readonly confidence: number;
  readonly observedAt: string;
  /** Technology: the version this source reported, `null` when it reported none. */
  readonly version?: string | null;
  /** Host: the address the hostname was pinned to (anti-rebinding, §8.2). */
  readonly pinnedIp?: string;
  /** Service: the name the source reported. */
  readonly name?: string;
}

export interface SurfaceEntity {
  readonly key: string;
  /** Canonical identity without the variable fields. `null` while this is only a placeholder for an edge endpoint. */
  readonly identity: SurfaceNode | null;
  readonly observations: SurfaceObservation[];
}

/** The mutable per-run model a store keeps and {@link applySurfaceWrite} updates. */
export interface SurfaceModel {
  /** Entities by entity key. Technology entities are keyed by host and product, not version. */
  readonly entities: Map<string, SurfaceEntity>;
  /** Write key (a node's own fingerprint) -> entity key, where they differ (technology versions). */
  readonly aliases: Map<string, string>;
  /** Write keys of nodes rejected by the envelope scope. Nothing referencing them is ever stored. */
  readonly tombstones: Set<string>;
  /** Edges by raw write keys; resolved through `aliases` when read. */
  readonly edges: Map<string, SurfaceEdge>;
}

/** A fresh, empty model. */
export function emptySurfaceModel(): SurfaceModel {
  return { entities: new Map(), aliases: new Map(), tombstones: new Set(), edges: new Map() };
}

export interface SurfaceMergeStats {
  /** Entities that became visible for the first time, by node type. */
  readonly created: Partial<Record<NodeType, number>>;
  /** Entities that began to disagree with themselves in this write. */
  readonly conflicts: number;
  /** Nodes and edges dropped at merge time as out of envelope scope. */
  readonly filtered: number;
}

/** Source rank: lower wins a conflict. active-confirmed > ingested-spec > passive > historical/archive. */
const rankOf = (observation: SurfaceObservation): number =>
  SURFACE_SOURCE_KINDS.indexOf(observation.sourceKind);

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The canonical identity of a node: its fingerprint preimage, with the variable fields removed. */
function identityOf(node: SurfaceNode): SurfaceNode {
  switch (node.type) {
    case 'host':
      return {
        type: 'host',
        assetId: node.assetId.toLowerCase(),
        address: canonicalAddress(node.address),
      };
    case 'service':
      return {
        type: 'service',
        assetId: node.assetId.toLowerCase(),
        address: canonicalAddress(node.address),
        port: node.port,
        proto: node.proto,
      };
    case 'endpoint':
      return {
        type: 'endpoint',
        assetId: node.assetId.toLowerCase(),
        method: canonicalMethod(node.method),
        url: normaliseUrlTemplate(node.url),
      };
    case 'parameter':
      return {
        type: 'parameter',
        assetId: node.assetId.toLowerCase(),
        method: canonicalMethod(node.method),
        url: normaliseUrlTemplate(node.url),
        location: node.location,
        name: node.name.trim(),
      };
    case 'technology':
      return {
        type: 'technology',
        assetId: node.assetId.toLowerCase(),
        address: canonicalAddress(node.address),
        product: node.product.trim().toLowerCase(),
      };
    case 'role':
      return {
        type: 'role',
        assetId: node.assetId.toLowerCase(),
        roleName: node.roleName.trim().toLowerCase(),
      };
  }
}

/**
 * The entity a node merges into. A technology node merges with every other version of the same product on the
 * same host, so the versions become alternatives. Every other node is its own entity.
 */
function entityKeyOf(node: SurfaceNode): string {
  return node.type === 'technology'
    ? technologyKey(hostKey(node.assetId, node.address), node.product)
    : surfaceNodeKey(node);
}

function observationOf(node: SurfaceNode, provenance: SurfaceProvenance): SurfaceObservation {
  const base: SurfaceObservation = {
    runId: provenance.runId,
    sessionId: provenance.sessionId,
    persona: provenance.persona,
    tool: provenance.tool,
    toolVersion: provenance.toolVersion,
    sourceKind: provenance.sourceKind,
    confidence: provenance.confidence,
    observedAt: provenance.observedAt,
  };
  switch (node.type) {
    case 'technology':
      return {
        ...base,
        version: node.version === undefined ? null : node.version.trim().toLowerCase(),
      };
    case 'host':
      return node.pinnedIp === undefined
        ? base
        : { ...base, pinnedIp: canonicalAddress(node.pinnedIp) };
    case 'service':
      return node.name === undefined ? base : { ...base, name: node.name.trim() };
    default:
      return base;
  }
}

function resolveKey(model: SurfaceModel, key: string): string {
  return model.aliases.get(key) ?? key;
}

/** A visible entity: one whose node has arrived. Placeholders are not visible. */
type VisibleEntity = SurfaceEntity & { readonly identity: SurfaceNode };

/** Whether an entity is visible: its node has arrived. A placeholder is not. */
function isVisible(entity: SurfaceEntity | undefined): entity is VisibleEntity {
  return (entity?.identity ?? null) !== null;
}

function visibleEntity(model: SurfaceModel, key: string): VisibleEntity | undefined {
  const entity = model.entities.get(key);
  return isVisible(entity) ? entity : undefined;
}

function candidatesOf(
  observations: readonly SurfaceObservation[],
  field: SurfaceConflictField,
): { value: string | null; observation: SurfaceObservation }[] {
  return observations.flatMap((observation) => {
    const value = observation[field];
    return value === undefined ? [] : [{ value, observation }];
  });
}

/** The variable fields on which an entity's observations disagree. */
function conflictFieldsOf(entity: SurfaceEntity): SurfaceConflictField[] {
  return CONFLICT_FIELDS.filter((field) => {
    const distinct = new Set(
      candidatesOf(entity.observations, field).map((c) => JSON.stringify(c.value)),
    );
    return distinct.size > 1;
  });
}

/** Keeps the observation list free of exact replays, so a retried write is a no-op (idempotent upsert). */
function appendObservation(
  observations: SurfaceObservation[],
  observation: SurfaceObservation,
): void {
  const signature = JSON.stringify(observation);
  if (!observations.some((o) => JSON.stringify(o) === signature)) observations.push(observation);
}

interface PreparedNode {
  readonly writeKey: string;
  readonly entityKey: string;
  readonly identity: SurfaceNode;
  readonly observation: SurfaceObservation;
  readonly inScope: boolean;
}

/**
 * Merges one validated write into the model and reports what changed. Every key, identity and observation is
 * computed before the first mutation, so a node that cannot be keyed leaves the model untouched.
 */
export function applySurfaceWrite(
  model: SurfaceModel,
  request: SurfaceWriteRequest,
  scope: ScopeRules,
): SurfaceMergeStats {
  const prepared: PreparedNode[] = request.nodes.map((node) => ({
    writeKey: surfaceNodeKey(node),
    entityKey: entityKeyOf(node),
    identity: identityOf(node),
    observation: observationOf(node, request.provenance),
    inScope: nodeScopeDecision(node, scope)?.inScope !== false,
  }));

  const created: Partial<Record<NodeType, number>> = {};
  const wasConflicted = new Map<string, boolean>();
  let filtered = 0;

  for (const p of prepared) {
    if (model.tombstones.has(p.writeKey)) {
      filtered += 1;
      continue;
    }
    if (!p.inScope) {
      // Defence in depth: the gateway and writeSurface are primary (§8.2). Keep only the key, never the target.
      model.tombstones.add(p.writeKey);
      dropPlaceholder(model, p.writeKey);
      filtered += 1;
      continue;
    }
    if (p.writeKey !== p.entityKey) {
      model.aliases.set(p.writeKey, p.entityKey);
      dropPlaceholder(model, p.writeKey);
    }

    const before = model.entities.get(p.entityKey);
    if (!wasConflicted.has(p.entityKey)) {
      wasConflicted.set(p.entityKey, isVisible(before) && conflictFieldsOf(before).length > 0);
    }
    const observations = before?.observations ?? [];
    appendObservation(observations, p.observation);
    model.entities.set(p.entityKey, {
      key: p.entityKey,
      identity: before?.identity ?? p.identity,
      observations,
    });
    if (!isVisible(before)) {
      created[p.identity.type] = (created[p.identity.type] ?? 0) + 1;
    }
  }

  for (const edge of request.edges) {
    if (model.tombstones.has(edge.from) || model.tombstones.has(edge.to)) {
      filtered += 1;
      continue;
    }
    // An endpoint whose node has not arrived yet gets a placeholder, reconciled when the node comes.
    for (const raw of [edge.from, edge.to]) {
      const key = resolveKey(model, raw);
      if (!model.entities.has(key))
        model.entities.set(key, { key, identity: null, observations: [] });
    }
    model.edges.set(`${edge.type}|${edge.from}|${edge.to}`, edge);
  }

  let conflicts = 0;
  for (const [key, conflictedBefore] of wasConflicted) {
    const entity = model.entities.get(key);
    if (isVisible(entity) && !conflictedBefore && conflictFieldsOf(entity).length > 0) {
      conflicts += 1;
    }
  }
  return { created, conflicts, filtered };
}

/** Removes the placeholder stored under a write key, if there is one. Visible entities are left alone. */
function dropPlaceholder(model: SurfaceModel, writeKey: string): void {
  const entity = model.entities.get(writeKey);
  if (entity?.identity === null) model.entities.delete(writeKey);
}

/** A technology version seen for an entity. The primary is the first alternative. */
export interface TechnologyAlternative {
  readonly version: string | null;
  readonly confidence: number;
  readonly sourceKind: SurfaceSourceKind;
}

/** A visible entity in the merged projection. */
export interface MergedSurfaceNode {
  readonly key: string;
  readonly type: NodeType;
  readonly identity: SurfaceNode;
  /** The maximum confidence across every source that reported this entity. */
  readonly confidence: number;
  /** Every observation, in arrival order. Never overwritten. */
  readonly provenance: readonly SurfaceObservation[];
  /** Technology only: every version seen, highest confidence first, then source rank, then version text. */
  readonly alternatives?: readonly TechnologyAlternative[];
  /** The pinned address by source rank, then confidence, then value. */
  readonly pinnedIp?: string;
  /** The service name by source rank, then confidence, then value. */
  readonly name?: string;
  readonly conflicts: readonly SurfaceConflictField[];
}

export interface MergedSurfaceEdge {
  readonly type: SurfaceEdge['type'];
  readonly from: string;
  readonly to: string;
}

export interface MergedSurfacePage {
  readonly nodes: readonly MergedSurfaceNode[];
  /** Edges whose source node is on this page. Only edges between visible entities are returned. */
  readonly edges: readonly MergedSurfaceEdge[];
  /** Pass as `cursor` to read the next page, or `null` when this page is the last. */
  readonly nextCursor: string | null;
}

export interface MergedSurfaceOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

/** Picks the best value for a variable field: source rank first, then confidence, then value. */
function pickValue(
  candidates: readonly { value: string | null; observation: SurfaceObservation }[],
): string | undefined {
  const best = candidates
    .flatMap((c) => (c.value === null ? [] : [{ value: c.value, observation: c.observation }]))
    .sort(
      (a, b) =>
        rankOf(a.observation) - rankOf(b.observation) ||
        b.observation.confidence - a.observation.confidence ||
        compareText(a.value, b.value),
    )[0];
  return best?.value;
}

function alternativesOf(observations: readonly SurfaceObservation[]): TechnologyAlternative[] {
  const byVersion = new Map<string, SurfaceObservation>();
  for (const observation of observations) {
    if (observation.version === undefined) continue;
    const groupKey = observation.version ?? '';
    const current = byVersion.get(groupKey);
    if (
      current === undefined ||
      observation.confidence > current.confidence ||
      (observation.confidence === current.confidence && rankOf(observation) < rankOf(current))
    ) {
      byVersion.set(groupKey, observation);
    }
  }
  return [...byVersion.values()]
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        rankOf(a) - rankOf(b) ||
        compareText(a.version ?? '', b.version ?? ''),
    )
    .map((o) => ({
      version: o.version ?? null,
      confidence: o.confidence,
      sourceKind: o.sourceKind,
    }));
}

function project(entity: VisibleEntity): MergedSurfaceNode {
  const { identity, observations } = entity;
  const confidence = observations.reduce((max, o) => Math.max(max, o.confidence), 0);
  const pinnedIp = pickValue(candidatesOf(observations, 'pinnedIp'));
  const name = pickValue(candidatesOf(observations, 'name'));
  return {
    key: entity.key,
    type: identity.type,
    identity,
    confidence,
    provenance: observations,
    ...(identity.type === 'technology' ? { alternatives: alternativesOf(observations) } : {}),
    ...(pinnedIp === undefined ? {} : { pinnedIp }),
    ...(name === undefined ? {} : { name }),
    conflicts: conflictFieldsOf(entity),
  };
}

function compareEdges(a: MergedSurfaceEdge, b: MergedSurfaceEdge): number {
  return compareText(a.from, b.from) || compareText(a.type, b.type) || compareText(a.to, b.to);
}

/**
 * Reads one page of the merged projection. Entities are ordered by key, so a page does not shift when new entities
 * arrive after the cursor. Placeholders are never returned.
 */
export function readMergedSurface(
  model: SurfaceModel,
  options: MergedSurfaceOptions = {},
): MergedSurfacePage {
  const limit = options.limit ?? SURFACE_PAGE_DEFAULT;
  const { cursor } = options;
  const keys = [...model.entities.keys()]
    .filter((key) => visibleEntity(model, key) !== undefined)
    .sort(compareText);
  const start = cursor === undefined ? 0 : keys.findIndex((key) => compareText(key, cursor) > 0);
  const from = start === -1 ? keys.length : start;
  const pageKeys = keys.slice(from, from + limit);
  const onPage = new Set(pageKeys);

  const seen = new Set<string>();
  const edges: MergedSurfaceEdge[] = [];
  for (const edge of model.edges.values()) {
    const resolved: MergedSurfaceEdge = {
      type: edge.type,
      from: resolveKey(model, edge.from),
      to: resolveKey(model, edge.to),
    };
    if (!onPage.has(resolved.from) || visibleEntity(model, resolved.to) === undefined) continue;
    const signature = `${resolved.type}|${resolved.from}|${resolved.to}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    edges.push(resolved);
  }

  const nodes = pageKeys.flatMap((key) => {
    const entity = visibleEntity(model, key);
    return entity === undefined ? [] : [project(entity)];
  });
  return {
    nodes,
    edges: edges.sort(compareEdges),
    nextCursor: from + limit < keys.length ? (pageKeys.at(-1) ?? null) : null,
  };
}

/** Tenant-scoped persistence for the merged model. Implementations must serialise `update` per (tenant, run). */
export interface SurfaceModelStore {
  /** Runs `fn` on the model with exclusive access, and persists it only if `fn` returns normally. */
  update<T>(tenantId: string, runId: string, fn: (model: SurfaceModel) => T): Promise<T>;
  /** A snapshot of the run's model. An unknown run, or another tenant's run, reads as empty. */
  read(tenantId: string, runId: string): Promise<SurfaceModel>;
}

export interface SurfaceMergeContext {
  /** Tenant of the run (§8.6). Missing or malformed fails closed. */
  readonly tenantId: string;
  /** The run envelope's scope. Nodes outside it are dropped at merge time. */
  readonly scope: ScopeRules;
  /** Increments a counter. Labels are `{ type }` for {@link SURFACE_NODES_METRIC}, and empty otherwise. */
  readonly increment?: (
    metric: string,
    labels: Readonly<Record<string, string>>,
    by: number,
  ) => void;
  /** Runs `fn` inside a span named `name`. */
  readonly withSpan?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

/**
 * Validates one recon write and merges it into its run's model. Validation runs before the store is touched, so a
 * rejected write leaves nothing behind.
 * @throws {TenantContextMissingError} no or malformed tenant id.
 * @throws {SurfaceBatchTooLargeError | ValidationError | InvalidSurfaceInputError} malformed batch.
 */
export async function mergeSurfaceWrite(
  ctx: SurfaceMergeContext,
  store: SurfaceModelStore,
  input: unknown,
): Promise<SurfaceMergeStats> {
  requireSurfaceTenant(ctx.tenantId);
  const request = parseSurfaceWriteRequest(input);
  const runId = request.provenance.runId;
  const run = (): Promise<SurfaceMergeStats> =>
    store.update(ctx.tenantId, runId, (model) => applySurfaceWrite(model, request, ctx.scope));
  const stats = await (ctx.withSpan === undefined ? run() : ctx.withSpan(SURFACE_MERGE_SPAN, run));
  for (const [type, count] of Object.entries(stats.created)) {
    ctx.increment?.(SURFACE_NODES_METRIC, { type }, count);
  }
  if (stats.conflicts > 0) ctx.increment?.(SURFACE_CONFLICTS_METRIC, {}, stats.conflicts);
  return stats;
}

/**
 * The de-duplicated surface graph for the planner, one page at a time.
 * @throws {TenantContextMissingError} no or malformed tenant id.
 * @throws {ValidationError} a malformed run id, cursor or limit.
 */
export async function getMergedSurface(
  ctx: { readonly tenantId: string },
  store: SurfaceModelStore,
  runId: string,
  options: MergedSurfaceOptions = {},
): Promise<MergedSurfacePage> {
  requireSurfaceTenant(ctx.tenantId);
  if (!uuidV7Schema.safeParse(runId).success) {
    throw new ValidationError('merged surface read needs a valid run id');
  }
  const limit = options.limit ?? SURFACE_PAGE_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SURFACE_PAGE_MAX) {
    throw new ValidationError(
      `merged surface limit must be an integer from 1 to ${SURFACE_PAGE_MAX}`,
    );
  }
  if (options.cursor !== undefined && !CURSOR_KEY.test(options.cursor)) {
    throw new ValidationError('merged surface cursor is malformed');
  }
  const model = await store.read(ctx.tenantId, runId);
  return readMergedSurface(model, { ...options, limit });
}
