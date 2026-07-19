//! Install/verify engine (Rust port of `packages/core/src/install`).

// The submodule mirrors the TypeScript `install.ts` file name; the nested
// `install::install` path is intentional.
#[allow(clippy::module_inception)]
pub mod install;
pub mod verify;
