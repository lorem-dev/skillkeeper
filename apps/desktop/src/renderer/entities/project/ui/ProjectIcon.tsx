/**
 * ProjectIcon: a project's square icon at an arbitrary size. Renders the
 * project's own icon (a data URL resolved in the main process) when it has one,
 * otherwise a generated placeholder -- a filled tile in the project's colour
 * (keyed to the name) with the name's first letter. Reused on the project card
 * and in the skills TreeView, where it is rendered small.
 */
import type { CSSProperties } from 'react';
import { cx } from '@/shared/lib';
import { hueFromName } from '../lib/hueFromName';
import './ProjectIcon.scss';

export interface ProjectIconProps {
  /** The project's own icon as a data URL; when absent a placeholder is drawn. */
  readonly iconUrl?: string;
  /** Project name -- the placeholder's colour and letter derive from it. An empty
   * name draws the "unknown" placeholder: a neutral grey tile with a "?". */
  readonly name: string;
  /** Square size in px. Default 18. */
  readonly size?: number;
  readonly className?: string;
}

export function ProjectIcon({ iconUrl, name, size = 18, className }: ProjectIconProps) {
  const box: CSSProperties = { width: size, height: size };
  if (iconUrl !== undefined) {
    return (
      <img
        className={cx('sk-project-icon', className)}
        style={box}
        src={iconUrl}
        alt=""
        draggable={false}
        // Decode off the main thread and let the browser cache the decoded
        // bitmap by src, so re-renders/re-mounts don't re-decode and jank.
        decoding="async"
      />
    );
  }
  // No name -> "unknown" placeholder: neutral grey with a "?" (e.g. while the user
  // is still choosing a project). Otherwise the colour + letter key off the name.
  const unknown = name.trim() === '';
  return (
    <span
      className={cx('sk-project-icon', 'sk-project-icon--letter', className)}
      // Placeholder colour (consumed per theme in CSS); the letter scales with the box.
      style={
        {
          ...box,
          '--sk-proj-color': unknown ? 'var(--sk-color-label-2)' : `hsl(${hueFromName(name)} 60% 52%)`,
          fontSize: Math.round(size * 0.58),
        } as CSSProperties
      }
      aria-hidden="true"
    >
      {unknown ? '?' : name.slice(0, 1).toUpperCase()}
    </span>
  );
}
