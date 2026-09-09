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
import { spansToKeyedParts } from './spansToKeyedParts';
import type { DescriptionSpan } from './spansToKeyedParts';
import './DescriptionText.scss';

export interface DescriptionTextProps {
  readonly spans: readonly DescriptionSpan[];
  /** Called with a link span's own `url` when its button is clicked. Never
   *  called with anything else -- not a text span's content, not a derived
   *  value. */
  readonly onOpenLink: (url: string) => void;
  readonly className?: string;
  /** Test id for the rendered span. Generic passthrough -- DescriptionText
   *  has no product knowledge of it, a caller sets it only for the flows
   *  that need it. */
  readonly 'data-testid'?: string;
}

export function DescriptionText({ spans, onOpenLink, className, 'data-testid': testId }: DescriptionTextProps) {
  return (
    <span className={cx('sk-description', className)} data-testid={testId}>
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
