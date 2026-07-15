/**
 * Public API of @skillkeeper/core. Re-exports the module barrels only - keep
 * logic in the modules. The production build excludes `testing/`, so test fakes
 * are NOT exported here (import them from `@skillkeeper/core/testing`).
 */
export * from './kernel/index.js';
export * from './skills/index.js';
export * from './hooks/index.js';
export * from './adapters/index.js';
export * from './install/index.js';
export * from './git/index.js';
export * from './state/index.js';
export * from './mcp/index.js';
