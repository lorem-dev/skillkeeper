/**
 * A single sidebar navigation item: an optional leading icon, a label, and an
 * active state. Renders as a button. Generic -- no product knowledge.
 */
import type { ReactNode } from 'react';
import { cx } from '../../lib';

export interface SidebarItemProps {
  /** Leading icon (e.g. an <Icon />). */
  readonly icon?: ReactNode;
  /** The item label. */
  readonly children: ReactNode;
  readonly active?: boolean;
  readonly onClick?: () => void;
  readonly className?: string;
  /** Test id for driving navigation from an E2E spec (e.g. `nav-repositories`). */
  readonly 'data-testid'?: string;
}

export function SidebarItem({
  icon,
  children,
  active,
  onClick,
  className,
  'data-testid': testId,
}: SidebarItemProps) {
  return (
    <button
      type="button"
      className={cx('sk-sidebar-item', active === true && 'sk-sidebar-item--active', className)}
      onClick={onClick}
      aria-current={active === true ? 'page' : undefined}
      data-testid={testId}
    >
      {icon !== undefined && (
        <span className="sk-sidebar-item__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="sk-sidebar-item__label">{children}</span>
    </button>
  );
}
