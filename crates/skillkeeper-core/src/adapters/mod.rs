//! Concrete production adapters for the domain ports (Rust port of the Node
//! adapters in `packages/core/src/kernel/nodeFs.ts`, `git/systemGit.ts`, and the
//! host-environment/clock helpers).
//!
//! Every adapter here performs real side effects (filesystem, subprocess, wall
//! clock, process environment). Pure domain logic never depends on these
//! directly; it takes the [`crate::ports`] traits and is exercised in tests with
//! the in-memory fakes in [`crate::testing`].

pub mod host_env;
pub mod real_clock;
pub mod std_fs;
pub mod system_git;

pub use host_env::SystemHostEnv;
pub use real_clock::SystemClock;
pub use std_fs::StdFs;
pub use system_git::SystemGit;
