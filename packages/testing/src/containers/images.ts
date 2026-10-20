/**
 * Container images for the Testcontainers helpers, pinned by digest so a run never silently floats
 * (the same rule §8.9 applies to product runs). The tag is kept for readability; the digest is what
 * Docker resolves.
 *
 * DEVENV (#156, #160) pins the dev compose stack; both must use these same references so CI, tests and
 * `pnpm dev:deps` agree. When bumping one, bump the other in the same change.
 *
 * MinIO: upstream stopped publishing `minio/minio` images to Docker Hub, so the image is Chainguard's
 * source build of upstream MinIO (AGPLv3, used unmodified as a separate dev/test service only).
 */
export const TEST_IMAGES = Object.freeze({
  /** PostgreSQL 16 with pgvector (pgcrypto ships with Postgres contrib). §5 DB. */
  postgres:
    'pgvector/pgvector:0.8.1-pg16@sha256:33198da2828a14c30348d2ccb4750833d5ed9a44c88d840a0e523d7417120337',
  /** Valkey 8 (Redis-compatible, BSD). §5 queue/cache. */
  valkey:
    'valkey/valkey:8.1.4-alpine@sha256:e706d1213aaba6896c162bb6a3a9e1894e1a435f28f8f856d14fab2e10aa098b',
  /** MinIO with object locking (dev/test stand-in for S3 Object Lock). §5 object storage. */
  minio:
    'cgr.dev/chainguard/minio:latest@sha256:cff197fef764642223ef9f4444c903d51aee9b544a7be8bc007fef6b7b00d136',
  /** Neo4j 5 Community (LTS line). §5 graph. */
  neo4j:
    'neo4j:5.26.12-community@sha256:9f75e8df4325a24f00fdd7a8c0bcce650a58375049b1058e496e8b43d6c36b37',
});

export type TestImageName = keyof typeof TEST_IMAGES;

const DIGEST_PIN = /^[a-z0-9./:_-]+@sha256:[0-9a-f]{64}$/;

/** True when an image reference is pinned by a sha256 digest. */
export function isDigestPinned(reference: string): boolean {
  return DIGEST_PIN.test(reference);
}
