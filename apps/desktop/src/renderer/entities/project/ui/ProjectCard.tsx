import type { CSSProperties, ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Project } from '@/services/bridge';
import { Badge, Card, Button, Icon, Skeleton, Tooltip } from '@/shared/ui';
import { transitionFast } from '@/shared/lib';
import { ProjectIcon } from './ProjectIcon';
import { hueFromName } from '../lib/hueFromName';
import './ProjectCard.scss';

/** Longest project name shown before it is truncated with a trailing "...". */
const NAME_MAX = 42;
/** Longest folder path shown; truncated from the START (keep the trailing folders). */
const PATH_MAX = 64;

/** Truncate the end, keeping the start: "very long name" -> "very long na...". */
function truncateEnd(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/** Truncate the start, keeping the end: "/a/b/.../y/z" so the folders stay visible. */
function truncateStart(value: string, max: number): string {
  return value.length > max ? `...${value.slice(value.length - (max - 3))}` : value;
}

export interface ProjectCardProps {
  readonly project: Project;
  /**
   * Data URL for the project's own icon (resolved + safety-checked in main). When
   * set it replaces the default project glyph; otherwise the glyph is shown.
   */
  readonly iconUrl?: string;
  /** Total skills installed in the project (pre-formatted, pluralized). */
  readonly skillCountLabel?: string;
  /** Of those, how many are installed from repositories (pre-formatted). */
  readonly fromReposLabel?: string;
  /** Number of agents detected in the project folder (pre-formatted, pluralized). */
  readonly agentsLabel?: string;
  /** Skill counts not fetched yet: show skeleton badges (reserves height). */
  readonly infoPending?: boolean;
  /** The folder no longer exists (deleted or moved). */
  readonly missing?: boolean;
  /** Tooltip for the "folder missing" red dot. */
  readonly missingLabel: string;
  /** Tooltip for the path (e.g. "Copy full path"). */
  readonly pathCopyLabel?: string;
  /** Called when the path is clicked (copies the full path). */
  readonly onPathClick?: () => void;
  readonly editLabel: string;
  /** Tooltip/label for the delete button shown when the folder is missing. */
  readonly removeLabel: string;
  /** Trailing "open folder" control, composed by the page (OpenProjectButton). */
  readonly openControl?: ReactNode;
  readonly onEdit: () => void;
  /** Tooltip/label for the "go to skills" button (shown when onGoToSkills is set). */
  readonly skillsLabel?: string;
  /** Navigate to the Skills page filtered to this project. */
  readonly onGoToSkills?: () => void;
  /** Drop a missing-folder project (no confirmation). */
  readonly onRemove: () => void;
}

export function ProjectCard({
  project,
  iconUrl,
  skillCountLabel,
  fromReposLabel,
  agentsLabel,
  infoPending,
  missing,
  missingLabel,
  pathCopyLabel,
  onPathClick,
  editLabel,
  removeLabel,
  openControl,
  onEdit,
  skillsLabel,
  onGoToSkills,
  onRemove,
}: ProjectCardProps) {
  const washHue = hueFromName(project.name);
  return (
    <Card className="sk-project-card">
      {/* Decorative left wash: a blurred, scaled copy of the project icon when
          there is one, else a soft colour field keyed to the project name. It
          fades to transparent toward the centre. */}
      <span
        className="sk-project-card__wash"
        aria-hidden="true"
        style={{ '--sk-project-wash': `hsl(${washHue} 55% 58%)` } as CSSProperties}
      >
        {iconUrl !== undefined ? (
          <>
            <img className="sk-project-card__wash-img" src={iconUrl} alt="" draggable={false} />
            {/* On hover, an enlarged, blurred blow-up of the icon fills the whole
                card. */}
            <img className="sk-project-card__wash-flood-img" src={iconUrl} alt="" draggable={false} />
          </>
        ) : (
          <>
            <span className="sk-project-card__wash-diag" />
            {/* On hover, a flat colour flood tints the whole card. */}
            <span className="sk-project-card__wash-flood" />
          </>
        )}
      </span>
      {/* Leading project icon, top-aligned to the title line; the text column
          (name / path / badges) starts to its right, so the space under the icon
          is empty. */}
      <ProjectIcon
        iconUrl={iconUrl}
        name={project.name}
        size={18}
        className="sk-project-card__leading-icon"
      />
      <div className="sk-project-card__main">
        <span className="sk-project-card__name-row">
          <span className="sk-project-card__name">{truncateEnd(project.name, NAME_MAX)}</span>
          <AnimatePresence initial={false}>
            {missing === true && (
              <motion.span
                className="sk-project-card__indicator"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                transition={transitionFast}
              >
                <Tooltip content={missingLabel}>
                  <span className="sk-project-card__missing-dot" aria-label={missingLabel} />
                </Tooltip>
              </motion.span>
            )}
          </AnimatePresence>
        </span>
        {onPathClick !== undefined ? (
          <Tooltip content={pathCopyLabel ?? ''} className="sk-project-card__path-tip">
            <button
              type="button"
              className="sk-project-card__path sk-project-card__path--button"
              onClick={onPathClick}
              aria-label={pathCopyLabel}
            >
              {truncateStart(project.path, PATH_MAX)}
            </button>
          </Tooltip>
        ) : (
          <span className="sk-project-card__path">{truncateStart(project.path, PATH_MAX)}</span>
        )}
        <span className="sk-project-card__badges">
          {infoPending === true ? (
            <>
              <Skeleton width={72} height={20} radius="var(--sk-radius-pill)" />
              <Skeleton width={96} height={20} radius="var(--sk-radius-pill)" />
            </>
          ) : (
            <>
              {skillCountLabel !== undefined && <Badge tone="accent">{skillCountLabel}</Badge>}
              {fromReposLabel !== undefined && <Badge tone="neutral">{fromReposLabel}</Badge>}
              {agentsLabel !== undefined && <Badge tone="neutral">{agentsLabel}</Badge>}
            </>
          )}
        </span>
      </div>
      <div className="sk-project-card__actions">
        {missing === true ? (
          <Tooltip content={removeLabel}>
            <Button
              variant="secondary"
              className="sk-project-card__icon-btn sk-project-card__icon-btn--danger"
              onClick={onRemove}
              aria-label={removeLabel}
            >
              <Icon name="delete" />
            </Button>
          </Tooltip>
        ) : (
          <>
            {openControl}
            {onGoToSkills !== undefined && (
              <Tooltip content={skillsLabel}>
                <Button
                  variant="secondary"
                  glass
                  className="sk-project-card__icon-btn"
                  onClick={onGoToSkills}
                  aria-label={skillsLabel}
                >
                  <Icon name="skills" />
                </Button>
              </Tooltip>
            )}
            <Tooltip content={editLabel}>
              <Button
                variant="secondary"
                glass
                className="sk-project-card__icon-btn"
                onClick={onEdit}
                aria-label={editLabel}
              >
                <Icon name="edit" />
              </Button>
            </Tooltip>
          </>
        )}
      </div>
    </Card>
  );
}
