import { useEffect, useState } from 'react';
import type { AnchorId } from '../model/steps';
import { getAnchorElement } from '../model/anchors';

/**
 * The registered anchor's viewport rect, followed every frame while the id is
 * set. Returns null while the anchor is unregistered/unmeasured.
 *
 * A `requestAnimationFrame` loop (rather than scroll/resize listeners or a
 * `ResizeObserver`) is used deliberately: the anchor buttons live in the
 * Page dock, which slides in via a CSS transform. `getBoundingClientRect`
 * reflects that in-flight transform, but scroll/resize events do not fire
 * during a transform animation and a `ResizeObserver` only reacts to size
 * changes, not position -- so either approach would freeze the ring at the
 * mid-animation position (e.g. below the button's resting spot). The loop
 * follows the element to its final position and keeps up with any later
 * layout shift. State updates only when the measured box actually changes,
 * so idle frames trigger no re-render. It runs only while a spotlight step is
 * active (the overlay passes `undefined` otherwise), so the cost is bounded.
 */
export function useAnchorRect(id: AnchorId | undefined): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (id === undefined) {
      setRect(null);
      return undefined;
    }
    let raf = 0;
    // The last box we pushed to state; used to skip redundant updates.
    let last: { top: number; left: number; width: number; height: number } | null = null;
    const tick = (): void => {
      const el = getAnchorElement(id);
      if (el === null) {
        if (last !== null) {
          last = null;
          setRect(null);
        }
      } else {
        const r = el.getBoundingClientRect();
        if (
          last === null ||
          last.top !== r.top ||
          last.left !== r.left ||
          last.width !== r.width ||
          last.height !== r.height
        ) {
          last = { top: r.top, left: r.left, width: r.width, height: r.height };
          setRect(r);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [id]);

  return rect;
}
