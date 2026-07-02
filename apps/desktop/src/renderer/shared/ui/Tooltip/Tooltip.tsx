/**
 * Tooltip: a small label shown on hover/focus of its trigger, animated with
 * Framer Motion presence. Generic -- no product knowledge.
 */
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cx, SK_DURATION, SK_EASE } from '../../lib';
import './Tooltip.scss';

export interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/** Gap kept between the bubble and the window edge when it would overflow. */
const EDGE_MARGIN = 8;

// Centering uses x:'-50%' inside the motion transform so it composes with scale.
const bubble = {
  initial: { opacity: 0, scale: 0.96, x: '-50%' },
  animate: {
    opacity: 1,
    scale: 1,
    x: '-50%',
    transition: { duration: SK_DURATION.fast, ease: SK_EASE },
  },
  exit: { opacity: 0, scale: 0.96, x: '-50%', transition: { duration: SK_DURATION.fast } },
};

export function Tooltip({ content, children, className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  // Horizontal nudge (px) applied to the centered bubble so it stays inside the
  // window when the trigger sits near an edge.
  const [shift, setShift] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  // The bubble is centered over the trigger (left: 50% + translateX(-50%)). Once
  // it is in the DOM, measure where its edges land and shift it back inside the
  // window. offsetWidth is used because it ignores the scale reveal transform.
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const root = rootRef.current;
    const el = bubbleRef.current;
    if (root === null || el === null) return;
    const centerX = root.getBoundingClientRect().left + root.offsetWidth / 2;
    const halfWidth = el.offsetWidth / 2;
    let next = 0;
    if (centerX - halfWidth < EDGE_MARGIN) {
      next = EDGE_MARGIN - (centerX - halfWidth);
    } else if (centerX + halfWidth > window.innerWidth - EDGE_MARGIN) {
      next = window.innerWidth - EDGE_MARGIN - (centerX + halfWidth);
    }
    setShift(next);
  }, [open]);

  return (
    <span
      ref={rootRef}
      className={cx('sk-tooltip', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined}>{children}</span>
      <AnimatePresence>
        {open && (
          <motion.span
            ref={bubbleRef}
            role="tooltip"
            id={id}
            className="sk-tooltip__bubble"
            style={{ '--sk-tooltip-shift': `${shift}px` } as CSSProperties}
            variants={bubble}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {content}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
