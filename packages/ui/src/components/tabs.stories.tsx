import { expect, screen, userEvent } from 'storybook/test';

import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/Tabs',
  component: Tabs,
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="findings" className="w-96">
      <TabsList>
        <TabsTrigger value="findings">Findings</TabsTrigger>
        <TabsTrigger value="runs">Runs</TabsTrigger>
      </TabsList>
      <TabsContent value="findings">Three open findings.</TabsContent>
      <TabsContent value="runs">Two runs in progress.</TabsContent>
    </Tabs>
  ),
  /** Interaction: selecting a tab marks it active and shows its panel. */
  play: async () => {
    await expect(screen.getByRole('tab', { name: 'Findings' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    await expect(screen.getByRole('tab', { name: 'Runs' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await expect(screen.getByText('Two runs in progress.')).toBeTruthy();
  },
};
