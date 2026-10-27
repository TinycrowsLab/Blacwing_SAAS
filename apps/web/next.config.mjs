import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `next dev` only: the repository `.env` (written by `pnpm dev:deps`) feeds the BFF. Variables that are
// already set win; builds and deployed environments never read the file.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (process.env.NODE_ENV === 'development' && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/**
 * The slice of the webpack config and module this file touches (Next types both as `any`).
 * @typedef {{ plugins: unknown[], resolve: { extensionAlias?: Record<string, string[]> } }} WebpackConfig
 * @typedef {{ NormalModuleReplacementPlugin: new (pattern: RegExp, replacement: string) => unknown }} WebpackModule
 */

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    '@blackwing/ui',
    '@blackwing/config',
    '@blackwing/errors',
    '@blackwing/logger',
  ],
  // Keycloak redirects to the path registered in the realm (`/auth/callback`); the handler lives with
  // the other BFF routes under /api/auth.
  rewrites: () =>
    Promise.resolve([{ source: '/auth/callback', destination: '/api/auth/callback' }]),
  // The workspace uses NodeNext-style `./x.js` specifiers for `.ts` sources.
  webpack(
    /** @type {WebpackConfig} */ webpackConfig,
    /** @type {{ isServer: boolean, webpack: WebpackModule }} */ { isServer, webpack },
  ) {
    if (!isServer) {
      webpackConfig.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /^node:url$/,
          fileURLToPath(new URL('./src/lib/node-url-shim.ts', import.meta.url)),
        ),
      );
    }
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return webpackConfig;
  },
};

export default config;
