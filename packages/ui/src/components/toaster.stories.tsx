import { useEffect, type ReactNode } from 'react';

import { Toaster, toast } from './toaster';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/Toaster',
  component: Toaster,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shows one success and one error toast once mounted, so the stack and trace id are visible. */
function SeededToasts(): ReactNode {
  useEffect(() => {
    toast.success({ title: 'Changes saved' });
    toast.error({
      title: 'Could not save',
      description: 'Check your connection and try again.',
      traceId: 'trc_9f2a',
    });
  }, []);
  return <Toaster />;
}

export const Default: Story = {
  render: () => <SeededToasts />,
};
