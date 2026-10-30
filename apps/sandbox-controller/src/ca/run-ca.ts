import { z } from 'zod';

import { isoDateTimeSchema, sandboxRefSchema, uuidV7Schema } from '@blackwing/contracts';
import { AppError, ValidationError } from '@blackwing/errors';

import { describeCertificate, generateRunCa } from './x509.js';

import type { CaProvisioner, IssueRunCaInput, RunCaRef, RunScope } from '../drivers/types.js';
import type { ControllerMetrics } from '../metrics.js';
import type { EgressCaRegistry } from './egress-registry.js';
import type { Logger } from '@blackwing/logger';
import type { OpenBaoClient } from '@blackwing/secrets';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const HTTP_NOT_FOUND = 404;
const RUN_CA_GRACE_MINUTES = 5;
/** Grace after the run window before the CA stops validating (run teardown can run late). */
export const RUN_CA_GRACE_MS = RUN_CA_GRACE_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;
/** Backdating for clock skew between the controller and the sandboxes. `notBefore <= now` always holds. */
export const RUN_CA_BACKDATE_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;

export interface RunCaAuditEvent {
  readonly type: 'run_ca.issued' | 'run_ca.revoked';
  readonly tenantId: string;
  readonly runId: string;
  /** Public fingerprint only; the key and the PEM never appear in an audit event (§8.7). */
  readonly fingerprintSha256: string;
  /** `run_ca.issued` only. */
  readonly notAfter?: string;
  readonly occurredAt: string;
}

export interface RunCaAuditEmitter {
  emit(event: RunCaAuditEvent): Promise<void>;
}

/** Default emitter: one structured `audit` log line per event (the audit ledger lands behind #82). */
export function createRunCaLogAuditEmitter(logger: Logger): RunCaAuditEmitter {
  const log = logger.child({ component: 'audit' });
  return {
    emit(event) {
      log.info({ audit: event }, event.type);
      return Promise.resolve();
    },
  };
}

export interface RunCaProvisionerDeps {
  /** OpenBao (KV v2 at `secret/`) under the run-CA issuer role. Unavailable store = no sandbox (fail closed). */
  readonly openbao: OpenBaoClient;
  readonly egress: EgressCaRegistry;
  readonly audit: RunCaAuditEmitter;
  readonly metrics: Pick<ControllerMetrics, 'caIssued' | 'caRevoked'>;
  readonly now?: () => Date;
}

const issueInputSchema = z.strictObject({
  tenantId: uuidV7Schema,
  runId: uuidV7Schema,
  runWindowEndsAt: isoDateTimeSchema,
  standingAuthorisationExpiresAt: isoDateTimeSchema,
});
const scopeSchema = z.strictObject({ tenantId: uuidV7Schema, runId: uuidV7Schema });
const storedPemSchema = z.object({ data: z.object({ pem: z.string().min(1) }) });

/** KV v2 data paths of one run's CA. Both sit under the tenant, so a run can never resolve another tenant's CA. */
function runCaPaths(scope: RunScope): { readonly key: string; readonly cert: string } {
  const base = `secret/data/tenants/${scope.tenantId}/runs/${scope.runId}/run-ca`;
  return { key: `${base}/key`, cert: `${base}/cert` };
}

/** KV v2 metadata path: deleting it removes every version, so later reads of the data path return 404. */
const metadataPath = (dataPath: string): string =>
  dataPath.replace(/^secret\/data\//, 'secret/metadata/');

function parseScope<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('run CA request is invalid', {
      detail: parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
    });
  }
  return parsed.data;
}

/**
 * Per-run CA provisioner (SANDBOX-008, CONTEXT_PACK §4.1, §8.1, §8.7, §8.9). One CA per run, shared by every
 * sandbox of that run. The private key is written to OpenBao and handed to nothing else; the certificate
 * is published to the egress gateway and referenced by `caBundleRef` for the sandbox trust store.
 */
export function createRunCaProvisioner(deps: RunCaProvisionerDeps): CaProvisioner {
  const clock = deps.now ?? (() => new Date());
  const inflight = new Map<string, Promise<RunCaRef>>();

  /** Returns the stored PEM at a data path, or undefined when nothing is stored there. */
  async function readPem(path: string): Promise<string | undefined> {
    const res = await deps.openbao.request('GET', path);
    if (res.status === HTTP_NOT_FOUND || res.data === undefined) return undefined;
    const parsed = storedPemSchema.safeParse(res.data);
    if (!parsed.success) throw new AppError('INTERNAL', 'stored run CA record is malformed');
    return parsed.data.data.pem;
  }

  /** Creates a KV record only if the path is empty (`cas: 0`), so a second issuer can never overwrite a key. */
  async function createOnce(path: string, pem: string): Promise<void> {
    await deps.openbao.request('POST', path, { data: { pem }, options: { cas: 0 } });
  }

  /** Deletes both records of a run's CA and withdraws it from the egress gateway. Idempotent. */
  async function purge(scope: RunScope): Promise<void> {
    const paths = runCaPaths(scope);
    await deps.openbao.request('DELETE', metadataPath(paths.key));
    await deps.openbao.request('DELETE', metadataPath(paths.cert));
    await deps.egress.withdraw(scope);
  }

  function refFor(
    scope: RunScope,
    certificatePem: string,
    window: {
      readonly notBefore: Date;
      readonly notAfter: Date;
      readonly fingerprintSha256: string;
    },
  ): RunCaRef {
    const paths = runCaPaths(scope);
    return {
      tenantId: scope.tenantId,
      runId: scope.runId,
      certificatePem,
      keyRef: sandboxRefSchema.parse(`openbao://${paths.key}`),
      caBundleRef: sandboxRefSchema.parse(`openbao://${paths.cert}`),
      fingerprintSha256: window.fingerprintSha256,
      notBefore: window.notBefore.toISOString(),
      notAfter: window.notAfter.toISOString(),
    };
  }

  async function issue(input: IssueRunCaInput): Promise<RunCaRef> {
    const now = clock().getTime();
    const paths = runCaPaths(input);

    const existing = await readPem(paths.cert);
    if (existing !== undefined) {
      const window = describeCertificate(existing);
      if (window.notAfter.getTime() <= now) {
        throw new ValidationError('run CA has expired; revoke it before issuing another', {
          detail: 'notAfter',
        });
      }
      await deps.egress.publish({
        tenantId: input.tenantId,
        runId: input.runId,
        certificatePem: existing,
        fingerprintSha256: window.fingerprintSha256,
        notAfter: window.notAfter.toISOString(),
      });
      return refFor(input, existing, window);
    }

    // Capped at the standing authorisation: a CA never outlives the authority that allowed its run (§8.1).
    const notAfterMs = Math.min(
      Date.parse(input.runWindowEndsAt) + RUN_CA_GRACE_MS,
      Date.parse(input.standingAuthorisationExpiresAt),
    );
    if (!(notAfterMs > now)) {
      throw new ValidationError('run CA window has already ended', { detail: 'notAfter' });
    }

    const material = await generateRunCa({
      runId: input.runId,
      notBefore: new Date(now - RUN_CA_BACKDATE_MS),
      notAfter: new Date(notAfterMs),
    });
    // Describe the certificate as it was encoded (X.509 truncates to whole seconds), not as requested.
    const window = describeCertificate(material.certificatePem);

    // The key is created first and exclusively: if it already exists another issuer owns this run's CA
    // and nothing of ours is written. Anything written after that is rolled back on failure.
    await createOnce(paths.key, material.privateKeyPem);
    try {
      await createOnce(paths.cert, material.certificatePem);
      await deps.egress.publish({
        tenantId: input.tenantId,
        runId: input.runId,
        certificatePem: material.certificatePem,
        fingerprintSha256: material.fingerprintSha256,
        notAfter: window.notAfter.toISOString(),
      });
      await deps.audit.emit({
        type: 'run_ca.issued',
        tenantId: input.tenantId,
        runId: input.runId,
        fingerprintSha256: material.fingerprintSha256,
        notAfter: window.notAfter.toISOString(),
        occurredAt: new Date(now).toISOString(),
      });
    } catch (error) {
      await purge(input).catch(() => undefined);
      throw error;
    }
    deps.metrics.caIssued.inc();
    return refFor(input, material.certificatePem, window);
  }

  return {
    async issueRunCa(raw) {
      const input = parseScope(issueInputSchema, raw);
      const key = `${input.tenantId}/${input.runId}`;
      // Two sandboxes of one run in one process share the same issuance.
      const pending = inflight.get(key);
      if (pending !== undefined) return await pending;
      const promise = issue(input).finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, promise);
      return await promise;
    },

    async revokeRunCa(raw) {
      const scope = parseScope(scopeSchema, raw);
      const pem = await readPem(runCaPaths(scope).cert);
      await purge(scope);
      if (pem !== undefined) {
        deps.metrics.caRevoked.inc();
        await deps.audit.emit({
          type: 'run_ca.revoked',
          tenantId: scope.tenantId,
          runId: scope.runId,
          fingerprintSha256: describeCertificate(pem).fingerprintSha256,
          occurredAt: clock().toISOString(),
        });
      }
    },
  };
}
