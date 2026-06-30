/**
 * Disclosure group: a header with a rotating chevron that expands/collapses its
 * content. The collapse uses the CSS `grid-template-rows: 0fr -> 1fr` technique
 * so it animates smoothly with no height measurement and no jump; only the
 * chevron rotation uses Framer Motion. Desktop pattern from the desktop
 * reference (disclosure control). Generic -- no product knowledge.
 */
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { cx, SK_DURATION, SK_EASE } from '../../lib';
import './DisclosureGroup.scss';

export interface DisclosureGroupProps {
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly className?: string;
}

export function DisclosureGroup({
  title,
  children,
  defaultOpen = false,
  className,
}: DisclosureGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <div className={cx('sk-disclosure', className)}>
      <button
        type="button"
        className="sk-disclosure__trigger"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((o) => !o)}
      >
        <motion.span
          className="sk-disclosure__chevron"
          aria-hidden="true"
          animate={{ rotate: open ? 0 : -90 }}
          transition={{ duration: SK_DURATION.fast, ease: SK_EASE }}
        >
          <svg viewBox="0 0 12 12">
            <path
              d="M3 4.5 L6 7.5 L9 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </motion.span>
        <span className="sk-disclosure__title">{title}</span>
      </button>
      <div
        id={contentId}
        className={cx('sk-disclosure__wrap', open && 'sk-disclosure__wrap--open')}
        inert={!open}
      >
        <div className="sk-disclosure__inner">
          <div className="sk-disclosure__body">{children}</div>
        </div>
      </div>
    </div>
  );
}
