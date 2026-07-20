/**
 * Glass refraction filter generator.
 *
 * Builds an SVG `<filter>` (as a data URI) that refracts the backdrop like glass:
 * a displacement map encodes X displacement in the red channel and Y in green,
 * with a blurred rounded-rect center kept neutral so the refraction concentrates
 * at the rim (which reads as a rounded glass edge). Optional chromatic aberration
 * displaces R/G/B at slightly different strengths and recombines them. Apply the
 * result inside `backdrop-filter: url()`.
 *
 * Displacement technique adapted from MIT-licensed open-source work.
 */

export interface DisplacementOptions {
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly depth: number;
  readonly strength?: number;
  readonly chromaticAberration?: number;
}

/** The displacement map: gray = no shift, R/G gradients = X/Y shift at the edges. */
function getDisplacementMap({
  width,
  height,
  radius,
  depth,
}: Omit<DisplacementOptions, 'strength' | 'chromaticAberration'>): string {
  return (
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(`<svg height="${height}" width="${width}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <style>.mix { mix-blend-mode: screen; }</style>
    <defs>
      <linearGradient id="Y" x1="0" x2="0" y1="${Math.ceil((radius / height) * 15)}%" y2="${Math.floor(100 - (radius / height) * 15)}%">
        <stop offset="0%" stop-color="#0F0" />
        <stop offset="100%" stop-color="#000" />
      </linearGradient>
      <linearGradient id="X" x1="${Math.ceil((radius / width) * 15)}%" x2="${Math.floor(100 - (radius / width) * 15)}%" y1="0" y2="0">
        <stop offset="0%" stop-color="#F00" />
        <stop offset="100%" stop-color="#000" />
      </linearGradient>
    </defs>
    <rect x="0" y="0" height="${height}" width="${width}" fill="#808080" />
    <g filter="blur(2px)">
      <rect x="0" y="0" height="${height}" width="${width}" fill="#000080" />
      <rect x="0" y="0" height="${height}" width="${width}" fill="url(#Y)" class="mix" />
      <rect x="0" y="0" height="${height}" width="${width}" fill="url(#X)" class="mix" />
      <rect x="${depth}" y="${depth}" height="${height - 2 * depth}" width="${width - 2 * depth}" fill="#808080" rx="${radius}" ry="${radius}" filter="blur(${depth}px)" />
    </g>
  </svg>`)
  );
}

/**
 * Build the full displacement filter as `data:...#displace`, sized to the
 * element. Pass the result to `backdrop-filter: url(...)`.
 */
export function getDisplacementFilter({
  width,
  height,
  radius,
  depth,
  strength = 100,
  chromaticAberration = 0,
}: DisplacementOptions): string {
  const map = getDisplacementMap({ width, height, radius, depth });
  return (
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(`<svg height="${height}" width="${width}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="displace" color-interpolation-filters="sRGB">
        <feImage x="0" y="0" height="${height}" width="${width}" href="${map}" result="displacementMap" />
        <feDisplacementMap transform-origin="center" in="SourceGraphic" in2="displacementMap" scale="${strength + chromaticAberration * 2}" xChannelSelector="R" yChannelSelector="G" />
        <feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="displacedR" />
        <feDisplacementMap in="SourceGraphic" in2="displacementMap" scale="${strength + chromaticAberration}" xChannelSelector="R" yChannelSelector="G" />
        <feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="displacedG" />
        <feDisplacementMap in="SourceGraphic" in2="displacementMap" scale="${strength}" xChannelSelector="R" yChannelSelector="G" />
        <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="displacedB" />
        <feBlend in="displacedR" in2="displacedG" mode="screen" />
        <feBlend in2="displacedB" mode="screen" />
      </filter>
    </defs>
  </svg>`) +
    '#displace'
  );
}

let urlBackdropSupport: boolean | undefined;

/**
 * Whether the engine actually *renders* an SVG `url(...)` backdrop filter (not
 * just parses it). Only Gecko does: Chromium and WebKit both accept the value
 * syntactically -- so a naive `el.style.backdropFilter === 'url(...)'` check is
 * a false positive on WebView2 (Windows) -- yet neither paints it (WebKit bug
 * 245510, and Chromium ignores SVG-referenced backdrop filters). When this is
 * false, callers fall back to plain blur + saturate, which every engine paints.
 */
export function supportsBackdropUrl(): boolean {
  if (urlBackdropSupport !== undefined) return urlBackdropSupport;
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return false;
  // Gecko is the only engine that paints url() backdrop filters. Chromium and
  // WebKit both carry a "like Gecko" compatibility token in their UA (no
  // version), so match the real "Gecko/<version>" token instead.
  const isGecko = /\bGecko\/\d/.test(navigator.userAgent);
  if (!isGecko) {
    urlBackdropSupport = false;
    return urlBackdropSupport;
  }
  const el = document.createElement('div');
  el.style.cssText = 'backdrop-filter: url(#test)';
  urlBackdropSupport =
    el.style.backdropFilter === 'url(#test)' || el.style.backdropFilter === 'url("#test")';
  return urlBackdropSupport;
}
