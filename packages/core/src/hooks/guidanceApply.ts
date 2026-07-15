/**
 * IO-level helpers to apply a skill's guidance block into an agent's guidance
 * file. The pure string manipulation lives in ./guidance; these wrap it with
 * the FsPort + adapter so the desktop and CLI share one implementation.
 */
import type { AgentAdapter } from '../adapters/adapter.js';
import type { AgentTarget, SkillId } from '../kernel/model.js';
import type { FsPort, HostEnv } from '../kernel/ports.js';
import {
  guidanceKey,
  skillGuidanceId,
  stripGuidanceMarkers,
  upsertGuidanceBlock,
  removeGuidanceBlock,
} from './guidance.js';

/** The guidance block key for a skill installed from `remote`. */
export function skillGuidanceBlockKey(remote: string, id: SkillId): string {
  return guidanceKey(remote, skillGuidanceId(id.group, id.name));
}

/**
 * Read a skill's guide body from its source directory: GUIDE.md wins over
 * RULES.md; stray SkillKeeper markers are stripped and trailing newlines
 * trimmed. Returns undefined when neither file exists.
 */
export async function readSkillGuide(fs: FsPort, skillSourceDir: string): Promise<string | undefined> {
  for (const name of ['GUIDE.md', 'RULES.md']) {
    const p = `${skillSourceDir}/${name}`;
    if (await fs.exists(p)) return stripGuidanceMarkers(await fs.readFile(p)).replace(/\n+$/, '');
  }
  return undefined;
}

/** Upsert a skill's guide block into an agent's guidance file (in place if present). */
export async function writeSkillGuidance(
  fs: FsPort,
  adapter: AgentAdapter,
  target: AgentTarget,
  env: HostEnv,
  remote: string,
  id: SkillId,
  body: string,
): Promise<void> {
  const file = await adapter.guidanceFile(target, env);
  const existing = (await fs.exists(file)) ? await fs.readFile(file) : '';
  await fs.writeFile(file, upsertGuidanceBlock(existing, skillGuidanceBlockKey(remote, id), body));
}

/**
 * Remove a skill's guide block from an agent's guidance file; delete the file
 * when removing the block empties it. No-op when the file or block is absent.
 */
export async function clearSkillGuidance(
  fs: FsPort,
  adapter: AgentAdapter,
  target: AgentTarget,
  env: HostEnv,
  remote: string,
  id: SkillId,
): Promise<void> {
  const file = await adapter.guidanceFile(target, env);
  if (!(await fs.exists(file))) return;
  const next = removeGuidanceBlock(await fs.readFile(file), skillGuidanceBlockKey(remote, id));
  if (next === '') await fs.remove(file);
  else await fs.writeFile(file, next);
}
