//! `mcp install`.

use std::io::Write;

use skillkeeper_core::mcp::params::invalid_option_values;
use skillkeeper_core::mcp::{
    install_mcp_instance, missing_params, supports_oauth, supports_transport, InstallMcpArgs,
};
use skillkeeper_core::models::Scope;

use crate::error::CliError;

use super::args::{agent_kind, collect_csv, collect_params};
use super::hints::{
    accepted_option_values, note_line, parameter_description, parameter_hint, transport_str,
};
use super::presets::{find_preset, list_presets, preset_identity};
use super::target::resolve_mcp_target;
use super::McpCtx;

/// `mcp install <name>`.
#[allow(clippy::too_many_arguments)]
pub fn install(
    ctx: &McpCtx,
    name: &str,
    project: Option<&str>,
    agents: &[String],
    params: &[String],
    global: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let agents = collect_csv(agents);
    if agents.is_empty() {
        writeln!(err, "At least one --agent is required.")?;
        return Ok(1);
    }
    let preset = match find_preset(list_presets(ctx, err), name) {
        Ok(p) => p,
        Err(e) => {
            writeln!(err, "{e}")?;
            return Ok(1);
        }
    };
    let values = collect_params(params)?;
    let missing = missing_params(&preset.def, Some(&values));
    if !missing.is_empty() {
        writeln!(
            err,
            "Missing values for mcp params: {}. Pass --param <name>=<value>.",
            missing.join(", ")
        )?;
        for name in &missing {
            if let Some(hint) = parameter_hint(&preset.def, name) {
                writeln!(err, "{hint}")?;
            }
        }
        return Ok(1);
    }
    let invalid = invalid_option_values(&preset.def, &values);
    if !invalid.is_empty() {
        for (name, value) in &invalid {
            writeln!(
                err,
                "Invalid value \"{value}\" for mcp param \"{name}\". Accepted: {}.",
                accepted_option_values(&preset.def, name).unwrap_or_default()
            )?;
            if let Some(description) = parameter_description(&preset.def, name) {
                writeln!(err, "  {name}: {description}")?;
            }
        }
        return Ok(1);
    }

    let scope = if global {
        Scope::Global
    } else {
        Scope::Project
    };
    // At global scope there is no project directory to record or gitignore.
    let project_path = if global {
        ""
    } else {
        project.unwrap_or(ctx.cwd)
    };
    let identity = preset_identity(&preset);
    let mut any_installed = false;

    for agent_name in &agents {
        let Some(agent) = agent_kind(agent_name) else {
            writeln!(err, "Unknown agent: {agent_name}")?;
            continue;
        };
        if !ctx.registry.has(agent) {
            writeln!(err, "Unknown agent: {agent_name}")?;
            continue;
        }
        if !supports_transport(agent, preset.def.transport) {
            writeln!(
                out,
                "Skipped {agent}: does not support transport \"{}\".",
                transport_str(preset.def.transport)
            )?;
            continue;
        }
        // Written without its auth block, this server would look installed and
        // fail to authenticate. Skipping is the honest outcome.
        if preset.def.oauth.is_some() && !supports_oauth(agent) {
            writeln!(out, "Skipped {agent}: cannot express an oauth client.")?;
            continue;
        }
        let target = resolve_mcp_target(ctx, agent, scope, project_path, project_path)?;
        let outcome = install_mcp_instance(
            ctx.fs,
            &InstallMcpArgs {
                agent,
                native_path: target.native_path.clone(),
                ledger_path: target.ledger_path.clone(),
                params_path: target.params_path.clone(),
                guidance_files: target.guidance_files.clone(),
                identity: identity.clone(),
                def: preset.def.clone(),
                values: values.clone(),
                instance_name: None,
                // Gated on the RESOLVED scope, not the requested one: a global
                // write has no repository to keep the ledger out of.
                gitignore_project_path: if target.scope == Scope::Global {
                    None
                } else {
                    Some(project_path.to_string())
                },
            },
        )
        .map_err(|e| CliError(e.to_string()))?;
        any_installed = true;
        writeln!(
            out,
            "Installed: {} ({agent}) -> {}",
            outcome.instance_name, target.native_path
        )?;
        for note in &outcome.notes {
            writeln!(out, "{}", note_line(agent, note))?;
        }
    }

    Ok(if any_installed { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mcp::testutil::{
        choice_fs, described_choice_fs, oauth_fs, seed_state, seeded_fs, TestApp, HOME, PROJECT,
    };
    use skillkeeper_core::mcp::SKMCP_FILE;
    use skillkeeper_core::ports::FsPort;
    use skillkeeper_core::testing::MemFs;

    /// Installs the `choice_fs` preset for claude with `choice=<value>`.
    /// Returns the app too, so a refusal test can assert nothing was written.
    fn run_install_with_choice(value: &str) -> (TestApp, i32, String, String) {
        let app = TestApp::new(choice_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "opts",
            Some(PROJECT),
            &["claude".to_string()],
            &[format!("choice={value}")],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        (
            app,
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    /// A CLI user has no select to read, so the description and the accepted
    /// set have to arrive with the refusal -- otherwise they must guess wrong
    /// once to learn what the parameter takes.
    #[test]
    fn install_prints_a_parameters_description_and_options_when_a_value_is_missing() {
        let app = TestApp::new(described_choice_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "opts",
            Some(PROJECT),
            &["claude".to_string()],
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        let err = String::from_utf8(err).unwrap();
        assert_eq!(code, 1);
        assert!(
            err.contains("Which level (https://example.com/levels) to request."),
            "the description must reach the terminal, links included: {err}"
        );
        assert!(err.contains("Accepted: alpha, beta."), "got {err}");
    }

    #[test]
    fn install_prints_a_parameters_description_beside_an_invalid_value() {
        let app = TestApp::new(described_choice_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "opts",
            Some(PROJECT),
            &["claude".to_string()],
            &["choice=nope".to_string()],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        let err = String::from_utf8(err).unwrap();
        assert_eq!(code, 1);
        assert!(err.contains("Accepted: alpha, beta."), "got {err}");
        assert!(
            err.contains("Which level (https://example.com/levels) to request."),
            "got {err}"
        );
    }

    #[test]
    fn a_parameter_with_no_metadata_prints_no_extra_line() {
        let app = TestApp::new(MemFs::new().with_file(
            "/repos/r1/mcp.yml",
            "version: 1\nservers:\n  - name: plain\n    type: stdio\n    command: npx\n    args: [\"{bare}\"]\n",
        ));
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(
            &app.ctx(),
            "plain",
            Some(PROJECT),
            &["claude".to_string()],
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        let err = String::from_utf8(err).unwrap();
        assert_eq!(
            err.lines().count(),
            1,
            "only the missing-values line itself: {err}"
        );
    }

    #[test]
    fn install_refuses_a_value_outside_the_options_and_names_the_accepted_ones() {
        let (app, code, _out, err) = run_install_with_choice("nope");
        assert_eq!(code, 1);
        assert!(err.contains("choice"), "got {err}");
        assert!(
            err.contains("alpha") && err.contains("beta"),
            "the accepted values must be named: {err}"
        );
        // A refusal is not a partial install: the check runs before any
        // agent is touched, so neither the native config nor the ledger
        // exists. A check that ran AFTER a write would still return 1 here
        // and this would be the only thing to catch it.
        assert!(!app.fs.exists("/proj/.mcp.json").unwrap());
        assert!(!app
            .fs
            .exists(&format!("/proj/.claude/skills/{SKMCP_FILE}"))
            .unwrap());
    }

    #[test]
    fn install_accepts_a_value_that_is_one_of_the_options() {
        let (_app, code, _out, _err) = run_install_with_choice("alpha");
        assert_eq!(code, 0);
    }

    #[test]
    fn install_renders_native_config_and_ledger() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["claude".to_string()],
            &["token=secret123".to_string()],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Installed: github_1 (claude) ->"));

        let native = app.fs.read_file("/proj/.mcp.json").unwrap();
        assert!(native.contains("github_1"));
        assert!(native.contains("secret123"));
        assert!(!native.contains("{token}"));
        // Ledger written under the claude project skills root.
        assert!(app
            .fs
            .exists(&format!("/proj/.claude/skills/{SKMCP_FILE}"))
            .unwrap());
    }

    #[test]
    fn install_skips_copilot_for_an_oauth_preset_and_still_writes_claude() {
        let app = TestApp::new(oauth_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "remote",
            Some(PROJECT),
            &["copilot".to_string(), "claude".to_string()],
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let out = String::from_utf8(out).unwrap();

        // Skipped for oauth, not for the transport -- copilot takes http fine.
        assert!(
            out.contains("Skipped copilot: cannot express an oauth client."),
            "expected an oauth skip, got:\n{out}"
        );
        assert!(!out.contains("transport"), "wrong skip reason:\n{out}");
        assert!(!out.contains("(copilot)"), "copilot was installed:\n{out}");
        // Nothing was written for copilot: no half-configured server, and no
        // ledger entry claiming one.
        assert!(!app.fs.exists("/proj/.vscode/mcp.json").unwrap());
        assert!(!app
            .fs
            .exists(&format!("/proj/.github/skills/{SKMCP_FILE}"))
            .unwrap());

        // Claude, which can express it, was written with the oauth block.
        assert!(out.contains("Installed: remote_1 (claude) ->"));
        let native = app.fs.read_file("/proj/.mcp.json").unwrap();
        assert!(native.contains("\"oauth\""), "no oauth block:\n{native}");
        assert!(native.contains("sk-client"));
        assert!(native.contains("8432"));
    }

    #[test]
    fn install_prints_a_writer_note_for_a_field_the_agent_cannot_express() {
        let app = TestApp::new(oauth_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "remote",
            Some(PROJECT),
            &["cursor".to_string()],
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let out = String::from_utf8(out).unwrap();

        assert!(out.contains("Installed: remote_1 (cursor) ->"));
        // Cursor has no callback-port setting; the drop is reported, not hidden.
        assert!(
            out.contains("Note cursor: cannot express \"callbackPort\""),
            "expected the dropped-field note, got:\n{out}"
        );
    }

    #[test]
    fn install_requires_an_agent() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &[],
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("At least one --agent is required."));
    }

    #[test]
    fn install_reports_missing_params() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["claude".to_string()],
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Missing values for mcp params: token"));
    }

    #[test]
    fn install_reports_unknown_preset() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "nope",
            Some(PROJECT),
            &["claude".to_string()],
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("MCP preset not found: nope"));
    }

    #[test]
    fn install_writes_a_project_scoped_codex_config_and_does_not_refuse() {
        // Codex used to be coerced to global scope no matter what was asked;
        // a project-scoped install must now land in the project's own
        // .codex/config.toml, not the refusal this used to print.
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["codex".to_string()],
            &["token=secret123".to_string()],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let out = String::from_utf8(out).unwrap();
        assert!(
            out.contains("Installed: github_1 (codex) ->"),
            "expected a successful codex install, got:\n{out}"
        );
        assert!(String::from_utf8(err).unwrap().is_empty());

        let native = app
            .fs
            .read_file(&format!("{PROJECT}/.codex/config.toml"))
            .expect("project-scoped codex config written");
        assert!(native.contains("github_1"));
        assert!(native.contains("secret123"));
        // Nothing was written to the user-wide config.
        assert!(!app
            .fs
            .exists(&format!("{HOME}/.codex/config.toml"))
            .unwrap());
    }
}
