/**
 * The slice of the webpack config this file touches (Next types it as `any`).
 * @typedef {{ resolve: { extensionAlias?: Record<string, string[]> } }} WebpackConfig
 */

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  transpilePackages: ['@blackwing/ui'],
  // `pnpm typecheck` (tsc -b) and `pnpm lint` are the gates. Next's own build-time pass cannot run here: it adds
  // .next/types to a project whose rootDir is src (the repo tsconfig policy, scripts/check-tsconfig.mjs).
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // The workspace uses NodeNext-style `./x.js` specifiers for `.ts` sources.
  webpack(/** @type {WebpackConfig} */ webpackConfig) {
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return webpackConfig;
  },
};

export default config;
