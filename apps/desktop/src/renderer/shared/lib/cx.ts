/**
 * Join class names, dropping falsy values. A tiny dependency-free helper for
 * conditional class composition (no product knowledge -> lives in shared).
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
