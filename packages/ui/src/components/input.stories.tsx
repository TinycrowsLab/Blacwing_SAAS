import { Input } from './input';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/Input',
  component: Input,
  args: { placeholder: 'Work e-mail', 'aria-label': 'Work e-mail' },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Invalid: Story = {
  args: { 'aria-invalid': true, defaultValue: 'not-an-email' },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'locked@example.com' },
};
