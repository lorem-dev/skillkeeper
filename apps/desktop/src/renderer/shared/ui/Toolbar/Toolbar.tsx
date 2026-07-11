/**
 * Toolbar. A transparent row with optional leading controls, a title, and
 * trailing actions. Designed to sit inside a Page via its `toolbar` slot, where
 * the title serves as the screen heading. Generic -- no product knowledge.
 * See design-system.md Section 8.7.
 */
import type { ReactNode } from 'react';
import { cx } from '../../lib';
import './Toolbar.scss';

export interface ToolbarProps {
  readonly title?: ReactNode;
  /** A control placed immediately after the title (a small gap apart), before
   *  the spacer -- e.g. a per-page view toggle that belongs with the heading
   *  rather than out at the trailing edge. */
  readonly titleAdornment?: ReactNode;
  /** Controls placed before the title. */
  readonly leading?: ReactNode;
  /** Actions placed at the trailing edge. */
  readonly trailing?: ReactNode;
  /** Draw a hairline separator along the bottom edge. Off by default so the
   *  toolbar reads as part of the page rather than a distinct bar. */
  readonly separator?: boolean;
  readonly className?: string;
}

export function Toolbar({
  title,
  titleAdornment,
  leading,
  trailing,
  separator = false,
  className,
}: ToolbarProps) {
  return (
    <div className={cx('sk-toolbar', separator && 'sk-toolbar--separator', className)}>
      {leading !== undefined && <div className="sk-toolbar__leading">{leading}</div>}
      {title !== undefined && <h1 className="sk-toolbar__title">{title}</h1>}
      {titleAdornment !== undefined && (
        <div className="sk-toolbar__title-adornment">{titleAdornment}</div>
      )}
      <div className="sk-toolbar__spacer" />
      {trailing !== undefined && <div className="sk-toolbar__trailing">{trailing}</div>}
    </div>
  );
}
