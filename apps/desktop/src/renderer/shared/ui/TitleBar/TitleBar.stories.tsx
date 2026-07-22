import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TitleBar } from './TitleBar';
// The real app brand mark (dark-ink for light backgrounds, light-ink for dark),
// so the stories show the actual title-bar logo and its theme swap.
import logoLight from '../../../../../../../assets/icons/icon-default.png';
import logoDark from '../../../../../../../assets/icons/icon-dark.png';

const meta = {
  title: 'shared/ui/TitleBar',
  component: TitleBar,
  parameters: {
    docs: {
      description: {
        component:
          'The frameless-window title bar for Windows/Linux: a transparent, draggable top ' +
          'strip with a leading brand mark, the app title, and custom window controls at the ' +
          'right. macOS uses no strip (native traffic lights + drag regions on the real ' +
          'content), so there is no macOS variant here. The brand mark is theme-aware; the app ' +
          'layer (WindowChrome) picks the light/dark logo, so it swaps with the Theme toolbar.',
      },
    },
  },
} satisfies Meta<typeof TitleBar>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The brand mark node for a given appearance, sized by the bar. */
function logoIcon(dark: boolean): ReactNode {
  return <img src={dark ? logoDark : logoLight} alt="" width={16} height={16} />;
}

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
  render: (args, { globals }) => (
    <Frame>
      <TitleBar {...args} icon={logoIcon(globals['theme'] === 'dark')} />
    </Frame>
  ),
};

export const Linux: Story = {
  args: { platform: 'linux', title: 'SkillKeeper' },
  render: (args, { globals }) => (
    <Frame>
      <TitleBar {...args} icon={logoIcon(globals['theme'] === 'dark')} />
    </Frame>
  ),
};

export const WindowsMaximized: Story = {
  args: { platform: 'windows', title: 'SkillKeeper', maximized: true },
  render: (args, { globals }) => (
    <Frame>
      <TitleBar {...args} icon={logoIcon(globals['theme'] === 'dark')} />
    </Frame>
  ),
};

// Interactive: the maximize/restore glyph tracks a local maximized state.
export const Interactive: Story = {
  args: { platform: 'windows', title: 'SkillKeeper' },
  render: (args, { globals }) => {
    const [maximized, setMaximized] = useState(false);
    return (
      <Frame>
        <TitleBar
          {...args}
          icon={logoIcon(globals['theme'] === 'dark')}
          maximized={maximized}
          onToggleMaximize={() => setMaximized((m) => !m)}
        />
      </Frame>
    );
  },
};

// Light and dark side by side, each with its matching logo, so the theme swap is
// visible without toggling the Theme toolbar. Dark tokens live on the
// `[data-theme='dark']` attribute selector, so wrapping a subtree re-themes it.
export const ThemeVariants: Story = {
  args: { platform: 'windows', title: 'SkillKeeper' },
  render: (args) => (
    <div style={{ display: 'flex', gap: 24 }}>
      <div data-theme="light">
        <Frame>
          <TitleBar {...args} icon={logoIcon(false)} />
        </Frame>
      </div>
      <div data-theme="dark">
        <Frame>
          <TitleBar {...args} icon={logoIcon(true)} />
        </Frame>
      </div>
    </div>
  ),
};
