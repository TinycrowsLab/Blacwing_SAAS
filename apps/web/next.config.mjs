import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@blackwing/ui'],
  // The workspace uses NodeNext-style `./x.js` specifiers for `.ts` sources.
  webpack(webpackConfig, { isServer, webpack }) {
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
