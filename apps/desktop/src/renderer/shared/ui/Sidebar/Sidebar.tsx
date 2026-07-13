/**
 * Sidebar: the leading-edge navigation surface (a glass panel). Compose with
 * SidebarItem. Generic -- no product knowledge. See design-system.md Section 8.6.
 */
import type { ReactNode } from 'react';
import { cx } from '../../lib';
import './Sidebar.scss';

export interface SidebarProps {
  /** Optional header shown above the items. */
  readonly title?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  /**
   * Render a draggable region at the very top (for a frameless window's
   * title-bar area, e.g. macOS traffic lights). It reserves its own height so
   * the first item clears the window controls, and moves the window when
   * dragged. Non-interactive, so it never intercepts a click.
   */
  readonly dragRegion?: boolean;
}

export function Sidebar({ title, children, className, dragRegion = false }: SidebarProps) {
  return (
    <nav className={cx('sk-sidebar', className)}>
      {dragRegion && <div className="sk-sidebar__drag" aria-hidden="true" />}
      {title !== undefined && <div className="sk-sidebar__title">{title}</div>}
      <div className="sk-sidebar__items">{children}</div>
    </nav>
  );
}
