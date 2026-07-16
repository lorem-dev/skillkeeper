/**
 * Route loaders for the app shell. Each view maps to the dynamic import of its
 * page-group module; the two sub-views of a group share one chunk. `React.lazy`
 * (in App) and `preloadView` (load-then-swap navigation) call the SAME loader,
 * so the bundler emits one chunk per group and the second call is served from
 * the module cache.
 */
export type View =
  | 'repositories'
  | 'skills-components'
  | 'skills-management'
  | 'projects'
  | 'mcp-components'
  | 'mcp-management'
  | 'settings';

export const VIEW_LOADERS: Record<View, () => Promise<unknown>> = {
  repositories: () => import('@/pages/Repositories'),
  'skills-components': () => import('@/pages/Skills'),
  'skills-management': () => import('@/pages/Skills'),
  projects: () => import('@/pages/Projects'),
  'mcp-components': () => import('@/pages/Mcp'),
  'mcp-management': () => import('@/pages/Mcp'),
  settings: () => import('@/pages/Settings'),
};

/** Ensure a view's page chunk is loaded before it is shown (load-then-swap). */
export function preloadView(
  view: View,
  loaders: Record<View, () => Promise<unknown>> = VIEW_LOADERS,
): Promise<void> {
  return loaders[view]().then(() => undefined);
}
