import { fileURLToPath } from 'node:url';

/**
 * The slice of the webpack config and module this file touches (Next types both as `any`).
 * @typedef {{ plugins: unknown[], resolve: { extensionAlias?: Record<string, string[]> } }} WebpackConfig
 * @typedef {{ NormalModuleReplacementPlugin: new (pattern: RegExp, replacement: string) => unknown }} WebpackModule
 */

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@blackwing/ui'],
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
