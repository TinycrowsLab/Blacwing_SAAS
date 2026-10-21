import { Separator } from './separator';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/Separator',
  component: Separator,
} satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  render: (args) => (
    <div className="w-64">
      <p className="text-sm">Assets</p>
      <Separator className="my-2" {...args} />
      <p className="text-sm">Runs</p>
    </div>
  ),
};

export const Vertical: Story = {
  args: { orientation: 'vertical' },
  render: (args) => (
    <div className="flex h-6 items-center gap-2 text-sm">
      <span>Assets</span>
      <Separator {...args} />
      <span>Runs</span>
    </div>
  ),
};
