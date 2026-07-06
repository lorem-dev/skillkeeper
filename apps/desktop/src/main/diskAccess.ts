/**
 * macOS disk-access priming.
 *
 * A project folder can live in a TCC-protected location (Desktop, Documents,
 * Downloads). macOS only shows its "allow access" prompt the first time the app
 * reads such a folder, and never re-prompts afterwards. Touching these folders
 * once at startup surfaces that prompt early -- so by the time the user adds or
 * the background sweep re-reads a project there, access is already decided --
 * instead of a confusing mid-use prompt (or a project wrongly flagged missing).
 *
 * No-op off macOS. All reads are best-effort: a denial or missing folder is
 * swallowed (the read attempt itself is what triggers the OS prompt).
 */
import { app } from 'electron';
import { readdir } from 'node:fs/promises';

export async function primeMacDiskAccess(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const protectedDirs = ['documents', 'desktop', 'downloads'] as const;
  await Promise.all(
    protectedDirs.map(async (name) => {
      try {
        await readdir(app.getPath(name));
      } catch {
        // Denied or missing -- the attempt already triggered the OS prompt.
      }
    }),
  );
}
