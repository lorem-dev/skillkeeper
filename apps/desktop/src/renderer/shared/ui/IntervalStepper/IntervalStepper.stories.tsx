import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { IntervalStepper } from './IntervalStepper';

const meta = {
  title: 'shared/ui/IntervalStepper',
  component: IntervalStepper,
  args: { minutes: 60, onChange: () => {} },
} satisfies Meta<typeof IntervalStepper>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Hours: Story = {
  render: () => {
    const [minutes, setMinutes] = useState(12 * 60);
    return <IntervalStepper minutes={minutes} onChange={setMinutes} label="Interval" />;
  },
};

export const Minutes: Story = {
  render: () => {
    const [minutes, setMinutes] = useState(1);
    return <IntervalStepper minutes={minutes} onChange={setMinutes} label="Interval" />;
  },
};
