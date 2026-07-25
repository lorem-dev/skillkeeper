import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore } from '@/app/store';
import { StatusBar } from './StatusBar';
import { seedStore } from '@/app/store/storyState';

// The status bar is full-width chrome, so it reads correctly only when it spans
// the canvas rather than sitting in the centered wrapper.
const meta: Meta<typeof StatusBar> = {
  title: 'systems/StatusBar',
  component: StatusBar,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof StatusBar>;

/** Two warnings, seeded through the real action so the no-toast path is exercised. */
const WARNINGS = [
  { repoId: 'repo-1', repoName: 'team-skills', message: 'Unresolved SKILL.md at "a/b/c"' },
  { repoId: 'repo-2', repoName: 'acme', message: 'Unresolved SKILL.md at "d/e/f"' },
];

export const Empty: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {});
    }, []);
    return <StatusBar />;
  },
};

export const WithErrors: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        const state = useSkillkeeperStore.getState();
        state.notify('Example error 1', 'error');
        state.notify('Example error 2', 'error');
        state.notify('Example message', 'info');
      });
    }, []);
    return <StatusBar />;
  },
};

/** Warnings alone: the badge is orange and counts them. */
export const WithWarnings: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        useSkillkeeperStore.getState().notifyResolveWarnings(WARNINGS);
      });
    }, []);
    return <StatusBar />;
  },
};

/** Errors win: with both present the badge shows ONLY the error count, in red. */
export const ErrorsOutrankWarnings: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        const state = useSkillkeeperStore.getState();
        state.notify('Example error', 'error');
        state.notifyResolveWarnings(WARNINGS);
      });
    }, []);
    return <StatusBar />;
  },
};

/** Past nine, the pill shows `9+` instead of growing. */
export const OverflowCount: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        const state = useSkillkeeperStore.getState();
        for (let i = 0; i < 12; i += 1) state.notify(`Example error ${i + 1}`, 'error');
      });
    }, []);
    return <StatusBar />;
  },
};

/** Warning overflow, to check the orange pill at `9+`. */
export const WarningOverflowCount: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        useSkillkeeperStore.getState().notifyResolveWarnings(
          Array.from({ length: 14 }, (_unused, i) => ({
            repoId: `repo-${i}`,
            repoName: 'team-skills',
            message: `Unresolved SKILL.md at "group/sub/x${i}"`,
          })),
        );
      });
    }, []);
    return <StatusBar />;
  },
};
