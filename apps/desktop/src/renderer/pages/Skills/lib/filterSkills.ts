import type { InstalledSkillView } from '@/entities/skill';
import type { AgentKind } from '@/services/bridge';

export interface SkillFilter {
  readonly query: string;
  readonly agent: AgentKind | 'all';
}

export function filterSkills(views: InstalledSkillView[], filter: SkillFilter): InstalledSkillView[] {
  const q = filter.query.trim().toLowerCase();
  return views.filter((v) => {
    const label = (v.group !== undefined ? `${v.group}/${v.name}` : v.name).toLowerCase();
    const matchesQuery = q === '' || label.includes(q);
    const matchesAgent = filter.agent === 'all' || v.agents.includes(filter.agent);
    return matchesQuery && matchesAgent;
  });
}
