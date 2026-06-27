import { describe, expect, it } from 'vitest';
import { FrontmatterError, splitFrontmatter } from './frontmatter.js';

describe('splitFrontmatter', () => {
  it('splits frontmatter from a body', () => {
    const { data, body } = splitFrontmatter('---\nname: x\n---\nbody here\n');
    expect(data).toEqual({ name: 'x' });
    expect(body).toBe('body here\n');
  });

  it('returns an empty body when nothing follows the closing fence', () => {
    const { data, body } = splitFrontmatter('---\nname: x\n---');
    expect(data).toEqual({ name: 'x' });
    expect(body).toBe('');
  });

  it('returns undefined data and the whole input when there is no frontmatter', () => {
    const { data, body } = splitFrontmatter('# just markdown\n');
    expect(data).toBeUndefined();
    expect(body).toBe('# just markdown\n');
  });

  it('handles an empty frontmatter block', () => {
    const { data } = splitFrontmatter('---\n\n---\nbody\n');
    expect(data).toBeNull();
  });

  it('throws FrontmatterError on malformed YAML', () => {
    expect(() => splitFrontmatter('---\nname: "open\n---\n')).toThrow(FrontmatterError);
  });

  it('tolerates CRLF line endings', () => {
    const { data, body } = splitFrontmatter('---\r\nname: y\r\n---\r\nbody\r\n');
    expect(data).toEqual({ name: 'y' });
    expect(body).toBe('body\r\n');
  });
});
