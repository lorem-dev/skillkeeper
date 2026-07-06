/**
 * Drives repository update checks from `config.updates`:
 * - a one-time check on startup for `on-startup` mode (or `scheduled` with
 *   `checkOnStartup`),
 * - a recurring check every `intervalMinutes` for `scheduled` mode.
 * `manual` mode does neither -- the Repositories "Refresh" button covers it.
 *
 * A check fetches each repo and highlights the ones whose current (checked-out)
 * branch is behind its upstream (see store.refreshRepoUpdates -> repoHasUpdate).
 */
import { useEffect, useRef } from 'react';
import { useSkillkeeperStore } from '@/app/store';

export function useUpdateSchedule(): void {
  const mode = useSkillkeeperStore((s) => s.config?.updates.mode);
  const intervalMinutes = useSkillkeeperStore((s) => s.config?.updates.intervalMinutes);
  const checkOnStartup = useSkillkeeperStore((s) => s.config?.updates.checkOnStartup);
  const loading = useSkillkeeperStore((s) => s.loading);
  const refreshRepoUpdates = useSkillkeeperStore((s) => s.refreshRepoUpdates);

  // One-time startup check, once the initial load has finished.
  const startupDone = useRef(false);
  useEffect(() => {
    if (loading || mode === undefined || startupDone.current) return;
    startupDone.current = true;
    if (mode === 'on-startup' || (mode === 'scheduled' && checkOnStartup === true)) {
      void refreshRepoUpdates();
    }
  }, [loading, mode, checkOnStartup, refreshRepoUpdates]);

  // Recurring check for scheduled mode.
  useEffect(() => {
    if (mode !== 'scheduled' || intervalMinutes === undefined) return undefined;
    const id = setInterval(() => void refreshRepoUpdates(), intervalMinutes * 60 * 1000);
    return () => clearInterval(id);
  }, [mode, intervalMinutes, refreshRepoUpdates]);
}
