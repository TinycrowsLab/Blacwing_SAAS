import { ModeToggle } from './mode-toggle';
import { ThemeProvider } from './theme-provider';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/ThemeProvider',
  component: ThemeProvider,
} satisfies Meta<typeof ThemeProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithToggle: Story = {
  render: () => (
    <ThemeProvider>
      <ModeToggle />
    </ThemeProvider>
  ),
};
