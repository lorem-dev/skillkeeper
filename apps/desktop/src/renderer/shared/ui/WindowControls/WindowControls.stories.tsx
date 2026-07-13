import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { WindowControls } from './WindowControls';

const meta = {
  title: 'shared/ui/WindowControls',
  component: WindowControls,
  parameters: {
    docs: {
      description: {
        component:
          'Custom window controls for the frameless title bar on Windows and Linux. ' +
          'macOS keeps its native traffic lights instead, so there is no macOS variant here.',
      },
    },
  },
} satisfies Meta<typeof WindowControls>;

export default meta;

type Story = StoryObj<typeof meta>;

// A title-bar-height strip so the full-height Windows buttons render in context.
function Bar({ children }: { readonly children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        height: 38,
        background: 'var(--sk-color-bg-secondary)',
        borderBottom: '1px solid var(--sk-color-separator)',
      }}
    >
      {children}
    </div>
  );
}

export const Windows: Story = {
  args: { variant: 'windows' },
  render: (args) => (
    <Bar>
      <WindowControls {...args} />
    </Bar>
  ),
};

export const WindowsMaximized: Story = {
  args: { variant: 'windows', maximized: true },
  render: (args) => (
    <Bar>
      <WindowControls {...args} />
    </Bar>
  ),
};

export const Linux: Story = {
  args: { variant: 'linux' },
  render: (args) => (
    <Bar>
      <WindowControls {...args} />
    </Bar>
  ),
};

export const LinuxMaximized: Story = {
  args: { variant: 'linux', maximized: true },
  render: (args) => (
    <Bar>
      <WindowControls {...args} />
    </Bar>
  ),
};

// Interactive: clicking maximize/restore swaps the middle glyph.
export const Interactive: Story = {
  args: { variant: 'windows' },
  render: (args) => {
    const [maximized, setMaximized] = useState(false);
    return (
      <Bar>
        <WindowControls
          {...args}
          maximized={maximized}
          onToggleMaximize={() => setMaximized((m) => !m)}
        />
      </Bar>
    );
  },
};
