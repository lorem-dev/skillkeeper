/**
 * Stable hue (0-359) derived from a string -- a project's placeholder / wash
 * colour keyed to its name. Same input always yields the same hue.
 */
export function hueFromName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
