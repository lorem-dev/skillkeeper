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
import { GLOBAL_SCOPE_ID } from '@/domain';
import { ProjectIcon } from './ProjectIcon';

/**
 * Whether the user-wide scope is offered as the first option, and its label.
 * The two travel together so the type enforces what a doc comment used to ask
 * for: with `includeGlobal` set there is no way to omit the label and fall back
 * to rendering the raw wire id `global` in the interface.
 */
type GlobalOption =
  | { readonly includeGlobal: true; readonly globalLabel: string }
  | { readonly includeGlobal?: false; readonly globalLabel?: never };

/** Everything the control takes regardless of whether Global is offered. */
interface ProjectSelectBaseProps {
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

/**
 * `includeGlobal` offers the user-wide scope as the first option (value
 * `GLOBAL_SCOPE_ID`) and then requires `globalLabel`.
 */
export type ProjectSelectProps = ProjectSelectBaseProps & GlobalOption;

export function ProjectSelect(props: ProjectSelectProps) {
  const { projects, projectInfo, value, onChange, placeholder, ariaLabel, emptyText, disabled, className } = props;
  const projectOptions = projects.map((p) => ({
    value: p.id,
    label: p.name,
    icon: <ProjectIcon iconUrl={projectInfo?.[p.id]?.iconDataUrl} name={p.name} size={18} />,
  }));
  // Read off `props` rather than a destructured pair: narrowing the union on
  // `props.includeGlobal` is what makes `props.globalLabel` a `string` here.
  const options =
    props.includeGlobal === true
      ? [
          {
            value: GLOBAL_SCOPE_ID,
            label: props.globalLabel,
            icon: <ProjectIcon global name="" size={18} />,
          },
          ...projectOptions,
        ]
      : projectOptions;

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
