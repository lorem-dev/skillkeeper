import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore } from '@/app/store';
import { LogsPage } from './LogsPage';
import { seedStore } from '@/app/store/storyState';

// `fullscreen` overrides the global `centered` layout: LogsPage is a
// position:fixed overlay, and the centering wrapper becomes its containing block,
// which shifts it off the canvas instead of covering it.
const meta: Meta<typeof LogsPage> = {
  title: 'systems/LogsPage',
  component: LogsPage,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof LogsPage>;

export const Empty: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        useSkillkeeperStore.getState().openLogs();
      });
    }, []);
    return <LogsPage />;
  },
};

export const Populated: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        const state = useSkillkeeperStore.getState();
        state.notify('Connection timeout to repository server', 'error');
        state.notify('Failed to parse configuration file', 'error', 'repo-1');
        // A resolution warning: logged, never toasted, and shown by default
        // alongside errors.
        state.notifyResolveWarnings([
          {
            repoId: 'repo-1',
            repoName: 'team-skills',
            message:
              'Unresolved SKILL.md at "group/sub/too-deep": nesting is deeper than a single group; declare it in skillkeeper.repo.yaml to install it.',
          },
        ]);
        state.notify('Branch name copied to the clipboard', 'info', 'repo-2');
        state.openLogs();
      });
    }, []);
    return <LogsPage />;
  },
};

/** Warnings only, to check the orange row tone in isolation. */
export const WarningsOnly: Story = {
  render: () => {
    useEffect(() => {
      seedStore(() => {
        const state = useSkillkeeperStore.getState();
        state.notifyResolveWarnings([
          { repoId: 'repo-1', repoName: 'team-skills', message: 'Unresolved SKILL.md at "a/b/c"' },
          { repoId: 'repo-2', repoName: 'acme', message: 'Unresolved SKILL.md at "d/e/f"' },
        ]);
        state.openLogs();
      });
    }, []);
    return <LogsPage />;
  },
};
