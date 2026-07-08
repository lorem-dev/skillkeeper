/**
 * Resolve a project's display icon from a few conventional locations and return
 * it as a data URL, or undefined. Runs in the main process (Node fs); only the
 * project's own folder is read.
 *
 * The image passes a quick, cheap "is this a safe image" check before it is
 * handed to the renderer:
 *   - a size cap rejects oversized files (and entity / decompression bombs);
 *   - PNGs must carry the PNG magic signature (declared type matches content);
 *   - SVGs are rejected when they carry active or external content (script,
 *     event handlers, foreignObject, javascript:, external URLs, DOCTYPE/ENTITY).
 *
 * The renderer additionally shows the icon through an <img>, where the browser
 * neither executes scripts nor loads external resources from an SVG -- so this
 * check is defence-in-depth, not the only guard.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Candidate icon files relative to the project root, in resolution order. */
const CANDIDATES = ['icon.png', 'icon.svg', '.idea/icon.png', '.idea/icon.svg'] as const;

/** Reject files larger than this. Icons are small; this stops bombs. */
const MAX_BYTES = 1024 * 1024; // 1 MB

/** The 8-byte PNG file signature. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Cheap allowlist: an SVG must not carry active or external content. */
function isSafeSvg(source: string): boolean {
  const s = source.toLowerCase();
  if (s.includes('<script')) return false;
  if (/\son[a-z]+\s*=/.test(s)) return false; // onload=, onclick=, ...
  if (s.includes('<foreignobject')) return false;
  if (s.includes('javascript:')) return false;
  if (s.includes('<!doctype') || s.includes('<!entity')) return false; // XXE / entity bombs
  // Block absolute http(s) and protocol-relative references (remote fetch on
  // render); local/relative refs and inline data: URIs are fine.
  if (/(?:href|src)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(source)) return false;
  return true;
}

const toDataUrl = (mime: string, buf: Buffer): string =>
  `data:${mime};base64,${buf.toString('base64')}`;

/**
 * First safe icon for a project folder as a data URL, or undefined when none of
 * the candidates exist or pass the safety check. Never throws.
 */
export function resolveProjectIcon(projectPath: string): string | undefined {
  for (const rel of CANDIDATES) {
    const file = path.join(projectPath, rel);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES) continue;
      const buf = fs.readFileSync(file);
      if (rel.endsWith('.png')) {
        if (buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
          return toDataUrl('image/png', buf);
        }
        continue;
      }
      // .svg -- validate the markup, then hand over as a data URL.
      if (isSafeSvg(buf.toString('utf8'))) {
        return toDataUrl('image/svg+xml', buf);
      }
    } catch {
      // Missing or unreadable candidate: try the next one.
      continue;
    }
  }
  return undefined;
}
