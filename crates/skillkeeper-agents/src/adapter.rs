//! The [`AgentAdapter`] value type, its [`HookCapability`], and the
//! [`make_adapter`] factory. Ported from `packages/agents/src/makeAdapter.ts`
//! and `packages/core/src/adapters/adapter.ts`.
//!
//! The TS `AgentAdapter` is an interface with async methods; the closures a
//! factory returns capture per-agent path logic. Rust models the same thing as
//! a struct of boxed closures, so both the hand-written Claude adapter and the
//! [`make_adapter`]-built ones are the same concrete type. Every
//! filesystem-backed method takes `&dyn FsPort` explicitly (see `paths.rs`).

use std::sync::Arc;

use skillkeeper_core::ports::{FsPort, HostEnv, PortResult};

use crate::model::{AgentKind, AgentTarget, DiscoveredSkill, HookStrategy};
use crate::paths::discover_skill_dirs;

// The `Send + Sync` bounds let an `AgentAdapter` (and thus the `AdapterRegistry`
// that owns them) be shared as Tauri managed state, which requires `Send + Sync`.
// Every adapter closure captures only `'static` data, so the bounds hold.

/// `is_available(fs, env) -> bool`.
type IsAvailableFn = Box<dyn Fn(&dyn FsPort, &dyn HostEnv) -> PortResult<bool> + Send + Sync>;
/// `destination_root(target, env) -> path`.
type DestinationRootFn =
    Box<dyn Fn(&AgentTarget, &dyn HostEnv) -> PortResult<String> + Send + Sync>;
/// `guidance_file(fs, target, env) -> path`.
type GuidanceFileFn =
    Box<dyn Fn(&dyn FsPort, &AgentTarget, &dyn HostEnv) -> PortResult<String> + Send + Sync>;
/// `discover_installed(fs, target, env) -> skills`.
type DiscoverInstalledFn = Box<
    dyn Fn(&dyn FsPort, &AgentTarget, &dyn HostEnv) -> PortResult<Vec<DiscoveredSkill>>
        + Send
        + Sync,
>;
/// `resolve_target_file(target, env) -> path`.
type ResolveTargetFileFn =
    Box<dyn Fn(&AgentTarget, &dyn HostEnv) -> PortResult<String> + Send + Sync>;
/// `availability_dir(env) -> path`.
type AvailabilityDirFn = Box<dyn Fn(&dyn HostEnv) -> String + Send + Sync>;

/// Declares how an agent accepts hooks. Present only when the agent supports
/// hooks. This is what lets one install engine drive hooks for every agent
/// regardless of the on-disk file format. Mirrors the TS `HookCapability`.
pub struct HookCapability {
    pub strategy: HookStrategy,
    /// Comment token for the `delimited-text` strategy (for example `#`).
    pub comment_token: Option<String>,
    /// Closing comment token for languages that need one (for example `-->`).
    pub comment_close: Option<String>,
    resolve_target_file: ResolveTargetFileFn,
}

impl HookCapability {
    /// Construct a hook capability from its strategy, optional comment tokens,
    /// and target-file resolver.
    pub fn new(
        strategy: HookStrategy,
        comment_token: Option<String>,
        comment_close: Option<String>,
        resolve_target_file: ResolveTargetFileFn,
    ) -> Self {
        Self {
            strategy,
            comment_token,
            comment_close,
            resolve_target_file,
        }
    }

    /// Resolve the config file a hook edits for a given target.
    pub fn resolve_target_file(
        &self,
        target: &AgentTarget,
        env: &dyn HostEnv,
    ) -> PortResult<String> {
        (self.resolve_target_file)(target, env)
    }
}

/// Adapter for one supported AI coding agent. Mirrors the TS `AgentAdapter`.
pub struct AgentAdapter {
    pub kind: AgentKind,
    pub hook_support: Option<HookCapability>,
    is_available: IsAvailableFn,
    destination_root: DestinationRootFn,
    guidance_file: GuidanceFileFn,
    discover_installed: DiscoverInstalledFn,
}

impl AgentAdapter {
    /// Assemble an adapter from its per-method closures. Used by the
    /// hand-written Claude adapter and by [`make_adapter`].
    pub fn new(
        kind: AgentKind,
        is_available: IsAvailableFn,
        destination_root: DestinationRootFn,
        guidance_file: GuidanceFileFn,
        discover_installed: DiscoverInstalledFn,
        hook_support: Option<HookCapability>,
    ) -> Self {
        Self {
            kind,
            hook_support,
            is_available,
            destination_root,
            guidance_file,
            discover_installed,
        }
    }

    /// True when the agent appears installed/usable in the host environment.
    pub fn is_available(&self, fs: &dyn FsPort, env: &dyn HostEnv) -> PortResult<bool> {
        (self.is_available)(fs, env)
    }

    /// Absolute destination root for skills at the given target.
    pub fn destination_root(&self, target: &AgentTarget, env: &dyn HostEnv) -> PortResult<String> {
        (self.destination_root)(target, env)
    }

    /// Absolute path of the agent's guidance file for the target.
    pub fn guidance_file(
        &self,
        fs: &dyn FsPort,
        target: &AgentTarget,
        env: &dyn HostEnv,
    ) -> PortResult<String> {
        (self.guidance_file)(fs, target, env)
    }

    /// Skills already present in the agent's locations (external discovery).
    pub fn discover_installed(
        &self,
        fs: &dyn FsPort,
        target: &AgentTarget,
        env: &dyn HostEnv,
    ) -> PortResult<Vec<DiscoveredSkill>> {
        (self.discover_installed)(fs, target, env)
    }
}

/// Per-agent configuration consumed by [`make_adapter`]. Mirrors the TS
/// `AdapterSpec`. Each agent supplies only its own path logic and hook
/// capability; the identical parts (skill discovery, availability probe) live in
/// the factory.
pub struct AdapterSpec {
    pub kind: AgentKind,
    /// Absolute skills root for a target (project or global scope).
    pub skills_root: DestinationRootFn,
    /// A directory whose presence indicates the agent is configured for the
    /// user. Probed at global scope by [`AgentAdapter::is_available`].
    pub availability_dir: AvailabilityDirFn,
    /// Optional group label attached to every discovered skill, for agents that
    /// nest skills one level under a group directory.
    pub discovery_group: Option<String>,
    /// Absolute path of the agent's guidance file for a target.
    pub guidance_file: GuidanceFileFn,
    /// The agent's hook capability.
    pub hook: HookCapability,
}

/// Build an [`AgentAdapter`] from a per-agent [`AdapterSpec`]. Everything that
/// is identical across agents (skill-directory discovery, availability probe)
/// lives here once.
pub fn make_adapter(spec: AdapterSpec) -> AgentAdapter {
    let AdapterSpec {
        kind,
        skills_root,
        availability_dir,
        discovery_group,
        guidance_file,
        hook,
    } = spec;

    // `skills_root` feeds both `destination_root` and `discover_installed`, so
    // share it across the two closures.
    let skills_root: Arc<DestinationRootFn> = Arc::new(skills_root);
    let skills_root_for_dest = Arc::clone(&skills_root);

    AgentAdapter::new(
        kind,
        Box::new(move |fs, env| fs.exists(&availability_dir(env))),
        Box::new(move |target, env| (skills_root_for_dest)(target, env)),
        guidance_file,
        Box::new(move |fs, target, env| {
            let root = (skills_root)(target, env)?;
            discover_skill_dirs(fs, &root, discovery_group.as_deref())
        }),
        Some(hook),
    )
}
