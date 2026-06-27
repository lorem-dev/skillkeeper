import { parse as parseYaml } from 'yaml';

/** Result of splitting a Markdown document into frontmatter and body. */
export interface Frontmatter {
  /** Parsed YAML frontmatter, or undefined when the document has none. */
  readonly data: unknown;
  /** The Markdown body following the frontmatter (or the whole input). */
  readonly body: string;
}

/** Thrown when the frontmatter block contains invalid YAML. */
export class FrontmatterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FrontmatterError';
  }
}

// Leading `---` line, YAML lines (lazily captured), then a closing `---` line.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

/**
 * Split a Markdown document into its optional YAML frontmatter block and body.
 * The frontmatter must start on the very first line. When absent, `data` is
 * undefined and `body` is the whole input.
 *
 * @throws FrontmatterError when the frontmatter block holds invalid YAML.
 */
export function splitFrontmatter(md: string): Frontmatter {
  const match = FRONTMATTER_RE.exec(md);
  if (match === null) {
    return { data: undefined, body: md };
  }
  const yamlText = match[1] ?? '';
  const body = match[2] ?? '';
  try {
    const data = parseYaml(yamlText);
    return { data, body };
  } catch (err) {
    throw new FrontmatterError('Invalid YAML frontmatter', { cause: err });
  }
}
