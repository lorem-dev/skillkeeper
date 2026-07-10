/**
 * ProjectSelect: the project-picking control shared by every flow that asks
 * "which project?" (skill install, MCP install, and any future flow). A
 * `Combobox` (search-filterable single select) with each option's leading
 * icon set to that project's `ProjectIcon` -- the project's own icon when
 * known, otherwise a generated placeholder keyed to its name. The trigger
 * shows the same "unknown" placeholder as its leading icon until a project is
 * chosen.
 */
import { Combobox } from '@/shared/ui';
import type { Project, ProjectInfo } from '@/services/bridge';
import { ProjectIcon } from './ProjectIcon';

export interface ProjectSelectProps {
  readonly projects: readonly Project[];
  /** Per-project extra info (icon data URL); keyed by project id. Absent
   *  entries fall back to the generated placeholder icon. */
  readonly projectInfo?: Readonly<Record<string, ProjectInfo>>;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  /** Message shown in the list when no project matches the query. */
  readonly emptyText?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function ProjectSelect({
  projects,
  projectInfo,
  value,
  onChange,
  placeholder,
  ariaLabel,
  emptyText,
  disabled,
  className,
}: ProjectSelectProps) {
  const options = projects.map((p) => ({
    value: p.id,
    label: p.name,
    icon: <ProjectIcon iconUrl={projectInfo?.[p.id]?.iconDataUrl} name={p.name} size={18} />,
  }));

  return (
    <Combobox
      options={options}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      emptyText={emptyText}
      fallbackIcon={<ProjectIcon name="" size={18} />}
      disabled={disabled}
      className={className}
    />
  );
}
