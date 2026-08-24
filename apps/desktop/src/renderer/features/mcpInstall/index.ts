export { McpInstallModal } from './ui/McpInstallModal';
export type { McpInstallModalProps } from './ui/McpInstallModal';
export { McpUpdateParamsModal } from './ui/McpUpdateParamsModal';
export type { McpUpdateParamsModalProps } from './ui/McpUpdateParamsModal';
export { supportsTransport } from './lib/supportsTransport';
export { supportsOauth } from './lib/supportsOauth';
export { buildInstallBatches, buildRemoveBatches } from './lib/buildBatches';
// Exported because every surface that applies an MCP batch has to report what
// the backend declined and what a writer dropped -- the install modal, the
// update flow in `pages/Mcp/useMcpActions`, and the skill-save modal. Three
// copies of that mapping is how the update flow ended up reporting neither.
export { installNotesToMessages } from './lib/installNotesToMessages';
export { mcpSkipsToMessages } from './lib/mcpSkipsToMessages';
