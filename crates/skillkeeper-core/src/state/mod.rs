//! Application state modules (Rust port of `packages/core/src/state`).

// The submodule mirrors the TypeScript `state.ts` file name; the nested
// `state::state` path is intentional.
pub mod scheduler;
#[allow(clippy::module_inception)]
pub mod state;
