//! Reading PuTTY-format private keys (`.ppk`).
//!
//! `ssh` cannot read this format at all, so a chosen `.ppk` is parsed and
//! decrypted here, converted to OpenSSH text in memory, and handed to the
//! session's ssh-agent. Nothing in this module touches the filesystem: it works
//! on strings and bytes so every step is unit-testable, and so key material
//! never has a path to be written to.

#[cfg(test)]
pub mod fixtures;
