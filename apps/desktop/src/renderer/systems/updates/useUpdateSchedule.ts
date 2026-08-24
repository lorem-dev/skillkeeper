/**
 * Drives repository update checks from `config.updates`:
 * - a one-time check on startup for `on-startup` mode (or `scheduled` with
 *   `checkOnStartup`),
 * - a recurring check every `intervalMinutes` for `scheduled` mode.
 * `manual` mode does neither -- the Repositories "Refresh" button covers it.
 *
 * A check fetches each repo and highlights the ones whose current (checked-out)
 * branch is behind its upstream (see store.refreshRepoUpdates -> repoHasUpdate).
 *
 * Every check started here is non-interactive: nobody asked for it, so it never
 * blocks waiting for a passphrase. A locked key still stops the check, so the
 * store raises the passphrase window on the refusal and this hook resumes the
 * sweep once that window is answered.
 */
import { useEffect, useRef } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { bridgeClient } from '@/services/bridge';

export function useUpdateSchedule(): void {
  const mode = useSkillkeeperStore((s) => s.config?.updates.mode);
  const intervalMinutes = useSkillkeeperStore((s) => s.config?.updates.intervalMinutes);
  const checkOnStartup = useSkillkeeperStore((s) => s.config?.updates.checkOnStartup);
  const loading = useSkillkeeperStore((s) => s.loading);
  const refreshRepoUpdates = useSkillkeeperStore((s) => s.refreshRepoUpdates);
  const noteUnlockResolved = useSkillkeeperStore((s) => s.noteUnlockResolved);

  // One-time startup check, once the initial load has finished.
  const startupDone = useRef(false);
  useEffect(() => {
    if (loading || mode === undefined || startupDone.current) return;
    startupDone.current = true;
    if (mode === 'on-startup' || (mode === 'scheduled' && checkOnStartup === true)) {
      void refreshRepoUpdates(false);
    }
  }, [loading, mode, checkOnStartup, refreshRepoUpdates]);

  // Recurring check for scheduled mode.
  useEffect(() => {
    if (mode !== 'scheduled' || intervalMinutes === undefined) return undefined;
    const id = setInterval(() => void refreshRepoUpdates(false), intervalMinutes * 60 * 1000);
    return () => clearInterval(id);
  }, [mode, intervalMinutes, refreshRepoUpdates]);

  // A check the locked key refused raised the passphrase window; when that
  // window is answered the store decides whether to resume the sweep (unlocked)
  // or to say the check stayed skipped (declined). Subscribed for the app's
  // lifetime, and a no-op when no check was refused.
  useEffect(() => bridgeClient.onSshUnlockResolved((unlocked) => noteUnlockResolved(unlocked)), [noteUnlockResolved]);
}
