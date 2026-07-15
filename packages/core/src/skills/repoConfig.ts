import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** Zod schema for a `skillkeeper.repo.yaml` file (scheme 3). */
export const repoConfigSchema = z.object({
  version: z.literal(1),
  defaults: z
    .object({
      group: z.string().optional(),
    })
    .optional(),
  skills: z
    .array(
      z.object({
        path: z.string().min(1),
        name: z.string().optional(),
        group: z.string().optional(),
      }),
    )
    .optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

/** Parsed repo configuration. */
export type RepoConfig = z.infer<typeof repoConfigSchema>;

/** Thrown when `skillkeeper.repo.yaml` is malformed or fails validation. */
export class RepoConfigError extends Error {
  /** Dotted path to the first offending field. */
  readonly fieldPath: string;

  constructor(message: string, fieldPath: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RepoConfigError';
    this.fieldPath = fieldPath;
  }
}

/**
 * Parse and validate the text of a `skillkeeper.repo.yaml` file.
 *
 * @throws RepoConfigError on malformed YAML or schema violations.
 */
export function parseRepoConfig(text: string): RepoConfig {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new RepoConfigError('Invalid skillkeeper.repo.yaml YAML', '', { cause: err });
  }
  const result = repoConfigSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const fieldPath = issue === undefined ? '' : issue.path.map((p) => String(p)).join('.');
    throw new RepoConfigError(`Invalid skillkeeper.repo.yaml at "${fieldPath}"`, fieldPath, {
      cause: result.error,
    });
  }
  return result.data;
}
