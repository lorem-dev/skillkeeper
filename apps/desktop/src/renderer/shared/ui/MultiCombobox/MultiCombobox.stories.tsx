import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { MultiCombobox } from './MultiCombobox';
import { Icon } from '../Icon';

const meta = {
  title: 'shared/ui/MultiCombobox',
  component: MultiCombobox,
  args: { options: [], value: [], onChange: () => {} },
} satisfies Meta<typeof MultiCombobox>;

export default meta;

type Story = StoryObj<typeof meta>;

const repos = [
  { value: 'repo-1', label: 'Team Skills' },
  { value: 'repo-2', label: 'MCP Presets' },
  { value: 'repo-3', label: 'Personal Sandbox' },
];

export const Default: Story = {
  render: () => {
    const [value, setValue] = useState<string[]>(['repo-1']);
    return (
      <MultiCombobox
        label="Repositories"
        options={repos}
        value={value}
        onChange={setValue}
        placeholder="All repositories"
        emptyText="No matching repository"
      />
    );
  },
};

// Each option carries a leading icon (e.g. a per-project glyph) -- rendered
// before the label in the dropdown row. The idle summary stays plain text
// (it is the value of a native <input>), so icons only show while open.
const projects = [
  { value: 'project-1', label: 'Acme App', icon: <Icon name="projects" size={18} /> },
  { value: 'project-2', label: 'Beta Service', icon: <Icon name="projects" size={18} /> },
  { value: 'project-3', label: 'Gamma Tool', icon: <Icon name="projects" size={18} /> },
];

export const WithIcons: Story = {
  render: () => {
    const [value, setValue] = useState<string[]>(['project-1', 'project-3']);
    return (
      <MultiCombobox
        label="Projects"
        options={projects}
        value={value}
        onChange={setValue}
        placeholder="All projects"
        emptyText="No matching project"
      />
    );
  },
};

export const Empty: Story = {
  render: () => {
    const [value, setValue] = useState<string[]>([]);
    return (
      <MultiCombobox
        label="Repositories"
        options={repos}
        value={value}
        onChange={setValue}
        placeholder="All repositories"
        emptyText="No matching repository"
      />
    );
  },
};

export const Disabled: Story = {
  render: () => (
    <MultiCombobox label="Repositories" options={repos} value={['repo-1']} onChange={() => {}} disabled />
  ),
};
