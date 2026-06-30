import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { SearchField } from './SearchField';

const meta = {
  title: 'shared/ui/SearchField',
  component: SearchField,
} satisfies Meta<typeof SearchField>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return (
      <div style={{ width: 280 }}>
        <SearchField
          placeholder="Search skills"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onClear={() => setValue('')}
        />
      </div>
    );
  },
};
