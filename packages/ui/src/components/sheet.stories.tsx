import { expect, screen, userEvent } from 'storybook/test';

import { Button } from './button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './sheet';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/Sheet',
  component: Sheet,
} satisfies Meta<typeof Sheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Right: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">Open filters</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Filters</SheetTitle>
          <SheetDescription>Narrow the findings list.</SheetDescription>
        </SheetHeader>
        <SheetFooter>
          <Button>Apply</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
  /** Interaction: the sheet opens from its trigger and closes on Escape. */
  play: async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Open filters' }));
    await expect(await screen.findByRole('dialog', { name: 'Filters' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await expect(screen.queryByRole('dialog')).toBeNull();
  },
};

export const Bottom: Story = {
  render: () => (
    <Sheet defaultOpen>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Bottom sheet</SheetTitle>
          <SheetDescription>Anchored to the bottom edge.</SheetDescription>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  ),
};
