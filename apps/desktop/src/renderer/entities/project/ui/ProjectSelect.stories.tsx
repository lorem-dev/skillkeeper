import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ProjectSelect } from './ProjectSelect';

const meta = {
  title: 'entities/ProjectSelect',
  component: ProjectSelect,
  args: { projects: [], value: '', onChange: () => {} },
} satisfies Meta<typeof ProjectSelect>;

export default meta;

type Story = StoryObj<typeof meta>;

const projects = [
  { id: 'p1', path: '/Users/dev/projects/acme-api', name: 'acme-api', addedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'p2', path: '/Users/dev/projects/acme-web', name: 'acme-web', addedAt: '2026-01-02T00:00:00.000Z' },
  { id: 'p3', path: '/Users/dev/projects/my-cool-project', name: 'My Cool Project', addedAt: '2026-01-03T00:00:00.000Z' },
];

export const Default: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return (
      <ProjectSelect
        projects={projects}
        value={value}
        onChange={setValue}
        placeholder="Choose a project"
        ariaLabel="Project"
        emptyText="No matching project"
      />
    );
  },
};

export const Selected: Story = {
  render: () => {
    const [value, setValue] = useState('p3');
    return (
      <ProjectSelect
        projects={projects}
        value={value}
        onChange={setValue}
        placeholder="Choose a project"
        ariaLabel="Project"
        emptyText="No matching project"
      />
    );
  },
};

// A project with its own icon (a data URL) resolved by the Rust backend.
export const WithProjectIcon: Story = {
  render: () => {
    const [value, setValue] = useState('p1');
    return (
      <ProjectSelect
        projects={projects}
        projectInfo={{
          p1: {
            skillCount: 5,
            fromReposCount: 3,
            agentCount: 2,
            iconDataUrl:
              'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="18" height="18"%3E%3Crect width="18" height="18" fill="%234a90d9"/%3E%3C/svg%3E',
          },
        }}
        value={value}
        onChange={setValue}
        placeholder="Choose a project"
        ariaLabel="Project"
        emptyText="No matching project"
      />
    );
  },
};

export const Empty: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return (
      <ProjectSelect
        projects={[]}
        value={value}
        onChange={setValue}
        placeholder="Choose a project"
        ariaLabel="Project"
        emptyText="No matching project"
      />
    );
  },
};

export const Disabled: Story = {
  render: () => (
    <ProjectSelect
      projects={projects}
      value="p2"
      onChange={() => {}}
      placeholder="Choose a project"
      ariaLabel="Project"
      disabled
    />
  ),
};
