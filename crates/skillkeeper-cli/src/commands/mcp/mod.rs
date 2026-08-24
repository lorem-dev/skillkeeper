//! `skillkeeper mcp` command group: list, install, remove, update.
//!
//! Port of `packages/cli/src/commands/mcp.ts`. MCP presets come from two
//! origins: repository `mcp.yml`/`mcp.yaml` files (the repo root, no group, plus
//! one per group directory found via `preset_group_dirs`, however deeply
//! nested) and manual presets recorded in
//! `config.mcp.servers`. Installing an instance renders `{param}` placeholders
//! and writes the target agent's native MCP config, tracking the install in the
//! `.skmcp.yml` / `.skmcp.params.yml` ledgers under that agent's skills
//! destination root (the SAME root the skill engine resolves).
//!
//! Target resolution (`resolve_mcp_target`) mirrors the desktop `mcp.rs`; the
//! transform/ledger/params logic is the shared core `mcp` subsystem.

mod args;
mod hints;
mod install;
mod list;
mod presets;
mod remove;
mod target;
mod update;

use std::io::Write;

use clap::Subcommand;
use skillkeeper_agents::AdapterRegistry;
use skillkeeper_config::McpPreset;
use skillkeeper_core::models::AgentKind;
use skillkeeper_core::ports::{FsPort, HostEnv};

use crate::error::CliError;

pub use install::install;
pub use list::list;
pub use remove::remove;
pub use update::update;

/// Every MCP agent, eligible at both project and global scope: Codex resolves
/// a real project-scoped destination (see `mcp_destination`) exactly like
/// every other agent. Shared by the project pass and the global pass over MCP
/// ledgers (`mcp update --all`, `mcp update --global`, and the default agent
/// list at either scope).
const ALL_MCP_AGENTS: [AgentKind; 5] = [
    AgentKind::Claude,
    AgentKind::Codex,
    AgentKind::Copilot,
    AgentKind::Cursor,
    AgentKind::Opencode,
];

/// The mcp.yml/mcp.yaml file names, in precedence order.
const MCP_FILE_NAMES: [&str; 2] = ["mcp.yml", "mcp.yaml"];

/// `mcp <action>` subcommands.
#[derive(Debug, Subcommand)]
pub enum McpAction {
    /// List available MCP presets.
    List,
    /// Install an MCP preset for one or more agents.
    Install {
        /// Preset name (`group/name` or `name`).
        name: String,
        /// Project directory (default: cwd). Mutually exclusive with --global.
        #[arg(long)]
        project: Option<String>,
        /// Agent(s) to install for (repeatable or comma-separated).
        #[arg(long)]
        agent: Vec<String>,
        /// Parameter value `name=value` (repeatable).
        #[arg(long)]
        param: Vec<String>,
        /// Install for the whole user instead of a project.
        #[arg(long, conflicts_with = "project")]
        global: bool,
    },
    /// Remove an installed MCP instance.
    Remove {
        /// The assigned instance name (the native config key).
        instance_name: String,
        /// Agent the instance is installed for.
        #[arg(long)]
        agent: String,
        /// Project directory (default: cwd). Mutually exclusive with --global.
        #[arg(long)]
        project: Option<String>,
        /// Act on the user-wide installs instead of a project's.
        #[arg(long, conflicts_with = "project")]
        global: bool,
    },
    /// Reinstall MCP instances whose source definition changed.
    Update {
        /// Preset name to limit to (`group/name` or `name`); omit for all.
        name: Option<String>,
        /// Project directory (default: cwd); ignored with --all. Mutually
        /// exclusive with --global.
        #[arg(long)]
        project: Option<String>,
        /// Agent(s) to check (repeatable/comma-separated; default: every agent).
        #[arg(long)]
        agent: Vec<String>,
        /// Check every tracked project and agent, plus every agent's global ledger.
        #[arg(long)]
        all: bool,
        /// Value `name=value` for a newly-required parameter (repeatable).
        #[arg(long)]
        param: Vec<String>,
        /// Act on the user-wide installs instead of a project's.
        #[arg(long, conflicts_with_all = ["project", "all"])]
        global: bool,
    },
}

/// The wired dependencies shared by every `mcp` operation.
pub struct McpCtx<'a> {
    pub fs: &'a dyn FsPort,
    pub registry: &'a AdapterRegistry,
    pub env: &'a dyn HostEnv,
    pub state_path: &'a str,
    /// Manual presets from `config.mcp.servers`.
    pub manual_presets: &'a [McpPreset],
    /// The current working directory (project default).
    pub cwd: &'a str,
}

/// Dispatch an `mcp` subcommand.
pub fn run(
    action: &McpAction,
    ctx: &McpCtx,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    match action {
        McpAction::List => list(ctx, out, err),
        McpAction::Install {
            name,
            project,
            agent,
            param,
            global,
        } => install(
            ctx,
            name,
            project.as_deref(),
            agent,
            param,
            *global,
            out,
            err,
        ),
        McpAction::Remove {
            instance_name,
            agent,
            project,
            global,
        } => remove(
            ctx,
            instance_name,
            agent,
            project.as_deref(),
            *global,
            out,
            err,
        ),
        McpAction::Update {
            name,
            project,
            agent,
            all,
            param,
            global,
        } => update(
            ctx,
            name.as_deref(),
            project.as_deref(),
            agent,
            *all,
            param,
            *global,
            out,
            err,
        ),
    }
}

/// Fixtures shared by the tests of more than one `mcp` submodule.
#[cfg(test)]
mod testutil {
    use super::*;
    use skillkeeper_agents::register_builtin_agents;
    use skillkeeper_config::schema::McpOauth as ConfigOauth;
    use skillkeeper_config::McpTransport as ConfigTransport;
    use skillkeeper_core::models::{
        AppState, Project, Repository, RepositoryKind, Transport, STATE_VERSION,
    };
    use skillkeeper_core::state::state::save_state;
    use skillkeeper_core::testing::MemFs;

    pub(super) const STATE_PATH: &str = "/data/state.json";
    pub(super) const HOME: &str = "/home/u";
    pub(super) const PROJECT: &str = "/proj";

    struct FakeEnv;
    impl HostEnv for FakeEnv {
        fn home_dir(&self) -> &str {
            HOME
        }
        fn platform(&self) -> &str {
            "linux"
        }
        fn env(&self, _key: &str) -> Option<String> {
            None
        }
    }

    fn registry() -> AdapterRegistry {
        let mut r = AdapterRegistry::new();
        register_builtin_agents(&mut r).unwrap();
        r
    }

    pub(super) struct TestApp {
        pub(super) fs: MemFs,
        registry: AdapterRegistry,
        env: FakeEnv,
        pub(super) manual: Vec<McpPreset>,
    }

    impl TestApp {
        pub(super) fn new(fs: MemFs) -> Self {
            Self {
                fs,
                registry: registry(),
                env: FakeEnv,
                manual: Vec::new(),
            }
        }

        pub(super) fn ctx(&self) -> McpCtx<'_> {
            McpCtx {
                fs: &self.fs,
                registry: &self.registry,
                env: &self.env,
                state_path: STATE_PATH,
                manual_presets: &self.manual,
                cwd: PROJECT,
            }
        }
    }

    fn repo() -> Repository {
        Repository {
            id: "repo-1".to_string(),
            name: "mcps".to_string(),
            url: "git@github.com:acme/mcps.git".to_string(),
            kind: RepositoryKind::Generic,
            transport: Transport::Ssh,
            lfs: false,
            local_path: "/repos/r1".to_string(),
            last_fetched: None,
            branch: None,
        }
    }

    /// A MemFs with one repo carrying a root mcp.yml (stdio, one `{token}` param).
    pub(super) fn seeded_fs() -> MemFs {
        MemFs::new().with_file(
            "/repos/r1/mcp.yml",
            "version: 1\nservers:\n  - name: github\n    type: stdio\n    command: npx\n    env:\n      TOKEN: \"{token}\"\n",
        )
    }

    /// A MemFs with one repo carrying an http preset with an oauth client and
    /// no params.
    pub(super) fn oauth_fs() -> MemFs {
        MemFs::new().with_file(
            "/repos/r1/mcp.yml",
            "version: 1\nservers:\n  - name: remote\n    type: http\n    url: https://example.com/mcp\n    oauth:\n      clientId: sk-client\n      callbackPort: 8432\n",
        )
    }

    /// A MemFs with one repo carrying a plain http preset: no oauth, no params.
    /// The "before" state for an update that gains an oauth block.
    pub(super) fn plain_http_fs() -> MemFs {
        MemFs::new().with_file(
            "/repos/r1/mcp.yml",
            "version: 1\nservers:\n  - name: remote\n    type: http\n    url: https://example.com/mcp\n",
        )
    }

    /// A MemFs with one repo carrying a stdio preset with one
    /// option-constrained parameter, "choice" (accepted values alpha/beta).
    /// The parameter is not tied to any `{placeholder}`: the option check
    /// applies to a stored value regardless of whether it is ever rendered.
    pub(super) fn choice_fs() -> MemFs {
        MemFs::new().with_file(
            "/repos/r1/mcp.yml",
            "version: 1\nservers:\n  - name: opts\n    type: stdio\n    command: npx\n    parameters:\n      choice:\n        options:\n          alpha: Alpha\n          beta: Beta\n",
        )
    }

    /// Like [`choice_fs`], but `choice` is rendered into an argument and
    /// carries a description, so the missing-value and invalid-value paths
    /// have something to print besides the parameter's name.
    pub(super) fn described_choice_fs() -> MemFs {
        MemFs::new().with_file(
            "/repos/r1/mcp.yml",
            "version: 1\nservers:\n  - name: opts\n    type: stdio\n    command: npx\n    args: [\"--level\", \"{choice}\"]\n    parameters:\n      choice:\n        description: \"Which [level](https://example.com/levels) to request.\"\n        options:\n          alpha: Alpha\n          beta: Beta\n",
        )
    }

    /// A manual (config-defined) http preset carrying an oauth client.
    pub(super) fn manual_oauth_preset() -> McpPreset {
        McpPreset {
            id: "abc123".to_string(),
            name: "manual-remote".to_string(),
            r#type: ConfigTransport::Http,
            url: Some("https://example.com/mcp".to_string()),
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: None,
            description: None,
            oauth: Some(ConfigOauth {
                callback_port: Some(8432),
                client_id: Some("sk-client".to_string()),
                scopes: vec!["repo".to_string()],
            }),
        }
    }

    pub(super) fn seed_state(fs: &MemFs) {
        let state = AppState {
            version: STATE_VERSION,
            repositories: vec![repo()],
            projects: vec![Project {
                id: "proj-1".to_string(),
                path: PROJECT.to_string(),
                name: "app".to_string(),
                added_at: "2025-07-17T00:00:00.000Z".to_string(),
            }],
            installs: vec![],
        };
        save_state(fs, STATE_PATH, &state).unwrap();
    }
}
