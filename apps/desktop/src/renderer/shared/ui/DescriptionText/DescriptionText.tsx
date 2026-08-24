/**
 * DescriptionText: renders a parsed description (plain text interleaved with
 * links) while keeping the escaping property structural rather than
 * sanitizer-based.
 *
 * A text span becomes a React text child, which React escapes by
 * construction -- so a description containing `<script>` renders as those
 * literal characters, with no HTML string ever built and no sanitizer
 * anywhere in this path. A link span renders as a `<button>`, not an `<a>`:
 * there is deliberately no `href` for anything to navigate through. The click
 * hands the link's own `url` to `onOpenLink` and stops there -- this
 * component never resolves what "opening a link" means itself (that would
 * pull backend/bridge knowledge into `shared`, which stays generic), so the
 * caller wires `onOpenLink` to the backend command that actually opens it
 * (which validates the scheme before doing so).
 *
 * `spans` is shaped exactly like the backend's generated `DescriptionSpan`
 * (see `services/bridge`'s `mcp_description_spans`), declared locally so this
 * generic component has no dependency on the `services` layer -- any concrete
 * `DescriptionSpan[]` value satisfies it structurally.
 */
import { cx } from '../../lib';
import './DescriptionText.scss';

/** One piece of a parsed description: plain text, or a link with its own
 *  display text and target url. Structurally identical to the backend's
 *  generated `DescriptionSpan`. */
export type DescriptionSpan = { kind: 'text'; text: string } | { kind: 'link'; text: string; url: string };

export interface DescriptionTextProps {
  readonly spans: readonly DescriptionSpan[];
  /** Called with a link span's own `url` when its button is clicked. Never
   *  called with anything else -- not a text span's content, not a derived
   *  value. */
  readonly onOpenLink: (url: string) => void;
  readonly className?: string;
}

/** One span plus a stable React key. Keyed by position: spans never reorder
 *  once parsed, so a position-based key stays distinct even when two link
 *  spans repeat the same text and url. */
export type KeyedDescriptionSpan = DescriptionSpan & { readonly key: string };

export function spansToKeyedParts(spans: readonly DescriptionSpan[]): KeyedDescriptionSpan[] {
  return spans.map((span, index) => ({ ...span, key: String(index) }));
}

export function DescriptionText({ spans, onOpenLink, className }: DescriptionTextProps) {
  return (
    <span className={cx('sk-description', className)}>
      {spansToKeyedParts(spans).map((part) =>
        part.kind === 'text' ? (
          <span key={part.key}>{part.text}</span>
        ) : (
          <button
            key={part.key}
            type="button"
            className="sk-description__link"
            onClick={(e) => {
              e.stopPropagation();
              onOpenLink(part.url);
            }}
          >
            {part.text}
          </button>
        ),
      )}
    </span>
  );
}
