/**
 * Generic page layout: a titled content column. No product knowledge -- the
 * concrete screens live in `pages/` and compose this. Styling is token-based and
 * co-located in Page.scss.
 */
import type { ReactNode } from 'react';
import './Page.scss';

export interface PageProps {
  readonly title: string;
  readonly children?: ReactNode;
}

export function Page({ title, children }: PageProps) {
  return (
    <main className="sk-page">
      <h1 className="sk-page__title">{title}</h1>
      {children}
    </main>
  );
}
