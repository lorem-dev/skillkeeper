import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TextField } from './TextField';

const meta = {
  title: 'shared/ui/TextField',
  component: TextField,
} satisfies Meta<typeof TextField>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return (
      <TextField
        label="Repository URL"
        placeholder="git@github.com:org/skills.git"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    );
  },
};

export const Invalid: Story = {
  render: () => {
    const [value, setValue] = useState('not-a-url');
    return (
      <TextField
        label="Repository URL"
        invalid
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    );
  },
};

export const NoLabel: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return <TextField placeholder="Search skills" value={value} onChange={(e) => setValue(e.target.value)} />;
  },
};
