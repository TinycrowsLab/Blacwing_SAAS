# Repro bundle format (1.0)

The standalone reproduction bundle of one finding (F18, REPRO). A bundle lets a person replay a validated finding
outside the platform, with the same requests and the same declared oracle. This page is the contract. The Zod
schemas live in `packages/contracts/src/validation/repro.ts` (`ReproManifestSchema`, `ReproRequestDescriptorSchema`,
`REPRO_FORMAT_VERSION`). The example bundle is committed under
`packages/contracts/src/validation/fixtures/repro-bundle-1.0/` and is reused by the generation, sanitisation and
runner tests (REPRO-002, REPRO-003, REPRO-004).

## Layout

The bundle is a `tar.gz` whose single root directory is `repro_<findingPublicId>/`:

| Entry | Contents |
|---|---|
| `manifest.json` | The `ReproManifest`: identity, class, oracle, negative control, pins, digest. |
| `requests/NNNN.json` | The ordered, sanitised request descriptors. `NNNN` is the 1-based `index`, zero-padded to four digits. |
| `expected.json` | The declared oracle and the result the bundle expects when it reproduces. |
| `run.py` | The runner (REPRO-004). Not part of this contract. |
| `README.md` | How to run the bundle. |

## `manifest.json`

Every field is required unless marked optional. Unknown fields are refused.

- `formatVersion`: must be `"1.0"`. A runner or verifier refuses any other value.
- `findingPublicId`, `runPublicId`, `assetPublicId`: `fnd_`, `run_` and `asset_` public ids.
- `class`: the authorisable intrusiveness class (`destructive` is never authorised).
- `cweId` and `owaspCategory`: the primary classification, or `null` when the finding awaits review.
- `oracle`: `{ type, params }`, drawn from the same catalogue as `test_cases.oracle`. An unknown `type` is refused,
  and `params` are checked against that type's schema.
- `negativeControl`: the replay negative control (`strategy` and at least one step). It must not satisfy the oracle.
- `requestCount`: the number of request descriptors, at least one and at most 50.
- `baseUrlPlaceholder`: always `"${TARGET_BASE_URL}"`. The host is never stored.
- `pinned`: the sandbox image digest, tool versions, nuclei template commit and the format version.
- `createdAt`: when the bundle was generated.
- `sanitised`: true once REPRO-003 has run.
- `truncated`: true when at least one request body is stored as an evidence pointer, not inline.
- `bundleSha256`: the digest rule below.

Example (`packages/contracts/src/validation/fixtures/repro-bundle-1.0/manifest.json`):

```json manifest
{
  "formatVersion": "1.0",
  "findingPublicId": "fnd_01m67bj0zcekntsgtb57q5eetf",
  "runPublicId": "run_01m67bj0zcekntsgtb58569v6r",
  "assetPublicId": "asset_01m67bj0zcekntsgtb5fw19xmd",
  "class": "active_safe",
  "cweId": "CWE-639",
  "owaspCategory": "A01:2021-Broken Access Control",
  "oracle": {
    "type": "status_diff",
    "params": {
      "baselineRef": "evidence/baseline-403",
      "compare": "status",
      "threshold": 0
    }
  },
  "negativeControl": {
    "strategy": "unmodified_request",
    "steps": [
      {
        "kind": "http_request",
        "method": "GET",
        "endpoint": {
          "assetId": "018f3b2a-7c1d-7a00-8000-000000000001",
          "urlTemplate": "https://app.example.test/orders/{id}"
        },
        "roleKey": "viewer",
        "inputRef": null
      }
    ]
  },
  "requestCount": 1,
  "baseUrlPlaceholder": "${TARGET_BASE_URL}",
  "pinned": {
    "sandboxImageDigest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    "toolVersions": {
      "nuclei": "3.3.0"
    },
    "nucleiTemplateCommit": "0123456789abcdef0123456789abcdef01234567",
    "formatVersion": "1.0"
  },
  "createdAt": "2026-10-31T10:00:00.000Z",
  "sanitised": true,
  "truncated": false,
  "bundleSha256": "61079ff43c9aecfc68b6720eaba37a6e13dc2b4fc57cde77a2d86912db54c8f5"
}
```

## Request descriptors (`requests/NNNN.json`)

- `index`: 1-based position in the sequence, equal to the file number.
- `method`: an HTTP method from the scope catalogue.
- `url`: a template that starts with `${TARGET_BASE_URL}/` and carries the path and query. A literal host is refused.
- `headers`: names must be on the allowlist (`accept`, `accept-encoding`, `accept-language`, `content-length`,
  `content-type`, `origin`, `referer`, `user-agent`, `x-requested-with`). `authorization`, `cookie` and
  `proxy-authorization` are refused in any letter case, whatever the value. Values are at most 1024 characters.
- `body`: `null`, or `{ encoding: "utf8" | "base64", content, evidenceRef }`. Exactly one of `content` (inline) or
  `evidenceRef` (a pointer, used when the body exceeds 256 KB) must be set. Inline UTF-8 is capped at 256 KB of bytes.
  Base64 must be canonical.
- `roleName`: `null`, or a `${ROLE_<NAME>}` placeholder. A token is never stored.

Example (`requests/0001.json`):

```json
{
  "index": 1,
  "method": "GET",
  "url": "${TARGET_BASE_URL}/orders/1001",
  "headers": {
    "accept": "application/json"
  },
  "body": null,
  "roleName": "${ROLE_VIEWER}"
}
```

## Bundle digest (`bundleSha256`)

The digest covers every bundle entry except `manifest.json`, so the manifest can carry it without a cycle:

1. For each entry, take its path relative to the bundle root (for example `requests/0001.json`) and the lowercase hex
   SHA-256 of its bytes.
2. Sort the entries by path (byte order) and write one line per entry: `<path> <sha256>` followed by `\n`.
3. The bundle digest is the lowercase hex SHA-256 of those lines, encoded as UTF-8.

The contract test recomputes this digest from the committed fixture and compares it with the manifest.

## Versioning

`REPRO_FORMAT_VERSION` is `1.0`. A change that a reader must notice (a field that changes meaning, or a new required
field) bumps the version and is recorded here. An additive, optional field keeps the version. The `formatVersion` in
`repro_artifacts` and in `pinned` must agree with the manifest.

## Storage

The bundle bytes live in the evidence object store under the tenant prefix. The `repro_artifacts` row holds the
object key (`bundle_key`), the SHA-256 of the archive, the format version, the run and finding ids, and `verified_at`
(set once, when a replay of the bundle matches its oracle). The row is write-once for the runtime role.

## Open points for later issues

- The `negativeControl` steps are copied from the replay spec, so their URL templates still name the asset host. REPRO-003
  must rewrite them to the base URL placeholder before a bundle is sanitised.
- Generation (REPRO-002), sanitisation (REPRO-003), the runner (REPRO-004) and object storage (EVIDENCE) are out of
  scope here.
