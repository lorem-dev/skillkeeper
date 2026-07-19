//! `skillkeeper config` command group: validate, edit, path.
//!
//! Port of `packages/cli/src/commands/config.ts`.

use std::io::Write;
use std::process::Command as ProcCommand;

use clap::Subcommand;
use skillkeeper_config::{load_config, LoadConfigResult, Validity, SECTIONS};
use skillkeeper_core::ports::{FsPort, HostEnv};

use crate::error::CliError;
use crate::messages::CONFIG_INVALID_BANNER;

/// `config <action>` subcommands.
#[derive(Debug, Subcommand)]
pub enum ConfigAction {
    /// Validate config.yaml and report per-section status.
    Validate,
    /// Open config.yaml in the configured editor.
    Edit,
    /// Print the path to config.yaml.
    Path,
}

/// Print a startup warning if any config section is invalid. Called by `main`
/// after loading the config (port of `printConfigWarning`).
pub fn print_config_warning(result: &LoadConfigResult, err: &mut dyn Write) -> std::io::Result<()> {
    let any_invalid = SECTIONS
        .iter()
        .any(|s| result.validity.get(*s) == Validity::Invalid);
    if any_invalid {
        writeln!(err, "[WARNING] {CONFIG_INVALID_BANNER}")?;
    }
    Ok(())
}

/// Validate `config.yaml`, reporting each section's status. Returns exit code 1
/// when any section is invalid, matching the TypeScript command.
pub fn validate(
    fs: &dyn FsPort,
    config_path: &str,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let result = load_config(fs, config_path);
    let mut any_invalid = false;
    for section in SECTIONS {
        if result.validity.get(section) == Validity::Invalid {
            any_invalid = true;
            writeln!(out, "  INVALID: {}", section.as_str())?;
        } else {
            writeln!(out, "  ok:      {}", section.as_str())?;
        }
    }
    for w in &result.warnings {
        writeln!(err, "  [WARNING] {w}")?;
    }
    if any_invalid {
        writeln!(err, "{CONFIG_INVALID_BANNER}")?;
        Ok(1)
    } else {
        writeln!(out, "Configuration is valid.")?;
        Ok(0)
    }
}

/// Print the config file path.
pub fn path(config_path: &str, out: &mut dyn Write) -> Result<i32, CliError> {
    writeln!(out, "{config_path}")?;
    Ok(0)
}

/// Open the config file in the resolved editor.
///
/// Editor precedence mirrors the TypeScript command: `$VISUAL`, then `$EDITOR`,
/// then a platform default (`notepad` on Windows, `vi` elsewhere).
pub fn edit(env: &dyn HostEnv, config_path: &str) -> Result<i32, CliError> {
    let editor = env
        .env("VISUAL")
        .or_else(|| env.env("EDITOR"))
        .unwrap_or_else(|| {
            if env.platform() == "win32" {
                "notepad".to_string()
            } else {
                "vi".to_string()
            }
        });
    let status = ProcCommand::new(&editor)
        .arg(config_path)
        .status()
        .map_err(|e| CliError(format!("failed to launch editor {editor}: {e}")))?;
    // Treat a clean exit (code 0) or a signal (no code) as success, like the
    // TypeScript `code === 0 || code === null` guard.
    if status.success() || status.code().is_none() {
        Ok(0)
    } else {
        Err(CliError(format!(
            "Editor exited with code {}",
            status.code().unwrap_or_default()
        )))
    }
}

/// Dispatch a `config` subcommand.
pub fn run(
    action: &ConfigAction,
    fs: &dyn FsPort,
    env: &dyn HostEnv,
    config_path: &str,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    match action {
        ConfigAction::Validate => validate(fs, config_path, out, err),
        ConfigAction::Edit => edit(env, config_path),
        ConfigAction::Path => path(config_path, out),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use skillkeeper_core::testing::MemFs;

    const CONFIG_PATH: &str = "/data/skillkeeper/config.yaml";

    #[test]
    fn validate_reports_all_valid_for_missing_file() {
        let fs = MemFs::new();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = validate(&fs, CONFIG_PATH, &mut out, &mut err).unwrap();
        let out = String::from_utf8(out).unwrap();
        assert_eq!(code, 0);
        assert!(out.contains("ok:      general"));
        assert!(out.contains("ok:      mcp"));
        assert!(out.contains("Configuration is valid."));
        assert!(err.is_empty());
    }

    #[test]
    fn validate_reports_invalid_section_and_exits_one() {
        let fs = MemFs::new().with_file(CONFIG_PATH, "general:\n  language: klingon\n");
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = validate(&fs, CONFIG_PATH, &mut out, &mut err).unwrap();
        let out = String::from_utf8(out).unwrap();
        let err = String::from_utf8(err).unwrap();
        assert_eq!(code, 1);
        assert!(out.contains("INVALID: general"));
        assert!(err.contains(CONFIG_INVALID_BANNER));
    }

    #[test]
    fn validate_surfaces_warnings_to_stderr() {
        let fs = MemFs::new().with_file(CONFIG_PATH, "general: [broken yaml");
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = validate(&fs, CONFIG_PATH, &mut out, &mut err).unwrap();
        let err = String::from_utf8(err).unwrap();
        assert_eq!(code, 1);
        assert!(err.contains("[WARNING]"));
    }

    #[test]
    fn path_prints_the_config_path() {
        let mut out = Vec::new();
        let code = path(CONFIG_PATH, &mut out).unwrap();
        assert_eq!(code, 0);
        assert_eq!(String::from_utf8(out).unwrap(), format!("{CONFIG_PATH}\n"));
    }

    #[test]
    fn print_config_warning_emits_only_when_invalid() {
        let fs = MemFs::new().with_file(CONFIG_PATH, "general:\n  language: klingon\n");
        let result = load_config(&fs, CONFIG_PATH);
        let mut err = Vec::new();
        print_config_warning(&result, &mut err).unwrap();
        assert!(String::from_utf8(err).unwrap().contains("[WARNING]"));

        let clean = load_config(&MemFs::new(), CONFIG_PATH);
        let mut err = Vec::new();
        print_config_warning(&clean, &mut err).unwrap();
        assert!(err.is_empty());
    }
}
