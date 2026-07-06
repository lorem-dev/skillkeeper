/**
 * ChangeBadge: a small filled circle with a knocked-out glyph, used to preview a
 * pending change. Three kinds:
 *   - `add`     -- green circle, a "+" cut out ("will be added")
 *   - `remove`  -- red circle, a "-" cut out ("will be removed")
 *   - `present` -- gray circle, a check cut out ("already present")
 *
 * The glyph is a true knockout (an SVG mask) so it shows the background through,
 * reading correctly on any row background. Generic -- no product knowledge; the
 * caller supplies the tooltip/label text. The badge is wrapped in a Tooltip.
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import { Tooltip } from '../Tooltip';
import { cx } from '../../lib';
import './ChangeBadge.scss';

export type ChangeBadgeKind = 'add' | 'remove' | 'present';

export interface ChangeBadgeProps {
  readonly kind: ChangeBadgeKind;
  /** Tooltip text and accessible name. */
  readonly label: string;
  readonly className?: string;
}

// Black = knocked out of the mask, so the glyph shows the background through.
const GLYPH: Record<ChangeBadgeKind, ReactNode> = {
  add: (
    <path
      d="M8 4.6 L8 11.4 M4.6 8 L11.4 8"
      stroke="black"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  ),
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
};

export function ChangeBadge({ kind, label, className }: ChangeBadgeProps) {
  // Unique per instance so multiple badges never collide on the mask id.
  const maskId = `sk-change-badge-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <Tooltip content={label}>
      <span
        className={cx('sk-change-badge', `sk-change-badge--${kind}`, className)}
        role="img"
        aria-label={label}
      >
        <svg viewBox="0 0 16 16" width="16" height="16">
          <mask id={maskId}>
            <rect width="16" height="16" fill="white" />
            {GLYPH[kind]}
          </mask>
          <circle cx="8" cy="8" r="8" fill="currentColor" mask={`url(#${maskId})`} />
        </svg>
      </span>
    </Tooltip>
  );
}
