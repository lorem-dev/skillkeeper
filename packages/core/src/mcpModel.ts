export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerDef {
  readonly name: string;
  readonly type: McpTransport;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly rules?: string;
}

export type McpPresetOrigin = 'manual' | 'repo';
