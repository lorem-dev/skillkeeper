/**
 * The description span model and its React keying.
 *
 * Kept out of `DescriptionText.tsx` for two reasons that point the same way.
 * Renderer tests here are node-only -- no jsdom, no testing-library -- so a
 * component cannot be unit tested and pure logic has to live where a test can
 * reach it. And exporting a function from a file that also exports a component
 * breaks fast refresh, which is what `react-refresh/only-export-components`
 * reported for as long as this lived there.
 *
 * Same split, for the same reason, as
 * `features/skillInstall/lib/installSelection.ts`.
 */

/** One piece of a parsed description: plain text, or a link with its own
 *  display text and target url. Structurally identical to the backend's
 *  generated `DescriptionSpan`, declared locally so this generic component has
 *  no dependency on the `services` layer -- any concrete `DescriptionSpan[]`
 *  value satisfies it. */
export type DescriptionSpan = { kind: 'text'; text: string } | { kind: 'link'; text: string; url: string };

/** One span plus a stable React key. Keyed by position: spans never reorder
 *  once parsed, so a position-based key stays distinct even when two link
 *  spans repeat the same text and url. */
export type KeyedDescriptionSpan = DescriptionSpan & { readonly key: string };

export function spansToKeyedParts(spans: readonly DescriptionSpan[]): KeyedDescriptionSpan[] {
  return spans.map((span, index) => ({ ...span, key: String(index) }));
}
