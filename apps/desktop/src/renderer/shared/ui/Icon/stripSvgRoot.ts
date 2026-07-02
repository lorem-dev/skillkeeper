/**
 * Strip the outer `<svg ...>...</svg>` wrapper from raw SVG markup, returning
 * only the inner geometry. Icon assets are authored as complete standalone SVGs
 * (so each file renders as a valid image on its own), but the Icon component
 * supplies its own `<svg>` wrapper for size/color/a11y and injects only this
 * inner markup.
 */
export function stripSvgRoot(svg: string): string {
  return svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim();
}
