import { describe, expect, it } from 'vitest';

import { createMemFs } from '../testing/index.js';
import { emptyState, loadState, saveState, StateError, STATE_VERSION } from './state.js';
import type { AppState } from './state.js';
import type { Repository } from '../kernel/model.js';

const STATE_PATH = '/data/state.json';

const sampleRepository: Repository = {
  id: 'r1',
  name: 'skills',
  url: 'git@github.com:acme/skills.git',
  kind: 'github',
  transport: 'ssh',
  lfs: true,
  localPath: '/data/repos/r1',
};

describe('state store', () => {
  it('returns a fresh empty state when the file does not exist', async () => {
    const fs = createMemFs();
    const state = await loadState(fs, STATE_PATH);
    expect(state).toEqual(emptyState());
    expect(state.version).toBe(STATE_VERSION);
  });

  it('round-trips an empty state', async () => {
    const fs = createMemFs();
    await saveState(fs, STATE_PATH, emptyState());
    expect(await loadState(fs, STATE_PATH)).toEqual(emptyState());
  });

  it('round-trips populated state', async () => {
    const fs = createMemFs();
    const state: AppState = {
      version: STATE_VERSION,
      repositories: [sampleRepository],
      projects: [{ id: 'p1', path: '/work/app', name: 'app', addedAt: '2026-06-27T00:00:00.000Z' }],
      installs: [],
    };
    await saveState(fs, STATE_PATH, state);
    expect(await loadState(fs, STATE_PATH)).toEqual(state);
  });

  it('writes atomically (no leftover temp file)', async () => {
    const fs = createMemFs();
    await saveState(fs, STATE_PATH, emptyState());
    expect(await fs.exists(`${STATE_PATH}.tmp`)).toBe(false);
    expect(await fs.exists(STATE_PATH)).toBe(true);
  });

  it('throws StateError on invalid JSON', async () => {
    const fs = createMemFs();
    await fs.writeFile(STATE_PATH, 'not json{');
    await expect(loadState(fs, STATE_PATH)).rejects.toBeInstanceOf(StateError);
  });

  it('throws StateError on an unexpected shape', async () => {
    const fs = createMemFs();
    await fs.writeFile(STATE_PATH, JSON.stringify({ version: 1 }));
    await expect(loadState(fs, STATE_PATH)).rejects.toBeInstanceOf(StateError);
  });

  it('throws StateError when the JSON is a primitive, not an object', async () => {
    const fs = createMemFs();
    await fs.writeFile(STATE_PATH, '42');
    await expect(loadState(fs, STATE_PATH)).rejects.toBeInstanceOf(StateError);
  });
});
