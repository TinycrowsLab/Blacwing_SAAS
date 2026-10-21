import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './select';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/Select',
  component: Select,
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Select defaultValue="critical">
      <SelectTrigger aria-label="Severity" className="w-48">
        <SelectValue placeholder="Choose severity" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Severity</SelectLabel>
          <SelectItem value="critical">Critical</SelectItem>
          <SelectItem value="high">High</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectItem value="low">Low</SelectItem>
      </SelectContent>
    </Select>
  ),
};

export const Placeholder: Story = {
  render: () => (
    <Select>
      <SelectTrigger aria-label="Severity" className="w-48">
        <SelectValue placeholder="Choose severity" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="low">Low</SelectItem>
      </SelectContent>
    </Select>
  ),
};
