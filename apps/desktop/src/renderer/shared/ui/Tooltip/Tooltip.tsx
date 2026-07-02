/**
 * Tooltip: a small label shown on hover/focus of its trigger, animated with
 * Framer Motion presence. Positioned on one of four sides; `auto` (the default)
 * measures the room around the trigger and picks a side that fits, then nudges
 * the bubble along its cross axis so it stays inside the window. Generic -- no
 * product knowledge.
 */
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cx, SK_DURATION, SK_EASE } from '../../lib';
import './Tooltip.scss';

/** Concrete sides. `auto` resolves to one of these at open time. */
type Side = 'top' | 'bottom' | 'left' | 'right';
export type TooltipPlacement = Side | 'auto';

export interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactNode;
  /** Side to render on. `auto` (default) picks a side that fits the window. */
  readonly placement?: TooltipPlacement;
  readonly className?: string;
}

/** Gap between trigger and bubble (matches the offset in Tooltip.scss). */
const GAP = 6;
/** Minimum gap kept between the bubble and the window edge. */
const EDGE_MARGIN = 8;
/** Side preference for `auto` when several fit. */
const AUTO_ORDER: readonly Side[] = ['top', 'bottom', 'right', 'left'];

// Reveal is opacity + scale only; the directional feel comes from the
// per-placement transform-origin in CSS, so the animation never fights the
// positional (left/top) placement.
const bubble = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: { duration: SK_DURATION.fast, ease: SK_EASE } },
  exit: { opacity: 0, scale: 0.96, transition: { duration: SK_DURATION.fast } },
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/** Room (px) between the trigger rect and each window edge. */
function roomOn(side: Side, trigger: DOMRect): number {
  switch (side) {
    case 'top':
      return trigger.top;
    case 'bottom':
      return window.innerHeight - trigger.bottom;
    case 'left':
      return trigger.left;
    case 'right':
      return window.innerWidth - trigger.right;
  }
}

/** First side (by preference) with room for the bubble; else the first choice. */
function pickSide(trigger: DOMRect, w: number, h: number): Side {
  const fits = (side: Side): boolean => {
    const extent = side === 'top' || side === 'bottom' ? h : w;
    return roomOn(side, trigger) >= extent + GAP + EDGE_MARGIN;
  };
  return AUTO_ORDER.find(fits) ?? 'top';
}

export function Tooltip({ content, children, placement = 'auto', className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<Side>(placement === 'auto' ? 'top' : placement);
  // Cross-axis offset (px) applied to the active edge's left/top.
  const [offset, setOffset] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  // Resolve the side (for `auto`) and the clamped cross-axis offset once the
  // bubble is in the DOM. Runs before paint, so there is no visible jump.
  // offsetWidth/Height are used because they ignore the scale reveal transform.
  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const el = bubbleRef.current;
    if (root === null || el === null) return;

    const trigger = root.getBoundingClientRect();
    const bw = el.offsetWidth;
    const bh = el.offsetHeight;
    const resolved = placement === 'auto' ? pickSide(trigger, bw, bh) : placement;

    let next: number;
    if (resolved === 'top' || resolved === 'bottom') {
      const centered = trigger.left + (root.offsetWidth - bw) / 2;
      const clamped = clamp(centered, EDGE_MARGIN, window.innerWidth - EDGE_MARGIN - bw);
      next = clamped - trigger.left;
    } else {
      const centered = trigger.top + (root.offsetHeight - bh) / 2;
      const clamped = clamp(centered, EDGE_MARGIN, window.innerHeight - EDGE_MARGIN - bh);
      next = clamped - trigger.top;
    }

    setSide(resolved);
    setOffset(next);
  }, [open, placement]);

  const horizontal = side === 'top' || side === 'bottom';
  const style: CSSProperties = horizontal
    ? ({ '--sk-tooltip-x': `${offset}px` } as CSSProperties)
    : ({ '--sk-tooltip-y': `${offset}px` } as CSSProperties);

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
            data-placement={side}
            style={style}
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
