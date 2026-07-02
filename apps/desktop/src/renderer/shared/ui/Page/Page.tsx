/**
 * Generic page layout: a titled content column. No product knowledge -- the
 * concrete screens live in `pages/` and compose this. Styling is token-based and
 * co-located in Page.scss.
 */
import type { ReactNode } from 'react';
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
  return (
    <main className="sk-page">
      {toolbar ?? (title !== undefined && <h1 className="sk-page__title">{title}</h1>)}
      {children}
    </main>
  );
}
