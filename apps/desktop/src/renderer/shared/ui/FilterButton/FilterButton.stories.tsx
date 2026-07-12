import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { FilterButton } from './FilterButton';

const meta = {
  title: 'shared/ui/FilterButton',
  component: FilterButton,
} satisfies Meta<typeof FilterButton>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Toggles when empty; the badge appears and a click clears once filters are
 *  active. Drive the count with the two buttons to see both states. */
export const Interactive: Story = {
  args: {
    count: 0,
    open: false,
    onToggle: () => {},
    onClear: () => {},
    filterLabel: 'Filter',
    clearLabel: 'Clear filters',
  },
  render: () => {
    const [open, setOpen] = useState(false);
    const [count, setCount] = useState(0);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: 24 }}>
        <FilterButton
          count={count}
          open={open}
          onToggle={() => setOpen((o) => !o)}
          onClear={() => {
            setCount(0);
            setOpen(false);
          }}
          filterLabel="Filter"
          clearLabel="Clear filters"
        />
        <button type="button" onClick={() => setCount((c) => c + 1)}>
          add filter
        </button>
        <span style={{ fontSize: 13 }}>
          count: {count} - open: {String(open)}
        </span>
      </div>
    );
  },
};

/** With active filters: the count badge shows and the button clears on click. */
export const WithCount: Story = {
  args: {
    count: 2,
    open: true,
    onToggle: () => {},
    onClear: () => {},
    filterLabel: 'Filter',
    clearLabel: 'Clear filters',
  },
};
