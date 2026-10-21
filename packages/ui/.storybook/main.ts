import tailwindcss from '@tailwindcss/vite';

import type { StorybookConfig } from '@storybook/react-vite';

/**
 * Storybook for the design-system kit (issue #271, epic CONSOLE, F29). Stories live next to the
 * primitives in `src/components`; this config only wires the framework, the a11y addon and the
 * Tailwind 4 Vite plugin the kit's token CSS needs.
 */
const config: StorybookConfig = {
  stories: ['../src/components/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  framework: { name: '@storybook/react-vite', options: {} },
  viteFinal: (viteConfig) => ({
    ...viteConfig,
    plugins: [...(viteConfig.plugins ?? []), tailwindcss()],
  }),
};

export default config;
