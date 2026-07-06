/**
 * Drives the background project-folder existence check: one run once the initial
 * load finishes, then a self-rescheduling loop (see store.sweepProjects) that
 * runs to completion and repeats after `config.projects.checkIntervalMinutes`.
 * Re-kicking when the interval changes reschedules with the new value; the
 * Projects "Refresh" button also calls sweepProjects to run now and reschedule.
 */
import { useEffect } from 'react';
import { useSkillkeeperStore } from '@/app/store';

export function useProjectCheckSchedule(): void {
  const loading = useSkillkeeperStore((s) => s.loading);
  const interval = useSkillkeeperStore((s) => s.config?.projects.checkIntervalMinutes);
  const sweepProjects = useSkillkeeperStore((s) => s.sweepProjects);

  useEffect(() => {
    if (loading || interval === undefined) return;
    void sweepProjects();
  }, [loading, interval, sweepProjects]);
}
