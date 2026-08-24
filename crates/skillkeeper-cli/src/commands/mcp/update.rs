//! `mcp update`.

use std::collections::BTreeMap;
use std::io::Write;

use skillkeeper_core::mcp::params::{invalid_option_values, migrate_option_values};
use skillkeeper_core::mcp::{
    hash_mcp_def, install_mcp_instance, missing_params, parse_skmcp, parse_skmcp_params,
    remove_mcp_instance, supports_oauth, InstallMcpArgs, McpIdentity, RemoveMcpArgs,
};
use skillkeeper_core::models::Scope;
use skillkeeper_core::state::state::load_state;

use crate::error::CliError;

use super::args::{collect_params, identity_matches, kinds_for, UpdateScope};
use super::hints::{accepted_option_values, note_line, parameter_description, parameter_hint};
use super::presets::list_presets;
use super::target::resolve_mcp_target;
use super::{McpCtx, ALL_MCP_AGENTS};

/// `mcp update [name]`.
#[allow(clippy::too_many_arguments)]
pub fn update(
    ctx: &McpCtx,
    name: Option<&str>,
    project: Option<&str>,
    agents: &[String],
    all: bool,
    params: &[String],
    global: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let presets = list_presets(ctx, err);
    let override_params = collect_params(params)?;

    let mut scopes: Vec<UpdateScope> = Vec::new();
    if all {
        let state = load_state(ctx.fs, ctx.state_path)?;
        for project in &state.projects {
            for agent in ALL_MCP_AGENTS {
                scopes.push(UpdateScope {
                    agent,
                    scope: Scope::Project,
                    project_path: project.path.clone(),
                    project_id: project.id.clone(),
                });
            }
        }
        // Every agent's user-wide ledger, not just codex's.
        for agent in ALL_MCP_AGENTS {
            scopes.push(UpdateScope {
                agent,
                scope: Scope::Global,
                project_path: String::new(),
                project_id: String::new(),
            });
        }
    } else if global {
        for agent in kinds_for(agents, Scope::Global) {
            scopes.push(UpdateScope {
                agent,
                scope: Scope::Global,
                project_path: String::new(),
                project_id: String::new(),
            });
        }
    } else {
        let project_path = project.unwrap_or(ctx.cwd).to_string();
        for agent in kinds_for(agents, Scope::Project) {
            scopes.push(UpdateScope {
                agent,
                scope: Scope::Project,
                project_path: project_path.clone(),
                project_id: project_path.clone(),
            });
        }
    }

    let mut updated = 0usize;
    let mut failed = false;
    // An update this run declined but did not fail on. Tracked only so the
    // summary below does not claim there was nothing to update.
    let mut skipped = false;

    for scope in &scopes {
        if !ctx.registry.has(scope.agent) {
            continue;
        }
        let target = resolve_mcp_target(
            ctx,
            scope.agent,
            scope.scope,
            &scope.project_path,
            &scope.project_id,
        )?;
        if !ctx.fs.exists(&target.ledger_path)? {
            continue;
        }
        let Some(ledger) = parse_skmcp(&ctx.fs.read_file(&target.ledger_path)?) else {
            continue;
        };
        let params_map = if ctx.fs.exists(&target.params_path)? {
            parse_skmcp_params(&ctx.fs.read_file(&target.params_path)?)
        } else {
            BTreeMap::new()
        };

        for entry in &ledger.servers {
            if let Some(name) = name {
                let grouped = format!("{}/{}", entry.group.as_deref().unwrap_or(""), entry.source);
                if entry.source != name && grouped != name {
                    continue;
                }
            }
            let Some(current) = presets.iter().find(|p| identity_matches(entry, p)) else {
                continue; // source no longer available; leave as-is
            };
            // Validate what the USER just typed, before the up-to-date check
            // and before it is merged over anything stored. Provenance decides
            // the treatment: an override value came from this command line, so
            // refusing it names something the user can fix, whereas migrating
            // it would replace an input made seconds ago and then blame
            // storage for the substitution. A STORED value is migrated
            // instead, below -- nobody can act on an error about a file they
            // may never have opened.
            let invalid = invalid_option_values(&current.def, &override_params);
            if !invalid.is_empty() {
                for (param, value) in &invalid {
                    writeln!(
                        err,
                        "Cannot update {} ({}): invalid value \"{value}\" for mcp param \"{param}\". Accepted: {}.",
                        entry.name,
                        scope.agent,
                        accepted_option_values(&current.def, param).unwrap_or_default()
                    )?;
                    if let Some(description) = parameter_description(&current.def, param) {
                        writeln!(err, "  {param}: {description}")?;
                    }
                }
                failed = true;
                continue;
            }
            if hash_mcp_def(&current.def) == entry.hash {
                continue; // already up to date
            }

            let mut merged = params_map.get(&entry.name).cloned().unwrap_or_default();
            for (key, value) in &override_params {
                merged.insert(key.clone(), value.clone());
            }
            // Bring a STORED option value back in line with the source's
            // current options before anything else checks or uses `merged`:
            // a value an earlier install recorded may no longer be offered.
            // The overrides above are already known to be in the option set,
            // so this only ever migrates what came off disk.
            let option_notes = migrate_option_values(&current.def, &mut merged);
            // Rewritten without its auth block, this server would look
            // updated and fail to authenticate. Declining is the honest
            // outcome -- and it must happen before the remove below, or the
            // instance would be deleted and not put back.
            //
            // Reported like `install`'s skip and NOT counted as a failure: no
            // user can make copilot speak OAuth, so failing here would make
            // every later `mcp update` exit non-zero over a state the run left
            // exactly as it found it, breaking any scripted invocation for good.
            if current.def.oauth.is_some() && !supports_oauth(scope.agent) {
                writeln!(
                    out,
                    "Skipped {} ({}): cannot express an oauth client. Remove it with mcp remove {} --agent {} if it is no longer wanted.",
                    entry.name, scope.agent, entry.name, scope.agent
                )?;
                skipped = true;
                continue;
            }
            let missing = missing_params(&current.def, Some(&merged));
            if !missing.is_empty() {
                writeln!(
                    err,
                    "Cannot update {} ({}): missing values for mcp params: {}. Pass --param <name>=<value>.",
                    entry.name,
                    scope.agent,
                    missing.join(", ")
                )?;
                for param in &missing {
                    if let Some(hint) = parameter_hint(&current.def, param) {
                        writeln!(err, "{hint}")?;
                    }
                }
                failed = true;
                continue;
            }

            remove_mcp_instance(
                ctx.fs,
                &RemoveMcpArgs {
                    agent: scope.agent,
                    native_path: target.native_path.clone(),
                    ledger_path: target.ledger_path.clone(),
                    params_path: target.params_path.clone(),
                    guidance_files: target.guidance_files.clone(),
                    instance_name: entry.name.clone(),
                },
            )
            .map_err(|e| CliError(e.to_string()))?;
            let outcome = install_mcp_instance(
                ctx.fs,
                &InstallMcpArgs {
                    agent: scope.agent,
                    native_path: target.native_path.clone(),
                    ledger_path: target.ledger_path.clone(),
                    params_path: target.params_path.clone(),
                    guidance_files: target.guidance_files.clone(),
                    identity: McpIdentity {
                        remote: entry.remote.clone(),
                        group: entry.group.clone(),
                        local: entry.local.clone(),
                        source: entry.source.clone(),
                    },
                    def: current.def.clone(),
                    values: merged,
                    instance_name: Some(entry.name.clone()),
                    // Gated on the RESOLVED scope, not the requested one: see
                    // `McpTarget::scope`.
                    gitignore_project_path: if target.scope == Scope::Global {
                        None
                    } else {
                        Some(scope.project_path.clone())
                    },
                },
            )
            .map_err(|e| CliError(e.to_string()))?;
            updated += 1;
            writeln!(out, "Updated: {} ({})", entry.name, scope.agent)?;
            for note in &option_notes {
                writeln!(out, "{}", note_line(scope.agent, note))?;
            }
            for note in &outcome.notes {
                writeln!(out, "{}", note_line(scope.agent, note))?;
            }
        }
    }

    if updated == 0 && !failed && !skipped {
        writeln!(out, "No MCP updates available.")?;
    }
    Ok(if failed { 1 } else { 0 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mcp::install::install;
    use crate::commands::mcp::testutil::{
        choice_fs, plain_http_fs, seed_state, seeded_fs, TestApp, HOME, PROJECT,
    };
    use skillkeeper_core::mcp::SKMCP_PARAMS_FILE;
    use skillkeeper_core::ports::FsPort;

    /// Installs the `choice_fs` preset with `choice=alpha`, then drops "alpha"
    /// from the source's options (leaving only "beta") and runs `update`. The
    /// stored value is now outside the options, so the update must migrate it
    /// instead of failing.
    fn run_update_after_removing_the_stored_option() -> (i32, String, String) {
        let app = TestApp::new(choice_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "opts",
            Some(PROJECT),
            &["claude".to_string()],
            &["choice=alpha".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();

        app.fs
            .write_file(
                "/repos/r1/mcp.yml",
                "version: 1\nservers:\n  - name: opts\n    type: stdio\n    command: npx\n    parameters:\n      choice:\n        options:\n          beta: Beta\n",
            )
            .unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            Some(PROJECT),
            &["claude".to_string()],
            false,
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    /// Installs the `choice_fs` preset with `choice=alpha`, then empties the
    /// source's option list entirely (leaving `choice` with nothing to
    /// choose from) and runs `update`. The stored value has nothing left to
    /// validate against, so the update must keep it -- and say nothing, since
    /// this entry is byte-identical to one that only carries a description.
    fn run_update_after_the_options_go_empty() -> (i32, String, String) {
        let app = TestApp::new(choice_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "opts",
            Some(PROJECT),
            &["claude".to_string()],
            &["choice=alpha".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();

        app.fs
            .write_file(
                "/repos/r1/mcp.yml",
                "version: 1\nservers:\n  - name: opts\n    type: stdio\n    command: npx\n    parameters:\n      choice: {}\n",
            )
            .unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            Some(PROJECT),
            &["claude".to_string()],
            false,
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    /// Installs the `choice_fs` preset with `choice=alpha`, changes the source
    /// so an update is genuinely pending, then runs `update --param
    /// choice=<value>`. Returns the app so a refusal test can show the
    /// installed instance was left exactly as it was found.
    fn run_update_with_choice_override(value: &str) -> (TestApp, i32, String, String) {
        let app = TestApp::new(choice_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "opts",
            Some(PROJECT),
            &["claude".to_string()],
            &["choice=alpha".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();

        // `rules` added: the def's hash changes, so the ledger entry is out of
        // date and the update loop has real work to do. Without this the
        // instance is up to date and the loop's body would never be reached.
        app.fs
            .write_file(
                "/repos/r1/mcp.yml",
                "version: 1\nservers:\n  - name: opts\n    type: stdio\n    command: npx\n    rules: \"Use it.\"\n    parameters:\n      choice:\n        options:\n          alpha: Alpha\n          beta: Beta\n",
            )
            .unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            Some(PROJECT),
            &["claude".to_string()],
            false,
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

    /// The value came from THIS command line, so it is refused rather than
    /// migrated: substituting it would replace an input made seconds ago and
    /// then report that the STORED value was no longer accepted, sending the
    /// user to look at a file instead of at what they typed.
    #[test]
    fn update_refuses_an_out_of_set_param_the_user_just_typed() {
        let (app, code, _out, err) = run_update_with_choice_override("admin");
        assert_eq!(code, 1, "an out-of-set --param must fail the update");
        assert!(err.contains("admin"), "the refused value: {err}");
        assert!(
            err.contains("alpha") && err.contains("beta"),
            "the accepted values must be named: {err}"
        );
        // The instance was left exactly as it was found: not migrated to
        // "alpha" behind the user's back, and not removed by the update's own
        // remove-then-reinstall.
        let stored = app
            .fs
            .read_file(&format!("/proj/.claude/skills/{SKMCP_PARAMS_FILE}"))
            .unwrap();
        assert!(stored.contains("alpha"), "got {stored}");
        assert!(!stored.contains("admin"), "got {stored}");
    }

    #[test]
    fn update_accepts_a_param_that_is_one_of_the_options() {
        let (app, code, _out, err) = run_update_with_choice_override("beta");
        assert_eq!(code, 0, "err was {err}");
        let stored = app
            .fs
            .read_file(&format!("/proj/.claude/skills/{SKMCP_PARAMS_FILE}"))
            .unwrap();
        assert!(stored.contains("beta"), "got {stored}");
    }

    /// The override check runs before the up-to-date check, so a value the
    /// interface would never have produced is refused whether or not this run
    /// had anything to reinstall.
    #[test]
    fn update_refuses_an_out_of_set_param_even_with_nothing_to_update() {
        let app = TestApp::new(choice_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "opts",
            Some(PROJECT),
            &["claude".to_string()],
            &["choice=alpha".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            Some(PROJECT),
            &["claude".to_string()],
            false,
            &["choice=admin".to_string()],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        let err = String::from_utf8(err).unwrap();
        assert_eq!(code, 1);
        assert!(err.contains("admin"), "got {err}");
    }

    #[test]
    fn update_reports_a_substituted_option_and_does_not_fail() {
        let (code, out, _err) = run_update_after_removing_the_stored_option();
        assert_eq!(code, 0, "a reported substitution is not a failure");
        assert!(out.contains("choice"), "got {out}");
    }

    /// A parameter with an empty option list is indistinguishable from one
    /// that only carries a `description`, so an update has nothing true to say
    /// about it. The old note said something anyway, on every update of every
    /// described parameter.
    #[test]
    fn update_says_nothing_when_the_options_go_empty() {
        let (code, out, _err) = run_update_after_the_options_go_empty();
        assert_eq!(code, 0, "an empty option set is not a failure");
        assert!(
            out.contains("opts"),
            "the update itself must still have run: {out}"
        );
        assert!(
            !out.contains("choice"),
            "nothing is said about a parameter nothing happened to: {out}"
        );
    }

    #[test]
    fn update_reinstalls_when_source_changed() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["claude".to_string()],
            &["token=abc".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();

        // Change the source def (add a static arg -> new hash, no new param).
        app.fs
            .write_file(
                "/repos/r1/mcp.yml",
                "version: 1\nservers:\n  - name: github\n    type: stdio\n    command: npx\n    args:\n      - --verbose\n    env:\n      TOKEN: \"{token}\"\n",
            )
            .unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            Some(PROJECT),
            &["claude".to_string()],
            false,
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Updated: github_1 (claude)"));
        let native = app.fs.read_file("/proj/.mcp.json").unwrap();
        assert!(native.contains("--verbose"));
        assert!(native.contains("abc")); // stored token preserved
    }

    #[test]
    fn update_declines_to_rewrite_a_copilot_instance_that_gained_an_oauth_block() {
        let app = TestApp::new(plain_http_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        // Installed while the preset had no oauth, which copilot can express.
        install(
            &app.ctx(),
            "remote",
            Some(PROJECT),
            &["copilot".to_string()],
            &[],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        let before = app.fs.read_file("/proj/.vscode/mcp.json").unwrap();
        assert!(before.contains("remote_1"));

        // The source gains an oauth block copilot cannot express.
        app.fs
            .write_file("/repos/r1/mcp.yml", "version: 1\nservers:\n  - name: remote\n    type: http\n    url: https://example.com/mcp\n    oauth:\n      clientId: sk-client\n      callbackPort: 8432\n")
            .unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            Some(PROJECT),
            &["copilot".to_string()],
            false,
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        // Reported, not failed: nothing the user can do makes copilot speak
        // OAuth, so a non-zero exit here would never clear and would break
        // every scripted `mcp update` from now on.
        assert_eq!(code, 0, "a declined update must not fail the command");
        let out = String::from_utf8(out).unwrap();
        assert!(
            out.contains("Skipped remote_1 (copilot): cannot express an oauth client."),
            "no oauth skip on the update path:\n{out}"
        );
        // The remedy is named, and it is the command that actually exists.
        assert!(
            out.contains("mcp remove remote_1 --agent copilot"),
            "the skip names no remedy:\n{out}"
        );
        // Reported on stdout like `install`'s skip, not as an error.
        assert!(String::from_utf8(err).unwrap().is_empty());
        // And it does not then claim there was nothing to update.
        assert!(!out.contains("No MCP updates available."), "{out}");
        // Untouched: not rewritten without its auth, and NOT deleted by the
        // remove half of the reinstall -- the gate runs before the remove.
        assert_eq!(app.fs.read_file("/proj/.vscode/mcp.json").unwrap(), before);
    }

    #[test]
    fn update_prints_a_writer_note_for_a_field_the_agent_cannot_express() {
        let app = TestApp::new(plain_http_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "remote",
            Some(PROJECT),
            &["cursor".to_string()],
            &[],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();

        // Cursor CAN express an oauth client, minus the callback port.
        app.fs
            .write_file("/repos/r1/mcp.yml", "version: 1\nservers:\n  - name: remote\n    type: http\n    url: https://example.com/mcp\n    oauth:\n      clientId: sk-client\n      callbackPort: 8432\n")
            .unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            Some(PROJECT),
            &["cursor".to_string()],
            false,
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("Updated: remote_1 (cursor)"));
        assert!(
            out.contains("Note cursor: cannot express \"callbackPort\""),
            "the update path dropped the writer note:\n{out}"
        );
    }

    #[test]
    fn update_reports_nothing_when_up_to_date() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["claude".to_string()],
            &["token=abc".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            Some(PROJECT),
            &["claude".to_string()],
            false,
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("No MCP updates available."));
    }

    #[test]
    fn update_at_global_scope_skips_gitignore_for_a_non_codex_agent() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        // Install claude's MCP server globally; no project is involved.
        install(
            &app.ctx(),
            "github",
            None,
            &["claude".to_string()],
            &["token=abc".to_string()],
            true,
            &mut sink,
            &mut sink2,
        )
        .unwrap();

        // Change the source def (same edit as the project-scope update test).
        app.fs
            .write_file(
                "/repos/r1/mcp.yml",
                "version: 1\nservers:\n  - name: github\n    type: stdio\n    command: npx\n    args:\n      - --verbose\n    env:\n      TOKEN: \"{token}\"\n",
            )
            .unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            None,
            &["claude".to_string()],
            false,
            &[],
            true, // --global
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Updated: github_1 (claude)"));
        let native = app.fs.read_file(&format!("{HOME}/.claude.json")).unwrap();
        assert!(native.contains("--verbose"));
        assert!(native.contains("abc")); // stored token preserved

        // The bug this guards against: gating `gitignore_project_path` on
        // `is_codex` instead of the scope reads the global entry's empty
        // `project_path` as a real path and asks `ensure_gitignore` to write
        // "<empty>/.gitignore", i.e. "/.gitignore" at the filesystem root.
        // Reverting the fix locally and running just this test reproduces
        // that file appearing here (see the task report for the captured
        // failure).
        assert!(!app.fs.exists("/.gitignore").unwrap());
    }

    #[test]
    fn update_reinstalls_a_project_scoped_codex_instance() {
        // The `update` path used to carry the same refusal `install` did;
        // it must now reinstall a project-scoped codex instance in place,
        // the same as any other agent.
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["codex".to_string()],
            &["token=abc".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();

        // Its source def changes, so an update has real work to do.
        app.fs
            .write_file(
                "/repos/r1/mcp.yml",
                "version: 1\nservers:\n  - name: github\n    type: stdio\n    command: npx\n    args:\n      - --verbose\n    env:\n      TOKEN: \"{token}\"\n",
            )
            .unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            None,
            &["codex".to_string()],
            false,
            &[],
            false, // no --global: the cwd project is the requested scope
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Updated: github_1 (codex)"));
        assert!(String::from_utf8(err).unwrap().is_empty());

        let native = app
            .fs
            .read_file(&format!("{PROJECT}/.codex/config.toml"))
            .unwrap();
        assert!(native.contains("--verbose"));
        assert!(native.contains("abc")); // stored token preserved

        // Resolved at project scope like any other agent, so the ledger's
        // gitignore entry applies here too.
        assert!(app.fs.exists(&format!("{PROJECT}/.gitignore")).unwrap());
    }
}
