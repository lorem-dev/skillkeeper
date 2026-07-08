/**
 * Glass surface: a translucent panel whose backdrop is refracted like glass
 * (displacement concentrated at the rim, so the edge reads as a rounded glass
 * lens), with a directional edge highlight. Generic -- no product knowledge.
 *
 * The refraction is applied by the useGlassRefraction hook; the CSS clips it to
 * the rounded shape and keeps a tint + rim shine so the panel stays readable
 * even where the displacement filter cannot render.
 */
import { useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { cx, useGlassRefraction } from '../../lib';
import type { GlassRefractionOptions } from '../../lib';
import './GlassSurface.scss';

export interface GlassSurfaceProps extends GlassRefractionOptions {
  readonly children?: ReactNode;
  readonly className?: string;
  /**
   * Brightness of the gradient rim border, as a multiplier of its opacity.
   * Default 1; set lower (e.g. 0.5) to dim the rim, higher (>1) to intensify it.
   */
  readonly borderBrightness?: number;
}

export function GlassSurface({ children, className, borderBrightness, ...options }: GlassSurfaceProps) {
  const ref = useRef<HTMLDivElement>(null);
  // A slightly stronger default backdrop blur reads as more solid frosted glass;
  // callers can still override `blur` via props.
  useGlassRefraction(ref, { blur: 4, ...options });
  const style =
    borderBrightness !== undefined
      ? ({ '--sk-glass-border-strength': borderBrightness } as CSSProperties)
      : undefined;
  return (
    <div ref={ref} className={cx('sk-glass-surface', className)} style={style}>
      {children}
    </div>
  );
}
