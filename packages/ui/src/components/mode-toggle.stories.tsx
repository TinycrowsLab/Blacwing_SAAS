import { ModeToggle } from './mode-toggle';
import { ThemeProvider } from './theme-provider';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/ModeToggle',
  component: ModeToggle,
  decorators: [
    (Story) => (
      <ThemeProvider>
        <Story />
      </ThemeProvider>
    ),
  ],
} satisfies Meta<typeof ModeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
