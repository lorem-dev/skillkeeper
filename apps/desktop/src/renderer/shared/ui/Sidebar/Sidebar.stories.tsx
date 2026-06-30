import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Sidebar } from './Sidebar';
import { SidebarItem } from './SidebarItem';
import { Icon } from '../Icon';

const meta = {
  title: 'shared/ui/Sidebar',
  component: Sidebar,
  args: { title: 'SkillKeeper', children: null },
} satisfies Meta<typeof Sidebar>;

export default meta;

type Story = StoryObj<typeof meta>;

const ITEMS = [
  { id: 'repositories', label: 'Repositories', icon: 'repositories' },
  { id: 'skills', label: 'Skills', icon: 'skills' },
  { id: 'projects', label: 'Projects', icon: 'projects' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
] as const;

export const Default: Story = {
  render: () => {
    const [active, setActive] = useState<string>('repositories');
    return (
      <div style={{ height: 360, display: 'flex' }}>
        <Sidebar title="SkillKeeper">
          {ITEMS.map((item) => (
            <SidebarItem
              key={item.id}
              icon={<Icon name={item.icon} />}
              active={active === item.id}
              onClick={() => setActive(item.id)}
            >
              {item.label}
            </SidebarItem>
          ))}
        </Sidebar>
      </div>
    );
  },
};
