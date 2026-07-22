//! CLI entry point for SkillKeeper (Rust port of `packages/cli/src/main.ts`).
//!
//! Startup sequence mirrors the TypeScript entry point:
//!  1. Resolve app-data paths.
//!  2. Load `config.yaml` (invalid sections fall back to defaults).
//!  3. Print a warning if any section is invalid.
//!  4. Wire real ports.
//!  5. Dispatch the parsed subcommand.
//!
//! i18n decision: unlike the TypeScript CLI, this port is English-only (see
//! `messages.rs`). No translator is wired.

mod commands;
mod error;
mod messages;
mod updates;
mod wiring;

#[cfg(test)]
mod testutil;

use std::io::{self, Write};

use clap::{Parser, Subcommand};
use skillkeeper_config::load_config;
use skillkeeper_core::adapters::{StdFs, SystemHostEnv};

use crate::error::CliError;
use crate::wiring::{AppPaths, Wiring};

/// Manage skills for AI coding agents.
#[derive(Debug, Parser)]
#[command(
    name = "skillkeeper",
    version,
    about = "Manage skills for AI coding agents",
    // Replace clap's auto `-V/--version` flag with our own so `-v` is accepted
    // as an alias too (the `version` subcommand below prints the same string).
    disable_version_flag = true
)]
struct Cli {
    /// Print version information and exit.
    #[arg(
        short = 'V',
        visible_short_alias = 'v',
        long = "version",
        action = clap::ArgAction::Version
    )]
    version: Option<bool>,

    #[command(subcommand)]
    command: Command,
}

/// Top-level subcommands.
#[derive(Debug, Subcommand)]
enum Command {
    /// Manage SkillKeeper configuration.
    Config {
        #[command(subcommand)]
        action: commands::config::ConfigAction,
    },
    /// Check for available updates (read-only).
    Check(commands::check::CheckArgs),
    /// Manage skill repositories.
    Repo {
        #[command(subcommand)]
        action: commands::repo::RepoAction,
    },
    /// Manage tracked projects.
    Project {
        #[command(subcommand)]
        action: commands::project::ProjectAction,
    },
    /// Manage skills.
    Skill {
        #[command(subcommand)]
        action: commands::skill::SkillAction,
    },
    /// Manage MCP server presets.
    Mcp {
        #[command(subcommand)]
        action: commands::mcp::McpAction,
    },
    /// Print the version.
    Version,
}

/// The current working directory as a string (project-scope default), empty when
/// it cannot be resolved.
fn current_dir() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Dispatch a parsed [`Cli`] against the wired ports, writing to the given sinks.
fn dispatch(
    cli: &Cli,
    wiring: &Wiring,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let paths = &wiring.paths;
    match &cli.command {
        Command::Config { action } => commands::config::run(
            action,
            &wiring.fs,
            &wiring.env,
            &paths.config_yaml,
            out,
            err,
        ),
        Command::Check(args) => commands::check::run(
            &wiring.fs,
            &wiring.git,
            &paths.state_json,
            args.all,
            out,
            err,
        ),
        Command::Repo { action } => commands::repo::run(
            action,
            &wiring.fs,
            &wiring.git,
            &wiring.clock,
            &paths.state_json,
            out,
            err,
        ),
        Command::Project { action } => commands::project::run(
            action,
            &wiring.fs,
            &wiring.clock,
            &paths.state_json,
            out,
            err,
        ),
        Command::Skill { action } => {
            let cwd = current_dir();
            let ctx = commands::skill::SkillCtx {
                fs: &wiring.fs,
                registry: &wiring.registry,
                env: &wiring.env,
                clock: &wiring.clock,
                state_path: &paths.state_json,
                executable_globs: &wiring.config.executables.globs,
                cwd: &cwd,
            };
            commands::skill::run(action, &ctx, out, err)
        }
        Command::Mcp { action } => {
            let cwd = current_dir();
            let ctx = commands::mcp::McpCtx {
                fs: &wiring.fs,
                registry: &wiring.registry,
                env: &wiring.env,
                state_path: &paths.state_json,
                manual_presets: &wiring.config.mcp.servers,
                cwd: &cwd,
            };
            commands::mcp::run(action, &ctx, out, err)
        }
        Command::Version => commands::version::run(out),
    }
}

/// Load config, wire ports, and run the parsed command; returns the exit code.
fn run(cli: &Cli) -> Result<i32, CliError> {
    // `version` needs neither config nor wiring: short-circuit before either so a
    // version query never loads config, emits a config warning, or fails when
    // wiring would (e.g. a bad git path). Matches the `-V`/`-v`/`--version` flags,
    // which clap prints during parsing, before `run` is even reached.
    if matches!(cli.command, Command::Version) {
        let stdout = io::stdout();
        return commands::version::run(&mut stdout.lock());
    }

    // Load config with a bare fs before wiring (wiring itself needs the config).
    let boot_env = SystemHostEnv::new();
    let boot_paths = AppPaths::resolve(&boot_env);
    let boot_fs = StdFs::new();
    let config_result = load_config(&boot_fs, &boot_paths.config_yaml);

    commands::config::print_config_warning(&config_result, &mut io::stderr())?;

    let wiring = Wiring::build(&config_result.config).map_err(CliError)?;

    let stdout = io::stdout();
    let stderr = io::stderr();
    let mut out = stdout.lock();
    let mut err = stderr.lock();
    dispatch(cli, &wiring, &mut out, &mut err)
}

fn main() {
    let cli = Cli::parse();
    let code = match run(&cli) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The command tree parses and clap's own invariants hold.
    #[test]
    fn cli_definition_is_valid() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
    }

    #[test]
    fn parses_version_subcommand() {
        assert!(matches!(
            Cli::try_parse_from(["skillkeeper", "version"])
                .unwrap()
                .command,
            Command::Version
        ));
    }

    #[test]
    fn version_flags_request_version_display() {
        use clap::error::ErrorKind;
        // `-V`, its `-v` alias, and `--version` all trigger clap's version
        // display (surfaced as a non-error `DisplayVersion` during parsing).
        for flag in ["-V", "-v", "--version"] {
            let err = Cli::try_parse_from(["skillkeeper", flag]).unwrap_err();
            assert_eq!(err.kind(), ErrorKind::DisplayVersion, "flag {flag}");
        }
    }

    #[test]
    fn parses_config_subcommands() {
        assert!(matches!(
            Cli::try_parse_from(["skillkeeper", "config", "validate"])
                .unwrap()
                .command,
            Command::Config {
                action: commands::config::ConfigAction::Validate
            }
        ));
        assert!(matches!(
            Cli::try_parse_from(["skillkeeper", "config", "path"])
                .unwrap()
                .command,
            Command::Config {
                action: commands::config::ConfigAction::Path
            }
        ));
        assert!(matches!(
            Cli::try_parse_from(["skillkeeper", "config", "edit"])
                .unwrap()
                .command,
            Command::Config {
                action: commands::config::ConfigAction::Edit
            }
        ));
    }

    #[test]
    fn parses_check_with_all_flag() {
        let cli = Cli::try_parse_from(["skillkeeper", "check", "--all"]).unwrap();
        match cli.command {
            Command::Check(args) => assert!(args.all),
            _ => panic!("expected check"),
        }
        let cli = Cli::try_parse_from(["skillkeeper", "check"]).unwrap();
        match cli.command {
            Command::Check(args) => assert!(!args.all),
            _ => panic!("expected check"),
        }
    }

    #[test]
    fn parses_repo_add_with_options() {
        let cli = Cli::try_parse_from([
            "skillkeeper",
            "repo",
            "add",
            "https://example.com/r.git",
            "/tmp/r",
            "--name",
            "mine",
            "--lfs",
        ])
        .unwrap();
        match cli.command {
            Command::Repo {
                action:
                    commands::repo::RepoAction::Add {
                        url,
                        local_path,
                        name,
                        lfs,
                    },
            } => {
                assert_eq!(url, "https://example.com/r.git");
                assert_eq!(local_path, "/tmp/r");
                assert_eq!(name.as_deref(), Some("mine"));
                assert!(lfs);
            }
            _ => panic!("expected repo add"),
        }
    }

    #[test]
    fn parses_repo_update_variants() {
        let cli = Cli::try_parse_from(["skillkeeper", "repo", "update", "--all"]).unwrap();
        match cli.command {
            Command::Repo {
                action: commands::repo::RepoAction::Update { id, all },
            } => {
                assert!(all);
                assert!(id.is_none());
            }
            _ => panic!("expected repo update"),
        }

        let cli = Cli::try_parse_from(["skillkeeper", "repo", "update", "abc"]).unwrap();
        match cli.command {
            Command::Repo {
                action: commands::repo::RepoAction::Update { id, all },
            } => {
                assert!(!all);
                assert_eq!(id.as_deref(), Some("abc"));
            }
            _ => panic!("expected repo update"),
        }
    }

    #[test]
    fn repo_add_requires_two_positionals() {
        assert!(Cli::try_parse_from(["skillkeeper", "repo", "add", "only-url"]).is_err());
    }

    #[test]
    fn parses_project_add_with_name() {
        let cli =
            Cli::try_parse_from(["skillkeeper", "project", "add", "/p", "--name", "app"]).unwrap();
        match cli.command {
            Command::Project {
                action: commands::project::ProjectAction::Add { path, name },
            } => {
                assert_eq!(path, "/p");
                assert_eq!(name.as_deref(), Some("app"));
            }
            _ => panic!("expected project add"),
        }
    }

    #[test]
    fn parses_skill_install_flags() {
        let cli = Cli::try_parse_from([
            "skillkeeper",
            "skill",
            "install",
            "grp/sk",
            "--agent",
            "claude",
            "--global",
            "--allow-hooks",
        ])
        .unwrap();
        match cli.command {
            Command::Skill {
                action:
                    commands::skill::SkillAction::Install {
                        id,
                        agent,
                        global,
                        project,
                        allow_hooks,
                    },
            } => {
                assert_eq!(id, "grp/sk");
                assert_eq!(agent, "claude");
                assert!(global);
                assert!(project.is_none());
                assert!(allow_hooks);
            }
            _ => panic!("expected skill install"),
        }
    }

    #[test]
    fn parses_mcp_install_repeatable_agent_and_param() {
        let cli = Cli::try_parse_from([
            "skillkeeper",
            "mcp",
            "install",
            "github",
            "--agent",
            "claude",
            "--agent",
            "cursor",
            "--param",
            "token=abc",
        ])
        .unwrap();
        match cli.command {
            Command::Mcp {
                action:
                    commands::mcp::McpAction::Install {
                        name, agent, param, ..
                    },
            } => {
                assert_eq!(name, "github");
                assert_eq!(agent, vec!["claude".to_string(), "cursor".to_string()]);
                assert_eq!(param, vec!["token=abc".to_string()]);
            }
            _ => panic!("expected mcp install"),
        }
    }

    #[test]
    fn parses_mcp_update_optional_name_and_all() {
        let cli = Cli::try_parse_from(["skillkeeper", "mcp", "update", "--all"]).unwrap();
        match cli.command {
            Command::Mcp {
                action: commands::mcp::McpAction::Update { name, all, .. },
            } => {
                assert!(name.is_none());
                assert!(all);
            }
            _ => panic!("expected mcp update"),
        }
    }

    #[test]
    fn parses_repo_list_and_remove() {
        assert!(matches!(
            Cli::try_parse_from(["skillkeeper", "repo", "list"])
                .unwrap()
                .command,
            Command::Repo {
                action: commands::repo::RepoAction::List
            }
        ));
        match Cli::try_parse_from(["skillkeeper", "repo", "remove", "xyz"])
            .unwrap()
            .command
        {
            Command::Repo {
                action: commands::repo::RepoAction::Remove { id },
            } => assert_eq!(id, "xyz"),
            _ => panic!("expected repo remove"),
        }
    }
}
