//! Self-update IO: persisted bookkeeping, manifest fetch, download, and
//! checksum verification. The pure decision core (version parsing, artifact
//! selection, the show/hide decision) lives in
//! `skillkeeper_core::app_update`; this module is the desktop backend's own
//! side-effecting shell around it.

pub mod fetch;
pub mod host;
pub mod install;
pub mod session;
pub mod store;
pub mod verify;
