/**
 * ChangeBadge: a small filled circle with a knocked-out glyph, used to preview a
 * pending change. Five kinds:
 *   - `add`            -- green circle, a "+" cut out ("will be added")
 *   - `remove`         -- red circle, a "-" cut out ("will be removed")
 *   - `present`        -- gray circle, a check cut out ("already present")
 *   - `add-dependency` -- teal circle, a "+" cut out ("will be installed as a
 *                         dependency of something the user did ask for")
 *   - `broken`         -- orange circle, an "!" cut out ("a skill this one
 *                         needed is gone")
 *
 * The glyph is a true knockout (an SVG mask) so it shows the background through,
 * reading correctly on any row background. Generic -- no product knowledge; the
 * caller supplies the tooltip/label text. The badge is wrapped in a Tooltip.
 *
 * Non-interactive by default (a `role="img"` span). Passing `onClick` renders it
 * as a real button instead -- used by `broken`, which can be acted on (e.g. to
 * repair the missing dependency).
 *
 * Deliberate deviation from roving tabindex: a `TreeView` row is otherwise a
 * single tab stop (its interactive children get `tabIndex={-1}`, e.g. the
 * leaf `Checkbox`), but the interactive badge stays tabbable by default and is
 * its own tab stop. There is no row-level key bound to "repair", and wiring
 * one is outside this component's scope, so making the badge `tabIndex={-1}`
 * would make its action unreachable by keyboard entirely. A caller that later
 * wires a row-level key can still opt a specific badge out via the `tabIndex`
 * prop below.
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import { Tooltip } from '../Tooltip';
import { cx } from '../../lib';
import './ChangeBadge.scss';

export type ChangeBadgeKind = 'add' | 'remove' | 'present' | 'add-dependency' | 'broken';

export interface ChangeBadgeProps {
  readonly kind: ChangeBadgeKind;
  /** Tooltip text and accessible name. */
  readonly label: string;
  /**
   * Makes the badge a button. Used by `broken`, whose whole point is that it can
   * be acted on; without it the badge stays a non-interactive span.
   */
  readonly onClick?: () => void;
  /**
   * Pass-through for the rendered button's `tabIndex`. Left at the browser
   * default (tabbable) unless a caller opts a specific badge out, e.g. once a
   * row-level key exists to trigger the same action. Has no effect on the
   * non-interactive (no `onClick`) span form.
   */
  readonly tabIndex?: number;
  readonly className?: string;
}

// Black = knocked out of the mask, so the glyph shows the background through.
const GLYPH: Record<ChangeBadgeKind, ReactNode> = {
  add: <path d="M8 4.6 L8 11.4 M4.6 8 L11.4 8" stroke="black" strokeWidth="1.8" strokeLinecap="round" />,
  remove: <path d="M4.6 8 L11.4 8" stroke="black" strokeWidth="1.8" strokeLinecap="round" />,
  present: (
    <path
      d="M4.6 8.2 L7 10.6 L11.5 5.6"
      fill="none"
      stroke="black"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  // Same plus as `add`: a dependency install IS an add. Only the color says it
  // was chosen for you rather than by you.
  'add-dependency': <path d="M8 4.6 L8 11.4 M4.6 8 L11.4 8" stroke="black" strokeWidth="1.8" strokeLinecap="round" />,
  broken: (
    <>
      <path d="M8 4.2 L8 9" stroke="black" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="8" cy="11.6" r="1" fill="black" />
    </>
  ),
};

export function ChangeBadge({ kind, label, onClick, tabIndex, className }: ChangeBadgeProps) {
  // Unique per instance so multiple badges never collide on the mask id.
  const maskId = `sk-change-badge-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const glyph = (
    <svg viewBox="0 0 16 16" width="16" height="16">
      <mask id={maskId}>
        <rect width="16" height="16" fill="white" />
        {GLYPH[kind]}
      </mask>
      <circle cx="8" cy="8" r="8" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
  const classes = cx('sk-change-badge', `sk-change-badge--${kind}`, className);
  return (
    <Tooltip content={label}>
      {onClick === undefined ? (
        <span className={classes} role="img" aria-label={label}>
          {glyph}
        </span>
      ) : (
        <button
          type="button"
          tabIndex={tabIndex}
          className={cx(classes, 'sk-change-badge--button')}
          aria-label={label}
          onClick={(e) => {
            // The badge owns this click; the row behind it must not also act on
            // it (e.g. a TreeView leaf row toggles its checkbox on click).
            e.stopPropagation();
            onClick();
          }}
          onKeyDown={(e) => {
            // A `TreeView` row's onKeyDown reacts to any bubbled keydown with no
            // target check, so Enter/Space here would otherwise also fire the
            // row's own activation (toggle checkbox / expand) in addition to
            // this button's native click synthesis -- double-firing both
            // actions from one keystroke. Stop only Enter and Space: the
            // browser still synthesizes the click from the native button
            // activation, so `onClick` above still runs. Every other key
            // (arrows, Home, End) must keep bubbling so roving-tabindex tree
            // navigation still works while the badge has focus.
            if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
          }}
        >
          {glyph}
        </button>
      )}
    </Tooltip>
  );
}
