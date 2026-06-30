import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Stepper } from './Stepper';

const meta = {
  title: 'shared/ui/Stepper',
  component: Stepper,
  // Required props satisfied here; the stateful render below drives the value.
  args: { value: 0, onChange: () => {} },
} satisfies Meta<typeof Stepper>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState(2);
    return <Stepper label="Retries" value={value} onChange={setValue} min={0} max={9} />;
  },
};
