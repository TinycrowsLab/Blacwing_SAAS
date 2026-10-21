import { expect, screen, userEvent } from 'storybook/test';

import { Button } from './button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/Tooltip',
  component: Tooltip,
  decorators: [
    (Story) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Kill switch help">
          ?
        </Button>
      </TooltipTrigger>
      <TooltipContent>Stops every running sandbox for this tenant.</TooltipContent>
    </Tooltip>
  ),
  /** Interaction: hovering the trigger shows the tip; it is announced with role=tooltip. */
  play: async () => {
    await userEvent.hover(screen.getByRole('button', { name: 'Kill switch help' }));
    await expect(await screen.findByRole('tooltip')).toBeTruthy();
  },
};
