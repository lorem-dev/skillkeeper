//! Detect which agents appear to have been used in a project folder, by the
//! presence of well-known marker files/directories. Shared by the desktop
//! `projects:detectAgents` command and the CLI (`skill install` without an
//! explicit `--agent` installs for the detected agents).

use std::path::Path;

use skillkeeper_core::models::AgentKind;
use skillkeeper_core::ports::FsPort;

/// Files/dirs whose presence in a project marks an agent as having been used.
/// The tuple order mirrors the TypeScript `AGENT_MARKERS` key order.
const AGENT_MARKERS: [(AgentKind, &[&str]); 5] = [
    (AgentKind::Claude, &["CLAUDE.md", ".claude"]),
    (AgentKind::Codex, &["AGENTS.md", ".codex"]),
    (AgentKind::Copilot, &[".github/copilot-instructions.md"]),
    (AgentKind::Cursor, &[".cursor", ".cursorrules"]),
    (AgentKind::Opencode, &[".opencode", "opencode.json"]),
];

/// Which agents appear to have been used in `project_path` (by markers), in the
/// fixed `AGENT_MARKERS` order. Port of the TypeScript `detectProjectAgents`.
pub fn detect_project_agents(fs: &dyn FsPort, project_path: &str) -> Vec<AgentKind> {
    let mut found = Vec::new();
    for (agent, markers) in AGENT_MARKERS {
        for marker in markers {
            let path = Path::new(project_path)
                .join(marker)
                .to_string_lossy()
                .into_owned();
            if fs.exists(&path).unwrap_or(false) {
                found.push(agent);
                break;
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use skillkeeper_core::testing::MemFs;

    #[test]
    fn finds_markers_in_key_order() {
        let fs = MemFs::new()
            .with_file("/proj/CLAUDE.md", "x")
            .with_file("/proj/.github/copilot-instructions.md", "x")
            .with_file("/proj/.cursorrules", "x");
        assert_eq!(
            detect_project_agents(&fs, "/proj"),
            vec![AgentKind::Claude, AgentKind::Copilot, AgentKind::Cursor]
        );
    }

    #[test]
    fn is_empty_for_a_bare_folder() {
        let fs = MemFs::new();
        assert!(detect_project_agents(&fs, "/proj").is_empty());
    }
}
