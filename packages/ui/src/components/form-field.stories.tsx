import { FormField } from './form-field';
import { Input } from './input';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/FormField',
  component: FormField,
  args: {
    label: 'Work e-mail',
    children: (control) => <Input {...control} />,
  },
} satisfies Meta<typeof FormField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithDescription: Story = {
  args: { description: 'Used for the account owner notice.' },
};

export const WithError: Story = {
  args: {
    error: 'Enter a valid work e-mail.',
    children: (control) => <Input {...control} defaultValue="nope" />,
  },
};
