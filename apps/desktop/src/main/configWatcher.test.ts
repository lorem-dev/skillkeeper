import { describe, it, expect, vi } from 'vitest';
import { createMemFs } from '@skillkeeper/core/testing';
import { createConfigWatcher } from './configWatcher.js';

const PATH = '/cfg/config.yaml';

async function seed(text: string) {
  const fs = createMemFs();
  await fs.writeFile(PATH, text);
  return fs;
}

describe('createConfigWatcher', () => {
  it('does not emit on the baseline tick', async () => {
    const fs = await seed('general:\n  language: en\n');
    const emit = vi.fn();
    const w = createConfigWatcher(fs, PATH, emit);
    await w.tick();
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits a reloaded result when the content changes', async () => {
    const fs = await seed('general:\n  language: en\n');
    const emit = vi.fn();
    const w = createConfigWatcher(fs, PATH, emit);
    await w.tick();
    await fs.writeFile(PATH, 'general:\n  language: de\n');
    await w.tick();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0].config.general.language).toBe('de');
  });

  it('does not emit when content is unchanged', async () => {
    const fs = await seed('general:\n  language: en\n');
    const emit = vi.fn();
    const w = createConfigWatcher(fs, PATH, emit);
    await w.tick();
    await w.tick();
    expect(emit).not.toHaveBeenCalled();
  });

  it('noteWritten suppresses the next tick after a write', async () => {
    const fs = await seed('general:\n  language: en\n');
    const emit = vi.fn();
    const w = createConfigWatcher(fs, PATH, emit);
    await w.tick();
    await fs.writeFile(PATH, 'general:\n  language: de\n');
    await w.noteWritten();
    await w.tick();
    expect(emit).not.toHaveBeenCalled();
  });
});
