//! CLI error type.
//!
//! Mirrors the TypeScript entry point's top-level `catch`: any error bubbles to
//! `main`, is printed to stderr, and the process exits with code 1. Commands
//! return `Result<i32, CliError>` where the `i32` is the intended process exit
//! code on success (0, or 1 to signal "updates available" / "invalid config").

use std::fmt;
use std::io;

use skillkeeper_core::ports::PortError;
use skillkeeper_core::state::state::StateError;

/// A CLI-level failure carrying a human-readable message.
#[derive(Debug)]
pub struct CliError(pub String);

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CliError {}

impl From<String> for CliError {
    fn from(value: String) -> Self {
        CliError(value)
    }
}

impl From<&str> for CliError {
    fn from(value: &str) -> Self {
        CliError(value.to_string())
    }
}

impl From<io::Error> for CliError {
    fn from(value: io::Error) -> Self {
        CliError(value.to_string())
    }
}

impl From<PortError> for CliError {
    fn from(value: PortError) -> Self {
        CliError(value.to_string())
    }
}

impl From<StateError> for CliError {
    fn from(value: StateError) -> Self {
        CliError(value.to_string())
    }
}
