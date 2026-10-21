import { expect, screen, userEvent } from 'storybook/test';

import { Button } from './button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/Dialog',
  component: Dialog,
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const revokeDialog = (
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Revoke access?</DialogTitle>
      <DialogDescription>The member loses access to this workspace immediately.</DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <DialogClose asChild>
        <Button variant="secondary">Cancel</Button>
      </DialogClose>
      <Button variant="destructive">Revoke</Button>
    </DialogFooter>
  </DialogContent>
);

export const Closed: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Revoke access</Button>
      </DialogTrigger>
      {revokeDialog}
    </Dialog>
  ),
};

export const Open: Story = {
  render: () => <Dialog defaultOpen>{revokeDialog}</Dialog>,
};

/** Interaction: opens from the trigger, closes on Escape, re-opens and closes via the Cancel button. */
export const OpenAndClose: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Revoke access</Button>
      </DialogTrigger>
      {revokeDialog}
    </Dialog>
  ),
  play: async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    await expect(await screen.findByRole('dialog', { name: 'Revoke access?' })).toBeTruthy();

    await userEvent.keyboard('{Escape}');
    await expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    await expect(await screen.findByRole('dialog')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(screen.queryByRole('dialog')).toBeNull();
  },
};
