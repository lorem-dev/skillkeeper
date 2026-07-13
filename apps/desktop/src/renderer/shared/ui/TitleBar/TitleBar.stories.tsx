import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TitleBar } from './TitleBar';

const meta = {
  title: 'shared/ui/TitleBar',
  component: TitleBar,
  parameters: {
    docs: {
      description: {
        component:
          'The frameless-window title bar for Windows/Linux: a transparent, draggable top ' +
          'strip with custom window controls at the right. macOS uses no strip (native traffic ' +
          'lights + drag regions on the real content), so there is no macOS variant here.',
      },
    },
  },
} satisfies Meta<typeof TitleBar>;

export default meta;

type Story = StoryObj<typeof meta>;

// Frame the (transparent) bar over a bit of faux app content so the strip and
// its inset read in isolation.
function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <div
      style={{
        width: 520,
        height: 160,
        background: 'var(--sk-color-bg)',
        border: '1px solid var(--sk-color-separator)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {children}
      <div style={{ padding: 'var(--sk-space-5)', color: 'var(--sk-color-label-3)', fontSize: 13 }}>
        App content sits below the draggable bar.
      </div>
    </div>
  );
}

export const Windows: Story = {
  args: { platform: 'windows', title: 'SkillKeeper' },
  render: (args) => (
    <Frame>
      <TitleBar {...args} />
    </Frame>
  ),
};

export const Linux: Story = {
  args: { platform: 'linux', title: 'SkillKeeper' },
  render: (args) => (
    <Frame>
      <TitleBar {...args} />
    </Frame>
  ),
};

export const WindowsMaximized: Story = {
  args: { platform: 'windows', title: 'SkillKeeper', maximized: true },
  render: (args) => (
    <Frame>
      <TitleBar {...args} />
    </Frame>
  ),
};

// Interactive: the maximize/restore glyph tracks a local maximized state.
export const Interactive: Story = {
  args: { platform: 'windows', title: 'SkillKeeper' },
  render: (args) => {
    const [maximized, setMaximized] = useState(false);
    return (
      <Frame>
        <TitleBar
          {...args}
          maximized={maximized}
          onToggleMaximize={() => setMaximized((m) => !m)}
        />
      </Frame>
    );
  },
};
