/**
 * Form section: an inset-grouped container that stacks FormRows on a rounded
 * surface with hairline separators, with an optional section title and footer.
 * Generic -- no product knowledge. See design-system.md Section 8.5.
 */
import type { ReactNode } from 'react';
import { cx } from '../../lib';
import './FormSection.scss';

export interface FormSectionProps {
  /** Uppercase section header shown above the group. */
  readonly title?: ReactNode;
  /** Caption shown below the group. */
  readonly footer?: ReactNode;
  /** FormRows (or any rows). */
  readonly children: ReactNode;
  readonly className?: string;
}

export function FormSection({ title, footer, children, className }: FormSectionProps) {
  return (
    <section className={cx('sk-form-section', className)}>
      {title !== undefined && <h2 className="sk-form-section__title">{title}</h2>}
      <div className="sk-form-section__body" role="group">
        {children}
      </div>
      {footer !== undefined && <p className="sk-form-section__footer">{footer}</p>}
    </section>
  );
}
