import { z } from 'zod';

import { isoDateTimeSchema, uuidV7Schema } from './primitives.js';

/**
 * Shared sandbox contracts (SANDBOX-002, CONTEXT_PACK §3.1 / §4.1): the validated data that the
 * sandbox controller, its drivers (KubernetesDriver, DockerDriver) and the worker exchange.
 *
 * Rules carried by these schemas:
 * - Every spec carries `tenantId` and `runId` (§8.6 tenant isolation, per-run sandboxes/networks).
 * - Every sandbox records its digest-pinned image and runtime class (§8.9 pinned versions).
 * - No secret material: `caBundleRef` is a reference the controller resolves (SANDBOX-008) and env
 *   values are plain configuration, never credentials (credentials are injected by reference by the
 *   session manager / egress gateway, §8.7). PEM blocks are rejected outright.
 * - Non-tmpfs mounts are read-only, enforced both by the TypeScript type and at parse time.
 * - A run network with no reachable destination is rejected: that is a config bug, so provisioning
 *   fails closed instead of producing a sandbox that silently cannot work.
 *
 * Driver-agnostic by design: nothing here names a Kubernetes or Docker type.
 */

/** Driver implementations the controller can be configured with (`SBX_DRIVER`). */
export const SANDBOX_DRIVER_KINDS = ['kubernetes', 'docker'] as const;
export const sandboxDriverKindSchema = z.enum(SANDBOX_DRIVER_KINDS);
export type SandboxDriverKind = z.infer<typeof sandboxDriverKindSchema>;

/** Upper bounds that keep specs small and reject obviously broken input. */
export const SANDBOX_LIMITS = {
  maxCpu: 16,
  maxMemoryMiB: 65_536,
  maxPids: 32_768,
  /** Seven days. */
  maxTtlSeconds: 604_800,
  dnsLabelMax: 63,
  hostnameMax: 253,
  portMax: 65_535,
  minMemoryMiB: 16,
  envKeyMax: 128,
  maxTailLines: 100_000,
  maxGraceSeconds: 300,
  maxEnvEntries: 128,
  maxEnvValueLength: 4096,
  maxMounts: 32,
  maxDestinations: 16,
  maxIps: 16,
  maxRefLength: 512,
  maxPathLength: 1024,
  maxReasonLength: 1024,
  maxLogLineLength: 65_536,
} as const;

const PEM_MARKER = '-----BEGIN';

/** A Kubernetes-style DNS label: lowercase alphanumerics and `-`, 1..63 chars. */
const dnsLabelSchema = z
  .string()
  .max(SANDBOX_LIMITS.dnsLabelMax)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'must be a lowercase DNS label');

/** Persona key from the Agent Registry (CONTEXT_PACK §4.6), e.g. `web-api-specialist`. */
export const sandboxPersonaSchema = z
  .string()
  .max(SANDBOX_LIMITS.dnsLabelMax)
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'must be a lowercase kebab-case persona key');

/** A digest-pinned OCI image reference: `<repository>@sha256:<64 hex>`. Tags alone never float. */
export const imageDigestSchema = z
  .string()
  .max(SANDBOX_LIMITS.maxRefLength)
  .regex(
    /^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[\w][\w.-]{0,127})?@sha256:[0-9a-f]{64}$/,
    'must be a digest-pinned image reference (<repo>@sha256:<hex>)',
  );

/** Runtime class name (e.g. `gvisor`, `runc` in dev). Hardened values are SANDBOX-007's job. */
export const runtimeClassSchema = dnsLabelSchema;

/** An opaque reference such as `openbao://pki/run/<id>` or `secret://...`; never the material itself. */
export const sandboxRefSchema = z
  .string()
  .min(1)
  .max(SANDBOX_LIMITS.maxRefLength)
  .regex(/^[a-z][a-z0-9+.-]*:\/\/[\x21-\x7e]+$/, 'must be a <scheme>://<path> reference')
  .refine((value) => !value.includes(PEM_MARKER), 'must be a reference, not PEM material');

/** Absolute container path, normalised: no `..`, `.` or empty segments, no trailing slash. */
export const containerPathSchema = z
  .string()
  .min(1)
  .max(SANDBOX_LIMITS.maxPathLength)
  .refine(
    (value) =>
      value === '/' ||
      (value.startsWith('/') &&
        !value.endsWith('/') &&
        value
          .slice(1)
          .split('/')
          .every((seg) => seg !== '' && seg !== '.' && seg !== '..')),
    'must be a normalised absolute path',
  )
  .refine((value) => !/[\0\n\r]/.test(value), 'must not contain control characters');

/** Hostname (RFC 1123) or IPv4 literal of a run-network destination. */
const destinationHostSchema = z
  .string()
  .max(SANDBOX_LIMITS.hostnameMax)
  .regex(
    /^([a-z0-9]([-a-z0-9]*[a-z0-9])?)(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/,
    'must be a lowercase hostname or IPv4 address',
  );

const portSchema = z.number().int().min(1).max(SANDBOX_LIMITS.portMax);

// ---------------------------------------------------------------------------------------------
// Run network
// ---------------------------------------------------------------------------------------------

/** The only places a sandbox may reach (§4.1): everything else is denied by the run network. */
export const DESTINATION_KINDS = ['egress-gateway', 'model-gateway', 'run-broker'] as const;
export const destinationKindSchema = z.enum(DESTINATION_KINDS);
export type DestinationKind = z.infer<typeof destinationKindSchema>;

export const destinationSchema = z.strictObject({
  kind: destinationKindSchema,
  host: destinationHostSchema,
  port: portSchema,
});
export type Destination = z.infer<typeof destinationSchema>;

export const runNetworkSpecSchema = z
  .strictObject({
    runId: uuidV7Schema,
    tenantId: uuidV7Schema,
    allowedDestinations: z
      .array(destinationSchema)
      .min(1, 'a run network needs at least one allowed destination')
      .max(SANDBOX_LIMITS.maxDestinations),
    driver: sandboxDriverKindSchema,
  })
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    spec.allowedDestinations.forEach((d, i) => {
      const key = `${d.kind}|${d.host}|${String(d.port)}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['allowedDestinations', i],
          message: 'duplicate destination',
        });
      }
      seen.add(key);
    });
  });
export type RunNetworkSpec = z.infer<typeof runNetworkSpecSchema>;

/** What a sandbox spec points at: the provisioned network of its run. */
export const runNetworkRefSchema = z.strictObject({
  runId: uuidV7Schema,
  networkId: z.string().min(1).max(SANDBOX_LIMITS.maxRefLength),
});
export type RunNetworkRef = z.infer<typeof runNetworkRefSchema>;

/** Result of `ensureNetwork`: the reference plus the driver-native id and scope. */
export const runNetworkHandleSchema = z.strictObject({
  runId: uuidV7Schema,
  tenantId: uuidV7Schema,
  networkId: z.string().min(1).max(SANDBOX_LIMITS.maxRefLength),
  driver: sandboxDriverKindSchema,
  nativeId: z.string().min(1).max(SANDBOX_LIMITS.maxRefLength),
  createdAt: isoDateTimeSchema,
});
export type RunNetworkHandle = z.infer<typeof runNetworkHandleSchema>;

// ---------------------------------------------------------------------------------------------
// Mounts
// ---------------------------------------------------------------------------------------------

export const MOUNT_KINDS = ['inputs', 'source', 'ca', 'tmpfs'] as const;
export type MountKind = (typeof MOUNT_KINDS)[number];

/** `inputs`, `source` and `ca` mounts: `readOnly` is literally `true` (type and parse enforced). */
export const readOnlyMountSpecSchema = z.strictObject({
  kind: z.enum(['inputs', 'source', 'ca']),
  source: sandboxRefSchema,
  target: containerPathSchema,
  readOnly: z.literal(true),
});
export type ReadOnlyMountSpec = z.infer<typeof readOnlyMountSpecSchema>;

/** The writable scratch workspace: tmpfs only, never backed by a host path. */
export const tmpfsMountSpecSchema = z.strictObject({
  kind: z.literal('tmpfs'),
  target: containerPathSchema,
  readOnly: z.boolean(),
  sizeMiB: z.number().int().min(1).max(SANDBOX_LIMITS.maxMemoryMiB).optional(),
});
export type TmpfsMountSpec = z.infer<typeof tmpfsMountSpecSchema>;

export const mountSpecSchema = z.discriminatedUnion('kind', [
  readOnlyMountSpecSchema,
  tmpfsMountSpecSchema,
]);
export type MountSpec = z.infer<typeof mountSpecSchema>;

// ---------------------------------------------------------------------------------------------
// Sandbox spec
// ---------------------------------------------------------------------------------------------

export const sandboxResourcesSchema = z.strictObject({
  /** CPU cores (fractional allowed, e.g. `0.5`). */
  cpu: z.number().positive().max(SANDBOX_LIMITS.maxCpu),
  memoryMiB: z.number().int().min(SANDBOX_LIMITS.minMemoryMiB).max(SANDBOX_LIMITS.maxMemoryMiB),
  pids: z.number().int().min(1).max(SANDBOX_LIMITS.maxPids),
});
export type SandboxResources = z.infer<typeof sandboxResourcesSchema>;

const envKeySchema = z
  .string()
  .max(SANDBOX_LIMITS.envKeyMax)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name');

export const sandboxEnvSchema = z
  .record(
    envKeySchema,
    z
      .string()
      .max(SANDBOX_LIMITS.maxEnvValueLength)
      .refine((value) => !value.includes('\0'), 'must not contain NUL')
      .refine((value) => !value.includes(PEM_MARKER), 'must not carry PEM material'),
  )
  .refine(
    (env) => Object.keys(env).length <= SANDBOX_LIMITS.maxEnvEntries,
    `at most ${String(SANDBOX_LIMITS.maxEnvEntries)} env entries`,
  );

export const sandboxSpecSchema = z
  .strictObject({
    sandboxId: uuidV7Schema,
    runId: uuidV7Schema,
    tenantId: uuidV7Schema,
    sessionId: uuidV7Schema,
    persona: sandboxPersonaSchema,
    imageDigest: imageDigestSchema,
    runtimeClass: runtimeClassSchema,
    network: runNetworkRefSchema,
    resources: sandboxResourcesSchema,
    env: sandboxEnvSchema,
    mounts: z.array(mountSpecSchema).max(SANDBOX_LIMITS.maxMounts),
    ttlSeconds: z.number().int().min(1).max(SANDBOX_LIMITS.maxTtlSeconds),
    caBundleRef: sandboxRefSchema,
  })
  .superRefine((spec, ctx) => {
    if (spec.network.runId !== spec.runId) {
      ctx.addIssue({
        code: 'custom',
        path: ['network', 'runId'],
        message: "network must belong to the sandbox's run",
      });
    }
    const targets = new Set<string>();
    spec.mounts.forEach((mount, i) => {
      if (targets.has(mount.target)) {
        ctx.addIssue({
          code: 'custom',
          path: ['mounts', i, 'target'],
          message: 'duplicate mount target',
        });
      }
      targets.add(mount.target);
    });
  });
export type SandboxSpec = z.infer<typeof sandboxSpecSchema>;

// ---------------------------------------------------------------------------------------------
// Handle, health, logs, lifecycle
// ---------------------------------------------------------------------------------------------

export const SANDBOX_STATUSES = ['created', 'running', 'stopped', 'destroyed', 'failed'] as const;
export const sandboxStatusSchema = z.enum(SANDBOX_STATUSES);
export type SandboxStatus = z.infer<typeof sandboxStatusSchema>;

export const sandboxHandleSchema = z.strictObject({
  sandboxId: uuidV7Schema,
  /** Scope of the sandbox (§8.6); lets `list` and callers check ownership without a lookup. */
  tenantId: uuidV7Schema,
  runId: uuidV7Schema,
  driver: sandboxDriverKindSchema,
  /** Driver-native id (container id / pod UID); opaque to callers. */
  nativeId: z.string().min(1).max(SANDBOX_LIMITS.maxRefLength),
  status: sandboxStatusSchema,
  ips: z.array(z.union([z.ipv4(), z.ipv6()])).max(SANDBOX_LIMITS.maxIps),
  createdAt: isoDateTimeSchema,
});
export type SandboxHandle = z.infer<typeof sandboxHandleSchema>;

export const HEALTH_STATES = ['healthy', 'unhealthy', 'unknown'] as const;
export const healthStatusSchema = z.strictObject({
  state: z.enum(HEALTH_STATES),
  checkedAt: isoDateTimeSchema,
  reason: z.string().min(1).max(SANDBOX_LIMITS.maxReasonLength).optional(),
});
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const logLineSchema = z.strictObject({
  at: isoDateTimeSchema,
  stream: z.enum(['stdout', 'stderr']),
  line: z.string().max(SANDBOX_LIMITS.maxLogLineLength),
});
export type LogLine = z.infer<typeof logLineSchema>;

export const logOptionsSchema = z.strictObject({
  /** Only lines at or after this instant. */
  since: isoDateTimeSchema.optional(),
  /** Only the last N lines (applied before `follow`). */
  tailLines: z.number().int().min(1).max(SANDBOX_LIMITS.maxTailLines).optional(),
  /** Keep streaming until the sandbox stops. */
  follow: z.boolean().optional(),
});
export type LogOptions = z.infer<typeof logOptionsSchema>;

export const stopOptionsSchema = z.strictObject({
  /** Seconds to wait after SIGTERM before SIGKILL; 0 kills immediately (kill switch, §8.5). */
  graceSeconds: z.number().int().min(0).max(SANDBOX_LIMITS.maxGraceSeconds).optional(),
  reason: z.string().min(1).max(SANDBOX_LIMITS.maxReasonLength).optional(),
});
export type StopOptions = z.infer<typeof stopOptionsSchema>;

/** `list` filter. `tenantId` is mandatory so a listing can never span tenants (§8.6). */
export const sandboxListFilterSchema = z.strictObject({
  tenantId: uuidV7Schema,
  runId: uuidV7Schema.optional(),
  status: z.array(sandboxStatusSchema).min(1).optional(),
});
export type SandboxListFilter = z.infer<typeof sandboxListFilterSchema>;

export const SANDBOX_LIFECYCLE_EVENT_TYPES = [
  'created',
  'started',
  'healthy',
  'stopped',
  'destroyed',
  'failed',
] as const;
export type SandboxLifecycleEventType = (typeof SANDBOX_LIFECYCLE_EVENT_TYPES)[number];

export const sandboxLifecycleEventSchema = z
  .strictObject({
    sandboxId: uuidV7Schema,
    runId: uuidV7Schema,
    type: z.enum(SANDBOX_LIFECYCLE_EVENT_TYPES),
    at: isoDateTimeSchema,
    reason: z.string().min(1).max(SANDBOX_LIMITS.maxReasonLength).optional(),
  })
  .refine((event) => event.type !== 'failed' || event.reason !== undefined, {
    path: ['reason'],
    message: 'a failed event must carry a reason',
  });
export type SandboxLifecycleEvent = z.infer<typeof sandboxLifecycleEventSchema>;
