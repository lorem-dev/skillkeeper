import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { RadioGroup } from './RadioGroup';

const meta = {
  title: 'shared/ui/RadioGroup',
  component: RadioGroup,
  // Required props satisfied here; the stateful render below drives the group.
  args: { name: 'consent', value: 'always', options: [], onChange: () => {} },
} satisfies Meta<typeof RadioGroup>;

export default meta;

type Story = StoryObj<typeof meta>;

const options = [
  { value: 'always', label: 'Always ask' },
  { value: 'project', label: 'Per project' },
  { value: 'never', label: 'Never' },
];

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState('always');
    return (
      <RadioGroup
        name="consent"
        label="Hook consent"
        options={options}
        value={value}
        onChange={setValue}
      />
    );
  },
};
