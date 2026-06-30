import type { InstallManifest, AgentKind } from '@/services/bridge';

export interface InstalledSkillView {
  readonly key: string;
  readonly group?: string;
  readonly name: string;
  readonly version?: string;
  readonly agents: AgentKind[];
  readonly scopes: ('project' | 'global')[];
  readonly sourceRepoId?: string;
  readonly hasHooks: boolean;
  readonly installedAt: string;
  readonly fileCount: number;
  readonly hookCount: number;
  readonly destinationRoot: string;
}

function keyOf(m: InstallManifest): string {
  return m.skillId.group !== undefined ? `${m.skillId.group}/${m.skillId.name}` : m.skillId.name;
}

/** Group install manifests by skill identity into display records. */
export function aggregateInstalls(installs: InstallManifest[]): InstalledSkillView[] {
  const byKey = new Map<string, InstalledSkillView>();
  for (const m of installs) {
    const key = keyOf(m);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        key,
        ...(m.skillId.group !== undefined ? { group: m.skillId.group } : {}),
        name: m.skillId.name,
        ...(m.version !== undefined ? { version: m.version } : {}),
        agents: [m.target.agent],
        scopes: [m.target.scope],
        ...(m.sourceRepoId !== undefined ? { sourceRepoId: m.sourceRepoId } : {}),
        hasHooks: m.hookEdits.length > 0,
        installedAt: m.installedAt,
        fileCount: m.files.length,
        hookCount: m.hookEdits.length,
        destinationRoot: m.destinationRoot,
      });
      continue;
    }
    if (!existing.agents.includes(m.target.agent)) existing.agents.push(m.target.agent);
    if (!existing.scopes.includes(m.target.scope)) existing.scopes.push(m.target.scope);
    if (m.installedAt > existing.installedAt) {
      (existing as { installedAt: string }).installedAt = m.installedAt;
    }
    if (m.hookEdits.length > 0) {
      (existing as { hasHooks: boolean }).hasHooks = true;
      (existing as { hookCount: number }).hookCount += m.hookEdits.length;
    }
    (existing as { fileCount: number }).fileCount += m.files.length;
  }
  for (const v of byKey.values()) v.agents.sort();
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}
