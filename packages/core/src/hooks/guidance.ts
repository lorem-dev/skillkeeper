/**
 * Manage SkillKeeper-owned guidance blocks in an agent guidance file
 * (CLAUDE.md, AGENTS.md, .cursorrules, ...). A block is a GUIDE.md / RULES.md
 * body wrapped in stable HTML-comment markers keyed by the skill's source
 * remote and id, so it can be updated in place or removed later by key -- even
 * when the source guide no longer exists.
 */

/** The block key: `<remote>; <id>`. */
export function guidanceKey(remote: string, id: string): string {
  return `${remote}; ${id}`;
}

/** The skill id shown in the marker: `group/name`, or `name` when ungrouped. */
export function skillGuidanceId(group: string | undefined, name: string): string {
  return group === undefined || group === '' ? name : `${group}/${name}`;
}

const startMarker = (key: string): string => `<!-- SKILLKEEPER_START: ${key} -->`;
const endMarker = (key: string): string => `<!-- SKILLKEEPER_END: ${key} -->`;

/** Line index range [start, end] of the block for `key`, or null. */
function findBlock(file: string, key: string): { start: number; end: number } | null {
  const lines = file.split('\n');
  const open = startMarker(key);
  const close = endMarker(key);
  let openLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (openLine === -1 && lines[i] === open) openLine = i;
    else if (openLine !== -1 && lines[i] === close) return { start: openLine, end: i };
  }
  return null;
}

/** True when a block for `key` is present. */
export function hasGuidanceBlock(file: string, key: string): boolean {
  return findBlock(file, key) !== null;
}

/**
 * Insert or replace the block for `key`. When it exists it is replaced in place
 * (position preserved); otherwise it is appended after the existing content,
 * separated by one blank line. The result always ends with a newline.
 */
export function upsertGuidanceBlock(file: string, key: string, body: string): string {
  const block = `${startMarker(key)}\n${body}\n${endMarker(key)}`;
  const existing = findBlock(file, key);
  if (existing !== null) {
    const lines = file.split('\n');
    const before = lines.slice(0, existing.start);
    const after = lines.slice(existing.end + 1);
    const out = [...before, ...block.split('\n'), ...after].join('\n');
    return out.endsWith('\n') ? out : `${out}\n`;
  }
  if (file.trim() === '') return `${block}\n`;
  const base = file.endsWith('\n') ? file : `${file}\n`;
  return `${base}\n${block}\n`;
}

/**
 * Remove the block for `key` (and a single blank line immediately before it, if
 * present). Returns the input unchanged when no such block exists.
 */
export function removeGuidanceBlock(file: string, key: string): string {
  const region = findBlock(file, key);
  if (region === null) return file;
  const lines = file.split('\n');
  let start = region.start;
  let end = region.end;
  if (start > 0 && lines[start - 1] === '') start -= 1;
  else if (lines[end + 1] === '') end += 1;
  const before = lines.slice(0, start);
  const after = lines.slice(end + 1);
  const joined = [...before, ...after].join('\n');
  return joined.trim() === '' ? '' : joined;
}

/**
 * Drop any SkillKeeper guidance marker lines from a guide body, so a marker that
 * appears literally inside a GUIDE.md / RULES.md cannot be mistaken for a block
 * boundary. Call this on a guide body before wrapping it in a block.
 */
export function stripGuidanceMarkers(body: string): string {
  return body
    .split('\n')
    .filter((line) => !/<!--\s*SKILLKEEPER_(?:START|END):/i.test(line))
    .join('\n');
}
