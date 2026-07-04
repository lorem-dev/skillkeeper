/**
 * Generic page layout: a scrollable content column with a sticky header. No
 * product knowledge -- the concrete screens live in `pages/` and compose this.
 *
 * The header (a Toolbar via the `toolbar` slot, or a plain title) stays pinned
 * to the top while the body scrolls under it; a progressive-blur backdrop blurs
 * the content passing beneath. Styling is token-based and co-located in
 * Page.scss.
 */
import type { ReactNode } from 'react';
import { Row } from '../Row';
import './Page.scss';

export interface PageProps {
  /** Page heading. Optional when a `toolbar` supplies the heading instead. */
  readonly title?: string;
  /**
   * Optional Toolbar rendered as the page header. When provided it supplies the
   * heading (its own title) and any trailing actions, and the default title
   * `<h1>` is not rendered. See shared/ui Toolbar.
   */
  readonly toolbar?: ReactNode;
  readonly children?: ReactNode;
}

export function Page({ title, toolbar, children }: PageProps) {
  const header =
    toolbar ??
    (title !== undefined ? (
      <Row className="sk-page__title-row">
        <h1 className="sk-page__title">{title}</h1>
      </Row>
    ) : null);

  return (
    <main className="sk-page">
      {header != null && <div className="sk-page__header">{header}</div>}
      <div className="sk-page__body">{children}</div>
    </main>
  );
}
