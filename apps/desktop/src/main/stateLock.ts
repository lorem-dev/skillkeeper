/**
 * Shared serialization for the state file's read-modify-write critical section.
 *
 * IPC handlers run concurrently and `saveState` overwrites the whole file
 * (repositories + projects + installs), so two interleaved load-mutate-save
 * sequences -- even across different features (a repo sync and a project add) --
 * would lose one update. Every mutation of the state file must run inside this
 * one lock; slow work (git, dialogs) stays outside it, and locked sections
 * always re-read fresh state.
 */
let lock: Promise<unknown> = Promise.resolve();

export function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
