import { createElement } from 'react';

import type { Decorator, Preview } from '@storybook/react-vite';

import '../src/styles/index.css';

/**
 * Token scope: tokens.css only redefines colours under `.dark`, so the theme must be a class on a
 * subtree root (never a background colour alone). The toolbar toggles that class on the story root.
 * Written without JSX so this folder stays on the base TypeScript options (see tsconfig.json).
 */
const withTheme: Decorator = (Story, context) => {
  const dark = context.globals.theme === 'dark';
  return createElement(
    'div',
    { className: `${dark ? 'dark ' : ''}min-h-full bg-background p-6 text-foreground` },
    createElement(Story),
  );
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: 'Colour theme (token set)',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light' },
  parameters: {
    layout: 'centered',
  },
};

export default preview;
