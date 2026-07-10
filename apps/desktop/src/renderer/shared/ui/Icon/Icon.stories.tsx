import type { Meta, StoryObj } from '@storybook/react';
import { Icon, ICON_NAMES } from './Icon';

const meta = {
  title: 'shared/ui/Icon',
  component: Icon,
  args: { name: 'settings', size: 24 },
} satisfies Meta<typeof Icon>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Single: Story = {};

// Every icon name, sourced from `ICON_NAMES` (derived from the `IconName`
// union in Icon.tsx) so the gallery can never drift behind a newly added icon.
export const Gallery: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', color: 'var(--sk-color-label)' }}>
      {ICON_NAMES.map((name) => (
        <div key={name} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <Icon name={name} size={24} />
          <span style={{ fontSize: 11, color: 'var(--sk-color-label-2)' }}>{name}</span>
        </div>
      ))}
    </div>
  ),
};
