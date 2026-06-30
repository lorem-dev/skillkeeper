/** Locale-agnostic, ASCII date: the YYYY-MM-DD portion of an ISO timestamp. */
export function formatDate(iso?: string): string {
  if (iso === undefined || iso === '') return '';
  return iso.slice(0, 10);
}

/** A version string prefixed with `v`, or null when absent. */
export function formatVersion(v?: string): string | null {
  if (v === undefined || v === '') return null;
  return `v${v}`;
}
