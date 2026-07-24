import { Fragment } from 'react';
import type { ReactNode } from 'react';

/**
 * Split a translated string on `{token}` placeholders and interleave the
 * matching React node from `icons` at each placeholder, so real icon elements
 * render inline in the sentence. Call the translator WITHOUT interpolation vars
 * (so the `{token}` stays literal in the string); unknown tokens are left as
 * literal text. Returns a node array safe to render as JSX children.
 */
export function interleaveIcons(text: string, icons: Record<string, ReactNode>): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[1] ?? '';
    const node = icons[token];
    out.push(
      node !== undefined ? (
        <span key={`icon-${key}`} className="sk-onboarding__inline-badge">
          {node}
        </span>
      ) : (
        <Fragment key={`txt-${key}`}>{match[0]}</Fragment>
      ),
    );
    key += 1;
    last = match.index + match[0].length;
    match = re.exec(text);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
