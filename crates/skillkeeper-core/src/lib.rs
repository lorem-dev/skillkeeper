//! SkillKeeper domain core (Rust port of `packages/core`).
//!
//! Hexagonal: pure domain logic depends only on the trait ports in [`ports`];
//! concrete adapters (std::fs, subprocess git, system clock, host env) live in
//! [`adapters`]. [`testing`] provides in-memory fakes for unit tests.

pub mod adapters;
pub mod frontmatter;
pub mod git_remote;
pub mod glob;
pub mod hashing;
pub mod hooks;
pub mod install;
pub mod mcp;
pub mod models;
pub mod ports;
pub mod skills;
pub mod state;
pub mod testing;
pub mod time;
