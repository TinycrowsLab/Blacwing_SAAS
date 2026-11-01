# Policy snapshot format (POLICY-007)

Shared verification spec for the signed policy snapshot bundle. The TypeScript builder and verifier live in
`packages/policy/src/snapshot.ts`. The Go egress gateway (EGRESS-003, `apps/egress-gateway`) must implement the
same verification byte-for-byte. Any mismatch is a release blocker (POLICY-008 vectors). This spec is normative for
both sides.

## Token

A compact JWS (RFC 7515) with exactly three base64url parts: `header.payload.signature`.

Protected header:

| Member | Value |
| --- | --- |
| `alg` | `EdDSA` (Ed25519, RFC 8037). Any other value, including `none`, is refused. |
| `kid` | The signing key id, resolved through the JWKS (see below). Required. |
| `typ` | `application/policy-snapshot+jcs`. Any other value is refused, so a snapshot is never read as another JWS kind. |

The signature covers the ASCII bytes of `base64url(header) "." base64url(payload)`.

The payload is the **canonical bytes** of the body below (RFC 8785 JCS). It is not a re-serialisation of a parsed
object. A verifier must reject a payload whose bytes differ from the JCS form of the object it decodes to.

Size: a token larger than 8 MiB (`8388608` bytes) is refused before parsing.

## Body

The body has exactly these members. An unknown member is a refusal (strict schema).

| Member | Type | Notes |
| --- | --- | --- |
| `snapshotVersion` | integer | Always `1`. Any other value is refused. |
| `tenantId` | UUID string | The tenant the snapshot belongs to. |
| `builtAt` | string | ISO-8601 UTC instant, no offset (`...Z`). |
| `schemaVersion` | string, non-empty | The Cedar schema version. |
| `cedarSchema` | string, non-empty | The Cedar schema text. |
| `baselineVersion` | string, non-empty | The platform baseline version. |
| `baselineSha256` | 64 lowercase hex | SHA-256 of the canonical baseline source. |
| `tenantPolicyVersion` | integer `>= 1`, or `null` | The active tenant policy version, or `null` for baseline only. |
| `tenantSha256` | 64 lowercase hex, or `null` | SHA-256 of the canonical tenant source, or `null`. |
| `policies` | array of 1 or 2 `{id, source}` | Evaluation order: `baseline` first, then `tenant` only when a version is active. `id` is `baseline` or `tenant`. |

Consistency rules (fail closed):

- A `tenant` layer is present if and only if both `tenantPolicyVersion` and `tenantSha256` are non-null.
- `policies[0].id` is `baseline`, and `policies.length` is 2 when a tenant layer exists, otherwise 1.
- When a `tenant` layer is present, `tenantSha256` must equal the SHA-256 (lowercase hex) of the UTF-8 bytes of
  the canonical policy source of that layer. Canonical policy source (`canonicalPolicySource` in
  `packages/policy/src/tenant-policy.ts`): convert CRLF and lone CR to LF; strip trailing spaces and tabs from every
  line; remove trailing empty lines; if anything remains, end it with exactly one LF, otherwise the result is empty.
  The Go side must implement the same steps.

## Snapshot id

`snapshotId = lowercase_hex(SHA-256(canonical payload bytes))`. The id is 64 lowercase hex characters. It is the
value stored as `policy_snapshots.snapshot_sha256` and pinned on the run manifest as
`runs.run_manifest.policySnapshotSha256` (CONTEXT_PACK §8.9).

## Verification steps

A verifier must run every step in order and refuse on the first failure (no partial acceptance):

1. Reject a token longer than 8 MiB, or one that is not exactly three base64url parts.
2. Decode the protected header. It must be a JSON object. `typ` must equal `application/policy-snapshot+jcs`.
   `kid` must be present and must resolve to a key in the JWKS.
3. Verify the Ed25519 signature over `header.payload` with the resolved public key. `alg` must be `EdDSA`.
4. Decode the payload as JSON. Re-encode it with JCS. The result must be byte-identical to the decoded payload bytes.
5. Validate the body against the schema above (strict members, types, consistency rules).
6. If the caller expects a tenant, `tenantId` must equal it.
7. If a tenant layer is present, recompute `tenantSha256` from its source and compare.
8. The snapshot id is the SHA-256 of the canonical payload bytes. Use it for pinning.

Any failure refuses the snapshot. The gateway keeps its last verified snapshot and blocks runs that need a policy it
cannot verify (CONTEXT_PACK §8.2). Refusal reasons are stable strings for logs and metrics: `malformed`, `wrong_type`,
`unknown_key`, `bad_signature`, `bad_body`, `wrong_tenant`, `tenant_digest_mismatch`.

## Key set (JWKS) and rotation

- Each signing key is an Ed25519 public key published as an RFC 8037 OKP JWK with `kty` `OKP`, `crv` `Ed25519`,
  `x`, `kid`, `alg` `EdDSA`, `use` `sig`.
- The signing key lives in OpenBao Transit (SECRETS). Its public half is published in the JWKS. The private key is never
  in the bundle, the logs or the database.
- The JWKS keeps every key version that has signed a snapshot still in use. A rotated key stays in the set, so old
  snapshots verify after rotation. A key is removed only when no retained snapshot depends on it.
- The row records `signing_key_id` as `<keyName>:v<N>`. The `kid` in the token header must match that id.

## Storage and publication

- Object key: `t/<tenantId>/policy-snapshots/<snapshotId>.jws`. The `t/` prefix is the only prefix the bucket
  policy allows (`docs/architecture/storage-buckets.md`).
- Publication order: sign, then write the object, then insert the `policy_snapshots` row. A row exists only after its
  object was stored. An unsigned snapshot is never stored.
- Snapshots are immutable. A new activation builds a new snapshot with a new id.

## Failure behaviour

| Failure | Behaviour |
| --- | --- |
| OpenBao unavailable at build | Build fails. Nothing is published. An alert is raised. The last good snapshot stays in use. |
| Object store write fails | Retried (default 3 attempts). Then it surfaces. No row is recorded. |
| Tampered bundle in storage | Verification fails. The gateway blocks (fail closed). |

## Observability and audit

- Metrics: `policy_snapshot_build_total{result}`, `policy_snapshot_build_size_bytes`, `policy_snapshot_sign_failures_total`.
- Span: `policy.snapshot.build` with attribute `snapshotId`.
- Audit: `policy.snapshot.built` with `snapshotId`, `baselineVersion`, `tenantPolicyVersion` and `signingKeyId`. The audit
  metadata holds ids, versions, the digest and the key id only, never policy text.
