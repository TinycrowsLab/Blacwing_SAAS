import { expect, screen, userEvent } from 'storybook/test';

import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/DropdownMenu',
  component: DropdownMenu,
} satisfies Meta<typeof DropdownMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Finding</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem>Rename</DropdownMenuItem>
          <DropdownMenuItem>Duplicate</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>Archive</DropdownMenuItem>
        <DropdownMenuItem>Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
  /**
   * Interaction: keyboard navigation moves focus through the enabled items (disabled items are
   * skipped), End jumps to the last item, and Escape closes the menu and returns focus to the trigger.
   */
  play: async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    await expect(await screen.findByRole('menu')).toBeTruthy();

    await userEvent.keyboard('{ArrowDown}');
    await expect(document.activeElement?.textContent).toBe('Rename');
    await userEvent.keyboard('{ArrowDown}');
    await expect(document.activeElement?.textContent).toBe('Duplicate');
    await userEvent.keyboard('{ArrowDown}');
    await expect(document.activeElement?.textContent).toBe('Delete');
    await userEvent.keyboard('{ArrowUp}');
    await expect(document.activeElement?.textContent).toBe('Duplicate');
    await userEvent.keyboard('{End}');
    await expect(document.activeElement?.textContent).toBe('Delete');

    await userEvent.keyboard('{Escape}');
    await expect(screen.queryByRole('menu')).toBeNull();
    await expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions' }));
  },
};
