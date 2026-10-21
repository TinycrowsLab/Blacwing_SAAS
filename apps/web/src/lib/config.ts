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
