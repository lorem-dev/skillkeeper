import type { Project } from '@/services/bridge';
import { ListRow } from '@/shared/ui';

export interface ProjectRowProps {
  readonly project: Project;
  /** Already-translated, fully-formatted "Added {when}" line. */
  readonly addedLabel: string;
}

export function ProjectRow({ project, addedLabel }: ProjectRowProps) {
  return <ListRow title={project.name} subtitle={project.path} trailing={addedLabel} />;
}
