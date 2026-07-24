import type { CSSProperties, ReactNode } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/shared/ui';
import './Coachmark.scss';

export interface CoachmarkProps {
  /** The target element's bounding rect; `null` while there is nothing to
   *  anchor to yet (renders nothing). */
  readonly rect: DOMRect | null;
  /** Optional heading; omit for a body-only card. */
  readonly title?: string;
  readonly body: ReactNode;
  /** External doc link, opened via `onDocClick` -- omit both to hide the link. */
  readonly docHref?: string;
  readonly docLabel?: string;
  readonly onDocClick?: (href: string) => void;
  readonly onNext: () => void;
  readonly nextLabel: string;
  readonly onBack?: () => void;
  readonly backLabel?: string;
}

// Offset from the target rect. The overlay's spotlight ring inflates the target
// by ~6px per side, so this must clear that ring plus a comfortable visual
// margin -- keep a clear gap between the highlighted object and the card.
const GAP = 20;
const EDGE_MARGIN = 8;

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

interface Position {
  readonly top: number;
  readonly left: number;
}

// Prefer below the target; flip above when there is more room there than
// below. Clamp both axes into the viewport (minus EDGE_MARGIN) so the card
// always fits -- when the preferred side does not have enough room, it butts
// against the viewport edge instead of overflowing.
function computePosition(anchor: DOMRect, cardW: number, cardH: number): Position {
  const below = window.innerHeight - anchor.bottom - GAP - EDGE_MARGIN;
  const above = anchor.top - GAP - EDGE_MARGIN;
  const side: 'bottom' | 'top' = cardH <= below || below >= above ? 'bottom' : 'top';
  const rawTop = side === 'bottom' ? anchor.bottom + GAP : anchor.top - GAP - cardH;
  const top = clamp(rawTop, EDGE_MARGIN, window.innerHeight - EDGE_MARGIN - cardH);
  const left = clamp(anchor.left, EDGE_MARGIN, window.innerWidth - EDGE_MARGIN - cardW);
  return { top, left };
}

/**
 * A fixed-position callout anchored below (or, near a window edge, above or
 * clamped into) a target rect: title, body, an optional external doc link,
 * and a primary Next button. No Skip control here -- the overlay renders Skip
 * once, bottom-left, shared across steps.
 *
 * Positioning mirrors the Menu/MultiCombobox dropdown pattern: measure the
 * card's own size after render, flip above the target when there is not
 * enough room below, and clamp into the viewport on both axes so the card
 * never overflows the window. Renders hidden until the first measurement to
 * avoid a flash at the wrong spot, and recomputes on resize/scroll (and when
 * the target rect itself changes), rAF-coalesced.
 */
export function Coachmark({
  rect,
  title,
  body,
  docHref,
  docLabel,
  onDocClick,
  onNext,
  nextLabel,
  onBack,
  backLabel,
}: CoachmarkProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Position | null>(null);

  useLayoutEffect(() => {
    if (rect === null) {
      setPos(null);
      return undefined;
    }
    const place = (): void => {
      const card = cardRef.current;
      if (card === null) return;
      setPos(computePosition(rect, card.offsetWidth, card.offsetHeight));
    };
    place();
    // Coalesce scroll/resize bursts into one reposition per frame (each reads
    // layout and re-renders the card).
    let raf = 0;
    const onChange = (): void => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        place();
      });
    };
    window.addEventListener('resize', onChange);
    window.addEventListener('scroll', onChange, true);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
  }, [rect]);

  if (rect === null) return null;

  const style: CSSProperties = {
    position: 'fixed',
    top: pos?.top ?? 0,
    left: pos?.left ?? 0,
    visibility: pos === null ? 'hidden' : 'visible',
  };

  return (
    <div ref={cardRef} className="sk-coachmark" style={style} role="dialog" aria-modal="true">
      {title !== undefined && <div className="sk-coachmark__title">{title}</div>}
      <div className="sk-coachmark__body">{body}</div>
      {docHref !== undefined && docLabel !== undefined && (
        <button type="button" className="sk-coachmark__doc" onClick={() => onDocClick?.(docHref)}>
          {docLabel}
        </button>
      )}
      <div className="sk-coachmark__actions">
        {onBack !== undefined && backLabel !== undefined && (
          <Button variant="secondary" onClick={onBack}>
            {backLabel}
          </Button>
        )}
        <Button variant="primary" glass onClick={onNext}>
          {nextLabel}
        </Button>
      </div>
    </div>
  );
}
