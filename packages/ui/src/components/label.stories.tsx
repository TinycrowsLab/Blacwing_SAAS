import { Input } from './input';
import { Label } from './label';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/Label',
  component: Label,
  args: { children: 'Asset name' },
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <div className="grid gap-1.5">
      <Label htmlFor="asset-name" {...args} />
      <Input id="asset-name" />
    </div>
  ),
};
