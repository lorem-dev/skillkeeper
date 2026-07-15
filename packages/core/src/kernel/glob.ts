/**
 * Minimal glob matching for skill paths and executable patterns. Supports `*`
 * (within a path segment), `**` (across segments, with `a/**` also matching
 * `a`), and `?` (a single non-separator character). All other characters are
 * matched literally.
 */

/** Translate a glob to a RegExp anchored to the whole path. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '/' && glob[i + 1] === '*' && glob[i + 2] === '*') {
      // `/**` matches the parent directory itself and any descendant.
      re += '(?:/.*)?';
      i += 2;
      if (glob[i + 1] === '/') i++;
    } else if (ch === '*') {
      if (glob[i + 1] === '*') {
        // A leading `**` matches across path separators.
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        // `*` matches within a single path segment.
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch !== undefined && '.+^${}()|[]\\'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when `path` matches any of the given globs. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
