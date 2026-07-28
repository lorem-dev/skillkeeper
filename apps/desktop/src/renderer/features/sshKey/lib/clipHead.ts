/**
 * Head-clipping for a path that does not fit its control: the file name is what
 * identifies a key, the directories above it are the same for every key, so the
 * text loses its beginning rather than its end.
 *
 * Done here rather than with CSS because the CSS route (right-to-left flow so
 * that `text-overflow` bites at the start) reorders the path's own leading
 * slash to the far end, which renders as a stray trailing separator.
 */

/** The marker standing in for the dropped beginning. */
export const HEAD_ELLIPSIS = '...';

/**
 * The longest tail of `text` that fits `maxWidth`, prefixed with an ellipsis, or
 * `text` itself when it already fits. `measure` reports the rendered width of a
 * string, so this stays a pure function and is testable without a DOM.
 */
export function clipHead(text: string, maxWidth: number, measure: (s: string) => number): string {
  if (maxWidth <= 0) return text;
  if (measure(text) <= maxWidth) return text;
  // The wider the cut, the narrower the result, so the smallest cut that fits
  // can be found by bisection. `lo` never fits, `hi` always does.
  let lo = 0;
  let hi = text.length;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (measure(HEAD_ELLIPSIS + text.slice(mid)) <= maxWidth) hi = mid;
    else lo = mid;
  }
  const clipped = HEAD_ELLIPSIS + text.slice(hi);
  // Nothing fits, not even one character beside the marker: show the marker, so
  // the control still says "there is a path here" instead of going blank.
  return measure(clipped) <= maxWidth ? clipped : HEAD_ELLIPSIS;
}
