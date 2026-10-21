/**
 * Tailwind 4 preset for Blackwing apps. Tokens live in CSS (styles/tokens.css) and are mapped to
 * utilities by `@theme` (styles/theme.css), so this module is the single place that names the
 * entry points an app must import. Tailwind 4 has no JS theme config: do not add one.
 */
export const tailwindPreset = {
  /** Import once from the app's global stylesheet: `@import '@blackwing/ui/styles.css';`. */
  stylesheet: '@blackwing/ui/styles.css',
  /** Tokens only (no Tailwind import) for apps that bring their own Tailwind entry. */
  tokens: '@blackwing/ui/tokens.css',
  /** Source glob Tailwind must scan so kit classes are generated: `@source` in the app CSS. */
  source: '../../packages/ui/src/**/*.{ts,tsx}',
  darkSelector: '.dark',
} as const;
