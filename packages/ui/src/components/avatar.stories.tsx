import { Avatar, AvatarFallback, AvatarImage } from './avatar';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/Avatar',
  component: Avatar,
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithFallback: Story = {
  render: () => (
    <Avatar>
      <AvatarImage alt="Ada Lovelace" src="/does-not-exist.png" />
      <AvatarFallback>AL</AvatarFallback>
    </Avatar>
  ),
};
