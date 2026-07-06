import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Combobox } from './Combobox';

const meta = {
  title: 'shared/ui/Combobox',
  component: Combobox,
  args: { options: [], value: '', onChange: () => {} },
} satisfies Meta<typeof Combobox>;

export default meta;

type Story = StoryObj<typeof meta>;

const branches = [
  { value: 'main', label: 'main' },
  { value: 'develop', label: 'develop' },
  { value: 'release/2.0', label: 'release/2.0' },
  { value: 'feature/combobox', label: 'feature/combobox' },
  { value: 'feature/terminal', label: 'feature/terminal' },
  { value: 'hotfix/login', label: 'hotfix/login' },
];

export const Default: Story = {
  render: () => {
    const [value, setValue] = useState('main');
    return (
      <Combobox
        label="Branch"
        options={branches}
        value={value}
        onChange={setValue}
        placeholder="Search branches"
        emptyText="No matching branch"
      />
    );
  },
};

export const NoLabel: Story = {
  render: () => {
    const [value, setValue] = useState('develop');
    return <Combobox options={branches} value={value} onChange={setValue} placeholder="Search branches" />;
  },
};

export const Empty: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return (
      <Combobox
        label="Branch"
        options={branches}
        value={value}
        onChange={setValue}
        placeholder="Search branches"
        emptyText="No matching branch"
      />
    );
  },
};

export const Disabled: Story = {
  render: () => <Combobox label="Branch" options={branches} value="main" onChange={() => {}} disabled />,
};
