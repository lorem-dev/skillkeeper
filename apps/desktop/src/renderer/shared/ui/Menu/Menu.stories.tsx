import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Menu } from './Menu';
import type { MenuItem } from './Menu';
import { Button } from '../Button';

const meta = {
  title: 'shared/ui/Menu',
  component: Menu,
  // Required props satisfied here; each story drives open state via its render.
  args: { open: false, onClose: () => {}, anchorRef: { current: null }, items: [] },
} satisfies Meta<typeof Menu>;

export default meta;

type Story = StoryObj<typeof meta>;

// A button anchor that toggles the menu. `build` maps labels to MenuItems given
// the story's select behaviour.
function Demo({
  closeOnSelect,
  items,
  label,
}: {
  readonly closeOnSelect?: boolean;
  readonly items: readonly MenuItem[];
  readonly label: string;
}) {
  // Button does not forward a ref, so anchor the menu to a wrapping span.
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: 40 }}>
      <span ref={anchorRef} style={{ display: 'inline-flex' }}>
        <Button onClick={() => setOpen((v) => !v)}>{label}</Button>
      </span>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        items={items}
        closeOnSelect={closeOnSelect}
        ariaLabel={label}
      />
    </div>
  );
}

const cities = ['Chicago', 'Cupertino', 'New York', 'San Francisco'];

export const SingleSelect: Story = {
  render: () => {
    const [value, setValue] = useState('New York');
    return (
      <Demo
        label={`City: ${value}`}
        items={cities.map((c) => ({ id: c, label: c, selected: c === value, onSelect: () => setValue(c) }))}
      />
    );
  },
};

export const MultiSelect: Story = {
  render: () => {
    const [on, setOn] = useState<string[]>(['Chicago', 'New York']);
    const toggle = (c: string): void =>
      setOn((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
    return (
      <Demo
        closeOnSelect={false}
        label={`${on.length} selected`}
        items={cities.map((c) => ({ id: c, label: c, selected: on.includes(c), onSelect: () => toggle(c) }))}
      />
    );
  },
};

export const Actions: Story = {
  render: () => (
    <Demo
      label="Actions"
      items={[
        { id: 'cut', label: 'Cut', onSelect: () => {} },
        { id: 'copy', label: 'Copy', onSelect: () => {} },
        { id: 'paste', label: 'Paste', disabled: true, onSelect: () => {} },
      ]}
    />
  ),
};

export const Listbox: Story = {
  render: () => {
    const [value, setValue] = useState('New York');
    const anchorRef = useRef<HTMLSpanElement>(null);
    const [open, setOpen] = useState(false);
    return (
      <div style={{ padding: 40 }}>
        <span ref={anchorRef} style={{ display: 'inline-flex' }}>
          <Button onClick={() => setOpen((v) => !v)}>{`City: ${value}`}</Button>
        </span>
        <Menu
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={anchorRef}
          role="listbox"
          ariaLabel="City"
          items={cities.map((c) => ({ id: c, label: c, selected: c === value, onSelect: () => setValue(c) }))}
        />
      </div>
    );
  },
};

export const LongScrolling: Story = {
  render: () => {
    const anchorRef = useRef<HTMLSpanElement>(null);
    const [open, setOpen] = useState(false);
    const many = Array.from({ length: 40 }, (_, i) => `Item ${i + 1}`);
    return (
      <div style={{ padding: 40 }}>
        <span ref={anchorRef} style={{ display: 'inline-flex' }}>
          <Button onClick={() => setOpen((v) => !v)}>Long list</Button>
        </span>
        <Menu
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={anchorRef}
          role="listbox"
          ariaLabel="Long list"
          items={many.map((m) => ({ id: m, label: m, selected: false, onSelect: () => {} }))}
        />
      </div>
    );
  },
};
