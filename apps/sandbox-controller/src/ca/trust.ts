import { type ReadOnlyMountSpec, sandboxRefSchema } from '@blackwing/contracts';

/** Where the run CA certificate appears inside every sandbox (SANDBOX-008). Read-only, public cert only. */
export const SANDBOX_CA_TARGET = '/etc/bw/ca.pem';

/** The trust-store variables pointing at {@link SANDBOX_CA_TARGET}, one per runtime family. */
export const SANDBOX_CA_ENV = {
  NODE_EXTRA_CA_CERTS: SANDBOX_CA_TARGET,
  SSL_CERT_FILE: SANDBOX_CA_TARGET,
  REQUESTS_CA_BUNDLE: SANDBOX_CA_TARGET,
  CURL_CA_BUNDLE: SANDBOX_CA_TARGET,
} as const;

export interface CaTrustFragment {
  readonly mounts: readonly [ReadOnlyMountSpec];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The `SandboxSpec` fragment that makes a sandbox trust its run CA: one read-only `ca` mount whose source is
 * the certificate reference (`caBundleRef`), plus the four trust env vars. Merge it into the spec the
 * controller builds. The fragment carries references only, so it can never hold key material.
 */
export function caTrustFragment(caBundleRef: string): CaTrustFragment {
  const source = sandboxRefSchema.parse(caBundleRef);
  return {
    mounts: [{ kind: 'ca', source, target: SANDBOX_CA_TARGET, readOnly: true }],
    env: { ...SANDBOX_CA_ENV },
  };
}
