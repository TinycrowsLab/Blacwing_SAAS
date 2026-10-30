// Ambient types for the k6 runtime (PERF-001, #320). k6 provides these modules and globals at run time; they are
// declared here so the harness type-checks and lints without the k6 sources.

declare module 'k6' {
  export function check<T>(value: T, checks: Record<string, (value: T) => boolean>): boolean;
}

declare module 'k6/http' {
  export interface RequestParams {
    headers?: Record<string, string>;
    tags?: Record<string, string>;
  }
  export interface Response {
    readonly status: number;
    readonly body: string | null;
  }
  const http: {
    get(url: string, params?: RequestParams): Response;
  };
  export default http;
}

/** k6's environment object: the process environment passed with `-e` or the shell. */
declare const __ENV: Record<string, string | undefined>;
