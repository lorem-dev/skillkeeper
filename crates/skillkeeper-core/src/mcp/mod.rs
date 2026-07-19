//! MCP (Model Context Protocol) subsystem (Rust port of
//! `packages/core/src/mcp`).
//!
//! Types and pure logic for describing MCP server definitions, hashing them for
//! identity, deriving names, resolving parameters, parsing preset configs,
//! writing each agent's native config, and running the install/remove engine
//! against the SkillKeeper ledger. The flat re-exports below mirror the public
//! surface of the TypeScript `packages/core/src/mcp/index.ts` barrel.

pub mod config;
pub mod gitignore_ensure;
pub mod hashing;
pub mod install;
pub mod model;
pub mod naming;
pub mod params;
pub mod skmcp;
pub mod writers;

pub use config::{parse_mcp_config, McpConfig, McpConfigError};
pub use gitignore_ensure::ensure_gitignore;
pub use hashing::{canonical_mcp_json, hash_mcp_def};
pub use install::{
    install_mcp_instance, remove_mcp_instance, InstallMcpArgs, McpIdentity, McpInstallError,
    RemoveMcpArgs,
};
pub use model::{McpPresetOrigin, McpServerDef, McpTransport};
pub use naming::{allocate_instance_name, to_snake_case};
pub use params::{
    missing_params, parse_params, render_params, validate_param_syntax, MissingValuesError,
    ParamSyntaxResult,
};
pub use skmcp::{
    parse_skmcp, parse_skmcp_params, serialize_skmcp, serialize_skmcp_params, SkmcpEntry,
    SkmcpFile, SKMCP_FILE, SKMCP_PARAMS_FILE, SKMCP_SCHEMA,
};
pub use writers::{
    mcp_destination, supports_transport, writer_for, McpConfigWriter, McpDestination,
    McpDestinationTarget, WriterError,
};
