import {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from './toast';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/Toast',
  component: Toast,
  decorators: [
    (Story) => (
      <ToastProvider>
        <Story />
        <ToastViewport />
      </ToastProvider>
    ),
  ],
} satisfies Meta<typeof Toast>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Long duration keeps the toast on screen for review; Radix still closes it on Escape or Close. */
const duration = 100_000;

export const Default: Story = {
  render: () => (
    <Toast defaultOpen duration={duration}>
      <div className="grid gap-1">
        <ToastTitle>Report exported</ToastTitle>
        <ToastDescription>The PDF is ready to download.</ToastDescription>
      </div>
      <ToastAction altText="Open report">Open</ToastAction>
      <ToastClose />
    </Toast>
  ),
};

export const Success: Story = {
  render: () => (
    <Toast defaultOpen duration={duration} variant="success">
      <ToastTitle>Approval recorded</ToastTitle>
      <ToastClose />
    </Toast>
  ),
};

export const Destructive: Story = {
  render: () => (
    <Toast defaultOpen duration={duration} variant="destructive">
      <ToastTitle>Run killed</ToastTitle>
      <ToastDescription>Egress was blocked before the sandbox stopped.</ToastDescription>
      <ToastClose />
    </Toast>
  ),
};
