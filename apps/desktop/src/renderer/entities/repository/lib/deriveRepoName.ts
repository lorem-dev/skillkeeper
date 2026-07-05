/** Maximum length of a repository name (shared by the add/edit form inputs). */
export const MAX_REPO_NAME_LENGTH = 42;

/**
 * Suggest a human name from a Git remote: take the path segment before an
 * optional `.git`, split it into words (camelCase, kebab, snake, dot), and
 * Title-Case each. `my-cool-repo` -> "My Cool Repo". Capped at
 * {@link MAX_REPO_NAME_LENGTH} to match the form input limit.
 */
export function deriveRepoName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const last = trimmed.split(/[/:]/).pop() ?? '';
  const base = last.replace(/\.git$/i, '');
  return base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_.\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .slice(0, MAX_REPO_NAME_LENGTH);
}
