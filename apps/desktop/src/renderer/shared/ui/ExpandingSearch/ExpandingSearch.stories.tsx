import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ExpandingSearch } from './ExpandingSearch';

const meta = {
  title: 'shared/ui/ExpandingSearch',
  component: ExpandingSearch,
} satisfies Meta<typeof ExpandingSearch>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Collapsed round button -> click or focus to expand; clears + blurs to
 *  collapse. The wrapper gives the toolbar-like row some breathing room. */
export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', width: 320 }}>
        <ExpandingSearch
          label="Search"
          placeholder="Search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onClear={() => setValue('')}
        />
      </div>
    );
  },
};

/** Starts expanded (the field state). */
export const Expanded: Story = {
  render: () => {
    const [value, setValue] = useState('formatter');
    return (
      <div style={{ width: 320 }}>
        <ExpandingSearch
          label="Search"
          placeholder="Search"
          defaultExpanded
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onClear={() => setValue('')}
        />
      </div>
    );
  },
};

/** The frosted glass treatment, shown expanded over a tinted panel so the
 *  refraction + rim read. */
export const Glass: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          width: 360,
          padding: 24,
          borderRadius: 16,
          background: 'linear-gradient(120deg, #3b82f6, #8b5cf6)',
        }}
      >
        <ExpandingSearch
          glass
          defaultExpanded
          label="Search"
          placeholder="Search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onClear={() => setValue('')}
        />
      </div>
    );
  },
};
