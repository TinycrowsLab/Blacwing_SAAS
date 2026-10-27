// Public (browser-visible) console configuration. Next.js inlines `NEXT_PUBLIC_*` only when the
// variable is read as a literal `process.env.NAME`, so each key is read explicitly here.

/** Base path of the REST API as the browser reaches it (same origin, behind the BFF proxy). */
export const DEFAULT_API_BASE_URL = '/v1';
/** Path of the GraphQL endpoint as the browser reaches it. */
export const DEFAULT_GRAPHQL_URL = '/graphql';

export interface PublicConfig {
  readonly apiBaseUrl: string;
  readonly graphqlUrl: string;
}

function valueOrDefault(value: string | undefined, fallback: string): string {
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

/** Resolves the public config from `NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_GRAPHQL_URL`. */
export function getPublicConfig(): PublicConfig {
  return {
    apiBaseUrl: valueOrDefault(process.env.NEXT_PUBLIC_API_BASE_URL, DEFAULT_API_BASE_URL),
    graphqlUrl: valueOrDefault(process.env.NEXT_PUBLIC_GRAPHQL_URL, DEFAULT_GRAPHQL_URL),
  };
}

/** Poll interval of the run detail page while the live stream is down. */
export const DEFAULT_RUN_POLL_MS = 15_000;

/** `NEXT_PUBLIC_RUN_POLL_MS` when it is a positive integer, else {@link DEFAULT_RUN_POLL_MS}. */
export function getRunPollMs(): number {
  const parsed = Number(process.env.NEXT_PUBLIC_RUN_POLL_MS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RUN_POLL_MS;
}

/** True for `next build`/`next start`; the GraphQL client falls back to full documents only outside it. */
export function isProductionBuild(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Whether GraphQL requests send a persisted-query hash instead of the document (CONTEXT_PACK §9).
 * `NEXT_PUBLIC_GRAPHQL_PERSISTED` wins when set (only the literal `true` enables it); otherwise it is on in production.
 */
export function isGraphQLPersisted(): boolean {
  const value = process.env.NEXT_PUBLIC_GRAPHQL_PERSISTED;
  if (value === undefined || value.trim() === '') return isProductionBuild();
  return value.trim().toLowerCase() === 'true';
}
