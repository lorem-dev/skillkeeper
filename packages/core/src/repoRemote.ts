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

/**
 * Canonicalize a Git remote URL so transport/format differences map to one
 * identity: the same repo reached via `git@host:org/repo.git`,
 * `ssh://git@host/org/repo`, or `https://host/org/repo` all normalize equally.
 * Used to match an installed skill to a tracked repository (and to re-adopt a
 * re-added repo). Returns `host/path` lowercased, without transport, user, port,
 * a trailing `.git`, or a trailing slash. Falls back to the trimmed input when
 * the shape is unrecognized.
 */
export function normalizeRemote(url: string): string {
  let s = url.trim();
  // scp-like: git@host:org/repo(.git) -> host/org/repo
  const scp = /^[^/@]+@([^:/]+):(.+)$/.exec(s);
  if (scp !== null) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    // scheme://[user@]host[:port]/path
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.+)$/.exec(s);
    if (withScheme !== null) {
      let rest = withScheme[1]!;
      const at = rest.lastIndexOf('@');
      if (at !== -1) rest = rest.slice(at + 1); // drop user[:pass]@
      // drop a :port right after the host
      rest = rest.replace(/^([^/]+):\d+\//, '$1/');
      s = rest;
    }
  }
  s = s.replace(/\/+$/, '').replace(/\.git$/, '');
  return s.toLowerCase();
}
