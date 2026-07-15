// MCP: model, config, params, hashing, naming, native writers, install ledger.
export { mcpConfigSchema, parseMcpConfig, McpConfigError } from './config.js';
export type { McpTransport, McpServerDef, McpPresetOrigin } from './model.js';
export { parseParams, validateParamSyntax, renderParams, missingParams } from './params.js';
export type { ParamSyntaxResult } from './params.js';
export { canonicalMcpJson, hashMcpDef } from './hashing.js';
export { toSnakeCase, allocateInstanceName } from './naming.js';
export { writerFor, supportsTransport, mcpDestination } from './writers/index.js';
export type { McpConfigWriter, McpDestination, McpDestinationTarget } from './writers/index.js';
export { installMcpInstance, removeMcpInstance } from './install.js';
export type { McpIdentity, InstallMcpArgs, RemoveMcpArgs } from './install.js';
export {
  serializeSkmcp,
  parseSkmcp,
  serializeSkmcpParams,
  parseSkmcpParams,
  SKMCP_FILE,
  SKMCP_PARAMS_FILE,
  SKMCP_SCHEMA,
} from './skmcp.js';
export type { SkmcpEntry, SkmcpFile } from './skmcp.js';
export { ensureGitignore } from './gitignoreEnsure.js';
