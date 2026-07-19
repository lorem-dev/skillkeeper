//! Read-only update detection (port of `packages/core/src/state/updates.ts`).
//!
//! Divergence: the Rust domain crate `skillkeeper-core` has not (yet) ported
//! `state/updates.ts`, so the two helpers the `check` command needs live here in
//! the CLI. They are thin compositions over the already-ported git port and the
//! content-hashing helpers, so this is a location divergence, not a logic one.

use skillkeeper_core::hashing::{manifest_content_hash, resolved_content_hash};
use skillkeeper_core::models::{InstallManifest, Repository, ResolvedSkill};
use skillkeeper_core::ports::{FsPort, GitPort, PortResult};

/// Revision used to resolve the tracked upstream ref.
const UPSTREAM: &str = "@{upstream}";

/// Repository-level update detection. Fetches, then compares the local `HEAD`
/// to the tracked upstream ref. The repository can be updated when they differ.
/// Read-only: a fetch does not modify the working tree or any install.
pub fn repo_has_update(git: &dyn GitPort, repo: &Repository) -> PortResult<bool> {
    git.fetch(&repo.local_path)?;
    let local = git.rev_parse(&repo.local_path, "HEAD")?;
    let upstream = git.rev_parse(&repo.local_path, UPSTREAM)?;
    Ok(local.oid != upstream.oid)
}

/// Skill-level update detection. Compares the content hash of the resolved
/// skill's body files in the working tree against the hash recorded in the
/// install manifest. The skill can be updated when the source content differs
/// from what is installed.
pub fn skill_has_update(
    fs: &dyn FsPort,
    source_root: &str,
    resolved: &ResolvedSkill,
    manifest: &InstallManifest,
) -> PortResult<bool> {
    let source = resolved_content_hash(fs, source_root, resolved)?;
    let installed = manifest
        .content_hash
        .clone()
        .unwrap_or_else(|| manifest_content_hash(manifest));
    Ok(source != installed)
}
