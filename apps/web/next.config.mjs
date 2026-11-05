import { existsSync } from 'node:fs';

/**
 * Old URLs and their new homes (experience spec §2). Each pair is checked against the source tree at build time:
 * once the new page exists, the old URL redirects to it permanently. Until then the new URL is sent to the old page
 * (temporary), so the sidebar's links work while the pages are being moved.
 * shortcut: the reverse half exists only for the move; drop it once every destination below exists.
 * @type {readonly { from: string, to: string, page: string, back?: string | undefined }[]}
 */
const MOVES = [
  { from: '/assets', to: '/targets', page: 'targets' },
  { from: '/audit', to: '/ledger', page: 'ledger' },
  { from: '/about', to: '/help', page: 'help' },
  { from: '/requests/new', to: '/audits/new', page: 'audits/new' },
  { from: '/requests/:id', to: '/audits/:id', page: 'audits/[id]' },
  { from: '/approvals', to: '/decisions', page: 'decisions', back: '/' },
  { from: '/approvals/gate2/:id', to: '/decisions/gate2/:id', page: 'decisions/gate2/[id]' },
  // No old page: until Settings exists its link goes Home.
  { from: '/settings', to: '/settings', page: 'settings', back: '/' },
];

const pageExists = (/** @type {string} */ page) =>
  existsSync(new URL(`./src/app/(console)/${page}/page.tsx`, import.meta.url));

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
  // Revisits and back/forward render from the client router cache at once (bug 15).
  experimental: { staleTimes: { dynamic: 30, static: 180 } },
  redirects() {
    return Promise.resolve(
      MOVES.flatMap((m) => {
        if (pageExists(m.page)) return m.from === m.to ? [] : [{ source: m.from, destination: m.to, permanent: true }];
        return [{ source: m.to, destination: m.back ?? m.from, permanent: false }];
      }),
    );
  },
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
