/**
 * Warn about a remote URL whose port will be silently ignored.
 *
 * In the scp-like form (`user@host:something`) everything after the colon is a
 * PATH, not a port, so `git@host:2222/team/repo.git` asks for the path
 * `2222/team/repo.git` on the default port 22. Git accepts it, the server
 * answers, and the failure surfaces much later as `Permission denied
 * (publickey)` -- with nothing pointing at the port. A port can only be
 * expressed by a URL with a scheme.
 */
export function scpPortMistake(url: string): boolean {
  return /^[\w.+-]+@[\w.-]+:\d+(?:\/|$)/.test(url.trim());
}

/** The same remote rewritten with a scheme, which can carry the port. */
export function asSchemeUrl(url: string): string {
  const match = /^([\w.+-]+)@([\w.-]+):(\d+)\/?(.*)$/.exec(url.trim());
  if (match === null) return url;
  const [, user, host, port, path] = match;
  return `ssh://${user}@${host}:${port}/${path}`;
}
