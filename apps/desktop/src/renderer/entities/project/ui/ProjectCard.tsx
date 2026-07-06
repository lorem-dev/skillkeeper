import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Project } from '@/services/bridge';
import { Badge, Card, Button, Icon, Skeleton, Tooltip } from '@/shared/ui';
import { transitionFast } from '@/shared/lib';
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
  /** Total skills installed in the project (pre-formatted, pluralized). */
  readonly skillCountLabel?: string;
  /** Of those, how many are installed from repositories (pre-formatted). */
  readonly fromReposLabel?: string;
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
  /** Drop a missing-folder project (no confirmation). */
  readonly onRemove: () => void;
}

export function ProjectCard({
  project,
  skillCountLabel,
  fromReposLabel,
  infoPending,
  missing,
  missingLabel,
  pathCopyLabel,
  onPathClick,
  editLabel,
  removeLabel,
  openControl,
  onEdit,
  onRemove,
}: ProjectCardProps) {
  return (
    <Card className="sk-project-card">
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
            <Tooltip content={editLabel}>
              <Button
                variant="secondary"
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
