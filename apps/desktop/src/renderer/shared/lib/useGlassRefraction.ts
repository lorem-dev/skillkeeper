/**
 * Apply the glass refraction effect to an element's backdrop.
 *
 * Measures the element (and re-measures on resize) and sets a `backdrop-filter`
 * that refracts the content behind it, concentrated at the rim. Falls back to a
 * plain blur+saturate glass when `backdrop-filter: url(...)` is unsupported. The
 * element should clip its overflow (so the refraction stays inside the rounded
 * shape) and keep a tint + rim shine so it stays a readable panel.
 */
import { useEffect } from 'react';
import type { RefObject } from 'react';
import { getDisplacementFilter, supportsBackdropUrl } from './glassRefraction';

export interface GlassRefractionOptions {
  /** Edge refraction band, in px. */
  readonly depth?: number;
  /** Displacement intensity. */
  readonly strength?: number;
  /** Backdrop blur in px (keep small; large blur smears the refraction). */
  readonly blur?: number;
  /** RGB split at the edges. */
  readonly chromaticAberration?: number;
  readonly brightness?: number;
  readonly saturate?: number;
  /** Corner radius for the refraction map; defaults to the element's radius. */
  readonly radius?: number;
  /** Turn the effect off (leaves the element's CSS untouched). */
  readonly enabled?: boolean;
}

const FALLBACK = 'blur(8px) saturate(180%)';

export function useGlassRefraction<T extends HTMLElement>(
  ref: RefObject<T | null>,
  options: GlassRefractionOptions = {},
): void {
  const {
    depth = 8,
    // Keep the displacement and aberration gentle so the glass reads as a subtle
    // rim refraction, not a noisy/smeared distortion.
    strength = 40,
    blur = 2,
    chromaticAberration = 2,
    brightness = 1.05,
    saturate = 1.5,
    radius,
    enabled = true,
  } = options;

  useEffect(() => {
    const el = ref.current;
    if (el === null || !enabled) return undefined;

    const setFilter = (value: string): void => {
      el.style.backdropFilter = value;
      el.style.setProperty('-webkit-backdrop-filter', value);
    };

    const apply = (): void => {
      if (!supportsBackdropUrl()) {
        setFilter(FALLBACK);
        return;
      }
      const rect = el.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width === 0 || height === 0) return;
      // Clamp the radius to half the shortest side so the refraction follows the
      // element's actual rounded outline (pill caps, circle, rounded corners)
      // rather than a too-large literal border-radius.
      const parsed = Number.parseFloat(getComputedStyle(el).borderRadius);
      const rawRadius = radius ?? (Number.isNaN(parsed) ? 0 : parsed);
      const r = Math.min(rawRadius, width / 2, height / 2);
      const filter = getDisplacementFilter({
        width,
        height,
        radius: r,
        depth,
        strength,
        chromaticAberration,
      });
      setFilter(
        `blur(${blur}px) url('${filter}') brightness(${brightness}) saturate(${saturate})`,
      );
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, depth, strength, blur, chromaticAberration, brightness, saturate, radius, enabled]);
}
