/**
 * Parse a Git remote URL into the fields the Repository model records. Pure and
 * dependency-free so both the CLI and the desktop main process share it.
 */
export interface ParsedRemote {
  readonly kind: 'github' | 'bitbucket' | 'generic';
  readonly transport: 'ssh' | 'https';
}

export function parseRemote(url: string): ParsedRemote {
  const kind = url.includes('github.com')
    ? 'github'
    : url.includes('bitbucket.org')
      ? 'bitbucket'
      : 'generic';
  const transport = url.startsWith('git@') || url.startsWith('ssh://') ? 'ssh' : 'https';
  return { kind, transport };
}
