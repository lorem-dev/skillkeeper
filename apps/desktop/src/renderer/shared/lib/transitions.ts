/**
 * Shared Framer Motion presets, kept in sync with the CSS motion tokens
 * (--sk-ease-standard, --sk-duration-*) so JS and CSS animations match.
 *
 * Components should reach for these variants rather than hand-rolling timings.
 * Framer Motion honors `prefers-reduced-motion` when components use the
 * `useReducedMotion` hook; for presence transitions the durations below are
 * already short.
 */
import type { Transition, Variants } from 'motion/react';

/** Standard easing curve (matches --sk-ease-standard). */
export const SK_EASE = [0.32, 0.72, 0, 1] as const;

/** Pronounced ease-out (decelerates strongly toward the end). */
export const SK_EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** Durations in seconds (match --sk-duration-*). */
export const SK_DURATION = { fast: 0.15, medium: 0.25, slow: 0.35 } as const;

export const transitionFast: Transition = { duration: SK_DURATION.fast, ease: SK_EASE };
export const transitionMedium: Transition = { duration: SK_DURATION.medium, ease: SK_EASE };
export const transitionSlow: Transition = { duration: SK_DURATION.slow, ease: SK_EASE };

/** Fade in/out. */
export const fade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: transitionFast },
  exit: { opacity: 0, transition: transitionFast },
};

/** Fade + slight scale, for overlays anchored to a point (tooltips, menus). */
export const fadeScale: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: transitionFast },
  exit: { opacity: 0, scale: 0.96, transition: transitionFast },
};

/** Fade + rise, for sheets/modals and banners entering from slightly below. */
export const fadeRise: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: transitionMedium },
  exit: { opacity: 0, y: 8, transition: transitionFast },
};

/**
 * Cards sliding in from the right, one after another -- a quick entrance
 * stagger for list/grid pages on open. `custom` is the item index (pass it via
 * `custom={i}` on each motion child); the per-item delay is capped so long
 * lists still finish quickly. Each card eases a touch slower than the page
 * title (see `titleEnter`) so the title leads and the cards follow.
 */
export const cardStagger: Variants = {
  initial: { opacity: 0, x: 24, filter: 'blur(4px)' },
  animate: (i = 0) => ({
    opacity: 1,
    x: 0,
    // A small motion blur while it slides, resolving to sharp as it settles.
    filter: 'blur(0px)',
    transition: { ...transitionSlow, delay: Math.min(i, 14) * 0.035 },
  }),
  exit: { opacity: 0, x: 24, filter: 'blur(4px)', transition: transitionFast },
};

/**
 * Bottom-dock buttons: fade + slide up from below, on a slow ease-out curve
 * (decelerates to the end). The container (`dockContainer`) staggers them so
 * they appear one after another.
 */
export const dockButton: Variants = {
  initial: { opacity: 0, y: 10, filter: 'blur(4px)' },
  // A small motion blur while it moves, resolving to sharp as it settles.
  animate: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.5, ease: SK_EASE_OUT } },
  exit: { opacity: 0, y: 10, filter: 'blur(4px)', transition: { duration: 0.4, ease: SK_EASE_OUT } },
};

/** Orchestrates the dock buttons' entrance/exit stagger (in order). */
export const dockContainer: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.07 } },
  exit: { transition: { staggerChildren: 0.07 } },
};

/** Collapse height + fade, for inline banners/alerts joining/leaving a column. */
export const collapse: Variants = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: 'auto', transition: transitionMedium },
  exit: { opacity: 0, height: 0, transition: transitionFast },
};
