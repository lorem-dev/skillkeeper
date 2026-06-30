/**
 * Toolbar. A glass bar with optional leading controls, a title, and trailing
 * actions. Generic -- no product knowledge. See design-system.md Section 8.7.
 */
import type { ReactNode } from 'react';
import { cx } from '../../lib';
import './Toolbar.scss';

export interface ToolbarProps {
  readonly title?: ReactNode;
  /** Controls placed before the title. */
  readonly leading?: ReactNode;
  /** Actions placed at the trailing edge. */
  readonly trailing?: ReactNode;
  readonly className?: string;
}

export function Toolbar({ title, leading, trailing, className }: ToolbarProps) {
  return (
    <div className={cx('sk-toolbar', className)}>
      {leading !== undefined && <div className="sk-toolbar__leading">{leading}</div>}
      {title !== undefined && <div className="sk-toolbar__title">{title}</div>}
      <div className="sk-toolbar__spacer" />
      {trailing !== undefined && <div className="sk-toolbar__trailing">{trailing}</div>}
    </div>
  );
}
