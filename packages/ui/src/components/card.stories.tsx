import { Button } from './button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Primitives/Card',
  component: Card,
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Card className="w-80">
      <CardHeader>
        <CardTitle>Authorisation</CardTitle>
        <CardDescription>Expires in 12 days.</CardDescription>
      </CardHeader>
      <CardContent>Scope covers two verified assets.</CardContent>
      <CardFooter>
        <Button size="sm">Renew</Button>
      </CardFooter>
    </Card>
  ),
};
