/**
 * Application state store.
 *
 * SkillKeeper keeps user settings in `config.yaml` (see @skillkeeper/config) and
 * its own bookkeeping - tracked repositories, tracked projects, and install
 * manifests with file hashes - in a separate JSON state file written only by
 * SkillKeeper. Writes are atomic (temp file then rename). This module is pure
 * over an injected {@link FsPort} so it is testable with the in-memory fake.
 */
import type { FsPort } from './ports.js';
import type { InstallManifest, Project, Repository } from './model.js';

/** Current on-disk state schema version, for forward migration. */
export const STATE_VERSION = 1;

/** The full persisted application state. */
export interface AppState {
  readonly version: number;
  readonly repositories: Repository[];
  readonly projects: Project[];
  readonly installs: InstallManifest[];
}

/** Raised when a state file exists but cannot be parsed or has a bad shape. */
export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateError';
  }
}

/** A fresh, empty state at the current version. */
export const emptyState = (): AppState => ({
  version: STATE_VERSION,
  repositories: [],
  projects: [],
  installs: [],
});

const hasStateShape = (value: unknown): value is AppState => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['version'] === 'number' &&
    Array.isArray(record['repositories']) &&
    Array.isArray(record['projects']) &&
    Array.isArray(record['installs'])
  );
};

/**
 * Load the state file. Returns a fresh empty state when the file does not
 * exist; throws {@link StateError} when it exists but is not valid state.
 */
export const loadState = async (fs: FsPort, path: string): Promise<AppState> => {
  if (!(await fs.exists(path))) {
    return emptyState();
  }
  const raw = await fs.readFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StateError(`State file is not valid JSON: ${path}`);
  }
  if (!hasStateShape(parsed)) {
    throw new StateError(`State file has an unexpected shape: ${path}`);
  }
  return parsed;
};

/** Persist state atomically (write to a temp file, then rename into place). */
export const saveState = async (fs: FsPort, path: string, state: AppState): Promise<void> => {
  const tempPath = `${path}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(tempPath, path);
};
