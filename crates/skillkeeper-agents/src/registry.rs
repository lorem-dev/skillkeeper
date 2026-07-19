//! The adapter registry and the built-in agent registration entry point.
//! Ported from `packages/core/src/adapters/registry.ts` and
//! `packages/agents/src/index.ts`.
//!
//! The registry is the only place that enumerates concrete agents; adding a new
//! agent means adding a module and registering it in
//! [`register_builtin_agents`].

use skillkeeper_core::ports::{PortError, PortResult};

use crate::adapter::AgentAdapter;
use crate::claude::claude_adapter;
use crate::codex::codex_adapter;
use crate::copilot::copilot_adapter;
use crate::cursor::cursor_adapter;
use crate::model::AgentKind;
use crate::opencode::opencode_adapter;

/// Registry of agent adapters keyed by [`AgentKind`]. Insertion order is
/// preserved, mirroring the TS `Map`-backed registry.
#[derive(Default)]
pub struct AdapterRegistry {
    adapters: Vec<AgentAdapter>,
}

impl AdapterRegistry {
    /// A new, empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register an adapter.
    ///
    /// Returns an error when an adapter for the same kind is already registered.
    pub fn register(&mut self, adapter: AgentAdapter) -> PortResult<()> {
        if self.has(adapter.kind) {
            return Err(PortError::Other(format!(
                "Adapter for \"{}\" is already registered",
                adapter.kind
            )));
        }
        self.adapters.push(adapter);
        Ok(())
    }

    /// Retrieve a registered adapter.
    ///
    /// Returns an error when no adapter for the kind is registered.
    pub fn get(&self, kind: AgentKind) -> PortResult<&AgentAdapter> {
        self.adapters
            .iter()
            .find(|a| a.kind == kind)
            .ok_or_else(|| PortError::Other(format!("No adapter registered for \"{kind}\"")))
    }

    /// True when an adapter for the kind is registered.
    pub fn has(&self, kind: AgentKind) -> bool {
        self.adapters.iter().any(|a| a.kind == kind)
    }

    /// All registered adapters, in registration order.
    pub fn list(&self) -> &[AgentAdapter] {
        &self.adapters
    }
}

/// Every built-in adapter, in a stable order.
pub fn builtin_adapters() -> Vec<AgentAdapter> {
    vec![
        claude_adapter(),
        codex_adapter(),
        copilot_adapter(),
        cursor_adapter(),
        opencode_adapter(),
    ]
}

/// Register all five built-in agent adapters into the given registry.
pub fn register_builtin_agents(registry: &mut AdapterRegistry) -> PortResult<()> {
    for adapter in builtin_adapters() {
        registry.register(adapter)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AgentTarget, Scope};
    use crate::paths::PROJECT_DIR_ENV;
    use crate::test_env::FakeEnv;
    use skillkeeper_core::testing::MemFs;

    const HOME: &str = "/home/bob";
    const PROJECT: &str = "/work/proj";

    const ALL_KINDS: [AgentKind; 5] = [
        AgentKind::Claude,
        AgentKind::Codex,
        AgentKind::Copilot,
        AgentKind::Cursor,
        AgentKind::Opencode,
    ];

    fn env() -> FakeEnv {
        FakeEnv::new(HOME).with_var(PROJECT_DIR_ENV, PROJECT)
    }

    #[test]
    fn registers_all_five_agent_kinds() {
        let mut registry = AdapterRegistry::new();
        register_builtin_agents(&mut registry).unwrap();
        for kind in ALL_KINDS {
            assert!(registry.has(kind));
            assert_eq!(registry.get(kind).unwrap().kind, kind);
        }
    }

    #[test]
    fn registers_exactly_the_five_builtin_adapters() {
        let mut registry = AdapterRegistry::new();
        register_builtin_agents(&mut registry).unwrap();
        let mut kinds: Vec<AgentKind> = registry.list().iter().map(|a| a.kind).collect();
        kinds.sort();
        let mut expected = ALL_KINDS.to_vec();
        expected.sort();
        assert_eq!(kinds, expected);
    }

    #[test]
    fn register_rejects_duplicate_kinds() {
        let mut registry = AdapterRegistry::new();
        registry.register(claude_adapter()).unwrap();
        let err = registry.register(claude_adapter()).unwrap_err();
        assert!(err.to_string().contains("already registered"));
    }

    #[test]
    fn get_errors_for_unregistered_kind() {
        let registry = AdapterRegistry::new();
        let err = registry.get(AgentKind::Claude).err().unwrap();
        assert!(err.to_string().contains("No adapter registered"));
    }

    fn project_target(kind: AgentKind) -> AgentTarget {
        AgentTarget {
            agent: kind,
            scope: Scope::Project,
            project_id: None,
        }
    }

    fn global_target(kind: AgentKind) -> AgentTarget {
        AgentTarget::global(kind)
    }

    #[test]
    fn codex_resolves_project_and_global_skill_roots() {
        let a = codex_adapter();
        assert_eq!(
            a.destination_root(&project_target(AgentKind::Codex), &env())
                .unwrap(),
            format!("{PROJECT}/.codex/skills")
        );
        assert_eq!(
            a.destination_root(&global_target(AgentKind::Codex), &env())
                .unwrap(),
            format!("{HOME}/.codex/skills")
        );
    }

    #[test]
    fn copilot_resolves_project_and_global_skill_roots() {
        let a = copilot_adapter();
        assert_eq!(
            a.destination_root(&project_target(AgentKind::Copilot), &env())
                .unwrap(),
            format!("{PROJECT}/.github/copilot/skills")
        );
        assert_eq!(
            a.destination_root(&global_target(AgentKind::Copilot), &env())
                .unwrap(),
            format!("{HOME}/.config/github-copilot/skills")
        );
    }

    #[test]
    fn cursor_resolves_project_and_global_skill_roots() {
        let a = cursor_adapter();
        assert_eq!(
            a.destination_root(&project_target(AgentKind::Cursor), &env())
                .unwrap(),
            format!("{PROJECT}/.cursor/skills")
        );
        assert_eq!(
            a.destination_root(&global_target(AgentKind::Cursor), &env())
                .unwrap(),
            format!("{HOME}/.cursor/skills")
        );
    }

    #[test]
    fn opencode_resolves_project_and_global_skill_roots() {
        let a = opencode_adapter();
        assert_eq!(
            a.destination_root(&project_target(AgentKind::Opencode), &env())
                .unwrap(),
            format!("{PROJECT}/.opencode/skills")
        );
        assert_eq!(
            a.destination_root(&global_target(AgentKind::Opencode), &env())
                .unwrap(),
            format!("{HOME}/.config/opencode/skills")
        );
    }

    #[test]
    fn exposes_hook_capability_with_resolvable_target_file() {
        for adapter in [
            codex_adapter(),
            copilot_adapter(),
            cursor_adapter(),
            opencode_adapter(),
        ] {
            let support = adapter.hook_support.as_ref().expect("hook capability");
            let file = support
                .resolve_target_file(&global_target(adapter.kind), &env())
                .unwrap();
            assert!(!file.is_empty());
        }
    }

    #[test]
    fn discovers_external_skills_and_reports_availability() {
        for adapter in [
            codex_adapter(),
            copilot_adapter(),
            cursor_adapter(),
            opencode_adapter(),
        ] {
            let global = global_target(adapter.kind);
            let root = adapter.destination_root(&global, &env()).unwrap();
            let fs = MemFs::new().with_file(&format!("{root}/sample/SKILL.md"), "# sample");
            let found = adapter.discover_installed(&fs, &global, &env()).unwrap();
            let names: Vec<&str> = found.iter().map(|s| s.name.as_str()).collect();
            assert_eq!(names, ["sample"]);
            assert!(adapter.is_available(&fs, &env()).unwrap());
            let empty = MemFs::new();
            assert!(!adapter.is_available(&empty, &env()).unwrap());
        }
    }
}
