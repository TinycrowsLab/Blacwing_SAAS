// Minimal typings for the one semantic-release plugin scripts/release.mjs calls directly.
declare module '@semantic-release/commit-analyzer' {
  export function analyzeCommits(
    pluginConfig: object,
    context: {
      cwd: string;
      commits: { hash: string; message: string }[];
      logger: { log: (...args: unknown[]) => void };
    },
  ): Promise<string | null | undefined>;
}
