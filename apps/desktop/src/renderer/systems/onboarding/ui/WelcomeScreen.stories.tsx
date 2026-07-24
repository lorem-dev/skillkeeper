import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore } from '@/app/store';
import type { SkillKeeperConfig } from '@/app/store';
import { WelcomeScreen } from './WelcomeScreen';

const meta: Meta<typeof WelcomeScreen> = {
  title: 'systems/onboarding/WelcomeScreen',
  component: WelcomeScreen,
};
export default meta;
type Story = StoryObj<typeof WelcomeScreen>;

const BASE_CONFIG: SkillKeeperConfig = {
  general: { language: 'en', theme: 'system', animations: 'normal' },
  updates: { mode: 'manual', intervalMinutes: 720, checkOnStartup: false },
  agents: { enabled: ['claude', 'codex', 'copilot', 'cursor', 'opencode'], overrides: {} },
  executables: { globs: [] },
  security: { hookConsentPolicy: 'always-ask' },
  notifications: { enabled: true },
  repositories: { gitPath: 'git' },
  projects: { checkIntervalMinutes: 1 },
  mcp: { servers: [] },
};

const ABOUT_IDENTITY = <div>SkillKeeper v0.1.2</div>;
const ABOUT_FOOTER = <div>(c) 2026 Lorem Dev</div>;

// Story does not depend on the bridge or `@/features/about`: the identity and
// footer blocks are plain fixtures, and `config` is seeded directly into the
// store so the language/theme controls render without a Tauri round trip. Theme
// preference is left at "system" so the preview's own Theme toolbar toggle (see
// .storybook/preview.tsx) drives light/dark -- no separate Dark story needed.
export const Default: Story = {
  render: () => {
    useSkillkeeperStore.setState({ config: BASE_CONFIG });
    return <WelcomeScreen aboutIdentity={ABOUT_IDENTITY} aboutFooter={ABOUT_FOOTER} />;
  },
};
