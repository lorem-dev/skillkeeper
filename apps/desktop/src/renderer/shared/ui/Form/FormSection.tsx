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
  /** Test id for this section container (a KIND, e.g. `settings-section` --
   *  never a per-instance value). Generic passthrough: FormSection has no
   *  product knowledge of it, a caller sets it only for the flows that need
   *  it. */
  readonly 'data-testid'?: string;
  /** An identity for this section (e.g. `general`), rendered as
   *  `data-section-id` on the title -- a CHILD of the section, never the
   *  section itself, per the e2e identity-is-a-separate-attribute convention
   *  (mirrors `TreeNode.identity`). Only meaningful when `title` is set. */
  readonly sectionId?: string;
}

export function FormSection({
  title,
  footer,
  children,
  className,
  'data-testid': testId,
  sectionId,
}: FormSectionProps) {
  return (
    <section className={cx('sk-form-section', className)} data-testid={testId}>
      {title !== undefined && (
        <h2 className="sk-form-section__title" data-section-id={sectionId}>
          {title}
        </h2>
      )}
      <div className="sk-form-section__body" role="group">
        {children}
      </div>
      {footer !== undefined && <p className="sk-form-section__footer">{footer}</p>}
    </section>
  );
}
