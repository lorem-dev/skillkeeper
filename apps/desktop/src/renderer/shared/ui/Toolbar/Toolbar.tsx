/**
 * Toolbar. A transparent row with optional leading controls, a title, and
 * trailing actions. Designed to sit inside a Page via its `toolbar` slot, where
 * the title serves as the screen heading. Generic -- no product knowledge.
 * See design-system.md Section 8.7.
 */
import type { ReactNode } from 'react';
import { cx, dragRegion } from '../../lib';
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
    // Every structural slot of the toolbar doubles as a macOS window-drag handle
    // (no-op elsewhere), so the whole top strip drags the window. Tauri starts a
    // drag only when the *pressed* element itself is tagged, so the interactive
    // children inside the slots (buttons, inputs, selects) keep working -- only
    // the slots' own background/gaps drag.
    <div
      className={cx('sk-toolbar', separator && 'sk-toolbar--separator', className)}
      {...dragRegion()}
    >
      {leading !== undefined && (
        <div className="sk-toolbar__leading" {...dragRegion()}>
          {leading}
        </div>
      )}
      {title !== undefined && (
        <h1 className="sk-toolbar__title" {...dragRegion()}>
          {title}
        </h1>
      )}
      {titleAdornment !== undefined && (
        <div className="sk-toolbar__title-adornment" {...dragRegion()}>
          {titleAdornment}
        </div>
      )}
      <div className="sk-toolbar__spacer" {...dragRegion()} />
      {trailing !== undefined && (
        <div className="sk-toolbar__trailing" {...dragRegion()}>
          {trailing}
        </div>
      )}
    </div>
  );
}
