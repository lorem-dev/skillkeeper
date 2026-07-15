import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const serverSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(['stdio', 'http', 'sse']),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    rules: z.string().optional(),
  })
  .refine((s) => (s.type === 'stdio' ? !!s.command : !!s.url), {
    message: 'stdio requires command; http/sse require url',
  });

export const mcpConfigSchema = z.object({ version: z.literal(1), servers: z.array(serverSchema) });

export class McpConfigError extends Error {
  readonly fieldPath: string;

  constructor(message: string, fieldPath: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'McpConfigError';
    this.fieldPath = fieldPath;
  }
}

export function parseMcpConfig(text: string) {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new McpConfigError('Invalid mcp.yml YAML', '', { cause: err });
  }
  const result = mcpConfigSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const fieldPath = issue === undefined ? '' : issue.path.map((p) => String(p)).join('.');
    throw new McpConfigError(`Invalid mcp.yml at "${fieldPath}"`, fieldPath, {
      cause: result.error,
    });
  }
  return result.data;
}
