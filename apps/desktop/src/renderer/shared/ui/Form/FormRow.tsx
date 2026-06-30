/**
 * Form row: a label (+ optional description) on the leading edge and a control
 * on the trailing edge, vertically aligned. Drop any control in as children and
 * it sits neatly to the right. Generic -- no product knowledge.
 * See design-system.md Section 8.5 (grouped rows).
 */
import type { ReactNode } from 'react';
import { cx } from '../../lib';
import './FormRow.scss';

export interface FormRowProps {
  readonly label?: ReactNode;
  /** Secondary line under the label. */
  readonly description?: ReactNode;
  /** The control to place at the trailing edge. */
  readonly children?: ReactNode;
  /** Associates the label with a control `id` (use for a single labelled input). */
  readonly htmlFor?: string;
  /** Vertical alignment of label vs control. `top` suits multi-line controls. */
  readonly align?: 'center' | 'top';
  readonly className?: string;
}

export function FormRow({
  label,
  description,
  children,
  htmlFor,
  align = 'center',
  className,
}: FormRowProps) {
  const hasLabel = label !== undefined || description !== undefined;
  return (
    <div className={cx('sk-form-row', `sk-form-row--${align}`, className)}>
      {hasLabel && (
        <label className="sk-form-row__label" htmlFor={htmlFor}>
          {label !== undefined && <span className="sk-form-row__label-text">{label}</span>}
          {description !== undefined && <span className="sk-form-row__desc">{description}</span>}
        </label>
      )}
      {children !== undefined && <div className="sk-form-row__control">{children}</div>}
    </div>
  );
}
