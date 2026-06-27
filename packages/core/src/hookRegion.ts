/**
 * Delimited-text hook strategy: manage an owned, comment-delimited region in a
 * comment-capable file (shell rc, Markdown, YAML, TOML). The region is bounded
 * by stable markers that carry a `delimiterId` so the exact block can be found
 * and removed later even if the surrounding content changed.
 */

/** The sentinel substring that identifies a SkillKeeper-managed region. */
const SENTINEL = 'skillkeeper:hook';

/**
 * Guard token used to neutralize foreign occurrences of the sentinel so user
 * content cannot be mistaken for a managed region. Chosen to be unlikely to
 * appear naturally and reversible via doubling.
 */
const GUARD = 'SK7HOOKGUARD7';

/** Options for {@link wrapRegion}. */
export interface WrapRegionOptions {
  /** Opening comment token for the target file type (`#`, `//`, `<!--`). */
  readonly commentToken: string;
  /** Optional closing comment token (for example `-->` for HTML). */
  readonly commentClose?: string;
  /** Stable identifier embedded in both markers. */
  readonly delimiterId: string;
  /** Human-readable label, typically `<group>/<name>:<hookName>`. */
  readonly label: string;
  /** Optional version shown on the opening marker. */
  readonly version?: string;
  /** The generated content placed between the markers. */
  readonly content: string;
}

/** Insertion position for {@link insertRegion}. */
export type InsertMode = 'append' | 'prepend';

function openMarker(opts: WrapRegionOptions): string {
  const version = opts.version === undefined ? '' : `v${opts.version} `;
  const core = `>>> ${SENTINEL} ${opts.label} ${version}[${opts.delimiterId}] >>>`;
  const close = opts.commentClose === undefined ? '' : ` ${opts.commentClose}`;
  return `${opts.commentToken} ${core}${close}`;
}

function closeMarker(opts: WrapRegionOptions): string {
  const core = `<<< ${SENTINEL} ${opts.label} [${opts.delimiterId}] <<<`;
  const close = opts.commentClose === undefined ? '' : ` ${opts.commentClose}`;
  return `${opts.commentToken} ${core}${close}`;
}

/**
 * Build a delimited region block (open marker, content, close marker) with no
 * trailing newline. Use {@link insertRegion} to place it into a file.
 */
export function wrapRegion(opts: WrapRegionOptions): string {
  return `${openMarker(opts)}\n${opts.content}\n${closeMarker(opts)}`;
}

/** Index range of the managed region identified by `delimiterId`, or null. */
function findRegion(file: string, delimiterId: string): { start: number; end: number } | null {
  const lines = file.split('\n');
  const openNeedle = `[${delimiterId}] >>>`;
  const closeNeedle = `[${delimiterId}] <<<`;
  let openLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (openLine === -1 && line.includes(SENTINEL) && line.includes(openNeedle)) {
      openLine = i;
    } else if (openLine !== -1 && line.includes(SENTINEL) && line.includes(closeNeedle)) {
      return { start: openLine, end: i };
    }
  }
  return null;
}

/**
 * Extract the exact region block text (open marker through close marker) for
 * `delimiterId`, or undefined when no such region exists. Used by verify to
 * recompute a region's content hash.
 */
export function extractRegion(file: string, delimiterId: string): string | undefined {
  const region = findRegion(file, delimiterId);
  if (region === null) return undefined;
  return file
    .split('\n')
    .slice(region.start, region.end + 1)
    .join('\n');
}

/**
 * Insert a region block into a file. If a region with the same `delimiterId`
 * already exists it is replaced in place (idempotent); otherwise the block is
 * appended or prepended per `mode`. The result always ends with a newline.
 */
export function insertRegion(file: string, block: string, mode: InsertMode): string {
  const idMatch = /\[([^\]]+)\] >>>/.exec(block);
  const delimiterId = idMatch?.[1];
  if (delimiterId !== undefined) {
    const existing = findRegion(file, delimiterId);
    if (existing !== null) {
      const lines = file.split('\n');
      const before = lines.slice(0, existing.start);
      const after = lines.slice(existing.end + 1);
      return [...before, ...block.split('\n'), ...after].join('\n');
    }
  }
  if (file === '') return `${block}\n`;
  const base = file.endsWith('\n') ? file : `${file}\n`;
  return mode === 'append' ? `${base}${block}\n` : `${block}\n${base}`;
}

/**
 * Remove exactly the managed region identified by `delimiterId`, including the
 * region's own trailing newline. Surrounding content is preserved. Returns the
 * input unchanged when no such region exists.
 */
export function removeRegion(file: string, delimiterId: string): string {
  const region = findRegion(file, delimiterId);
  if (region === null) return file;
  const lines = file.split('\n');
  // Drop the region lines plus a single following blank-less newline by simply
  // removing the lines; rejoining collapses the gap cleanly.
  const kept = [...lines.slice(0, region.start), ...lines.slice(region.end + 1)];
  return kept.join('\n');
}

/**
 * Escape any foreign occurrence of the managed-region sentinel in arbitrary
 * content so it cannot be parsed as a real delimiter. Reversible via
 * {@link decapsulateForeignDelimiters}.
 */
export function encapsulateForeignDelimiters(content: string): string {
  // Protect literal guard tokens by doubling them first, then break the
  // sentinel with a single guard so it no longer reads as "skillkeeper:hook".
  return content
    .split(GUARD)
    .join(GUARD + GUARD)
    .split(SENTINEL)
    .join(`skillkeeper:${GUARD}hook`);
}

/** Inverse of {@link encapsulateForeignDelimiters}. */
export function decapsulateForeignDelimiters(content: string): string {
  return content
    .split(`skillkeeper:${GUARD}hook`)
    .join(SENTINEL)
    .split(GUARD + GUARD)
    .join(GUARD);
}
