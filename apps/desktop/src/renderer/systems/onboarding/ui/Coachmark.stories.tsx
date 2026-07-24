import type { Meta, StoryObj } from '@storybook/react';
import { Coachmark } from './Coachmark';

const meta: Meta<typeof Coachmark> = {
  title: 'systems/onboarding/Coachmark',
  component: Coachmark,
};
export default meta;
type Story = StoryObj<typeof Coachmark>;

const FAKE_RECT = { bottom: 120, left: 80, top: 90, width: 160, height: 32 } as DOMRect;

export const Default: Story = {
  render: () => (
    <Coachmark
      rect={FAKE_RECT}
      title="Install a skill"
      body="Pick a skill from the catalog and install it into your agent of choice."
      onNext={() => {}}
      nextLabel="Next"
      onBack={() => {}}
      backLabel="Back"
    />
  ),
};

export const WithDocLink: Story = {
  render: () => (
    <Coachmark
      rect={FAKE_RECT}
      title="Manage your MCP servers"
      body="Add, edit, and remove MCP server presets from this panel."
      docHref="https://example.com/docs/mcp"
      docLabel="Learn more"
      onDocClick={() => {}}
      onNext={() => {}}
      nextLabel="Next"
      onBack={() => {}}
      backLabel="Back"
    />
  ),
};
