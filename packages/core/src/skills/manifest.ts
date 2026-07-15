import { z } from 'zod';
import { FrontmatterError, splitFrontmatter } from './frontmatter.js';
import type { HookManifest, SkillManifest } from './model.js';

/** Thrown when SKILL.md or HOOK.md frontmatter fails validation. */
export class ManifestError extends Error {
  /** Dotted path to the first offending field (for example `target.agent`). */
  readonly fieldPath: string;

  constructor(message: string, fieldPath: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ManifestError';
    this.fieldPath = fieldPath;
  }
}

const agentKindSchema = z.enum(['claude', 'codex', 'copilot', 'cursor', 'opencode']);

const skillSchema = z.object({
  name: z.string().min(1),
  version: z.coerce.string().optional(),
  description: z.coerce.string().optional(),
  license: z.coerce.string().optional(),
  executables: z.array(z.string()).optional(),
  hooks: z.array(z.string()).optional(),
});

const hookSchema = z.object({
  name: z.string().min(1),
  strategy: z.enum(['delimited-text', 'json-merge', 'file']),
  version: z.coerce.string().optional(),
  description: z.coerce.string().optional(),
  target: z.object({
    agent: agentKindSchema,
    filePattern: z.string().optional(),
    keyPath: z.string().optional(),
  }),
});

function firstIssuePath(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return '';
  return issue.path.map((p) => String(p)).join('.');
}

function parseManifest<T>(label: string, schema: z.ZodType<T>, md: string): T {
  let data: unknown;
  try {
    data = splitFrontmatter(md).data;
  } catch (err) {
    if (err instanceof FrontmatterError) {
      throw new ManifestError(`Invalid ${label} frontmatter YAML`, '', { cause: err });
    }
    throw err;
  }
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const fieldPath = firstIssuePath(result.error);
    throw new ManifestError(`Invalid ${label} frontmatter at "${fieldPath}"`, fieldPath, {
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * Parse SKILL.md frontmatter into a {@link SkillManifest}.
 *
 * @throws ManifestError when frontmatter is absent or invalid.
 */
export function parseSkillManifest(md: string): SkillManifest {
  return parseManifest('SKILL.md', skillSchema, md);
}

/**
 * Parse HOOK.md frontmatter into a {@link HookManifest}.
 *
 * @throws ManifestError when frontmatter is absent or invalid.
 */
export function parseHookManifest(md: string): HookManifest {
  return parseManifest('HOOK.md', hookSchema, md);
}
