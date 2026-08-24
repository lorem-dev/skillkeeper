//! `mcp:update` / `mcp:update-preflight`.

use std::collections::BTreeMap;

use skillkeeper_core::mcp::params::{invalid_option_values, migrate_option_values};
use skillkeeper_core::mcp::{
    install_mcp_instance, missing_params, parse_skmcp_params, remove_mcp_instance, supports_oauth,
    supports_transport, InstallMcpArgs, RemoveMcpArgs,
};
use skillkeeper_core::models::Scope;
use skillkeeper_core::ports::FsPort;

use crate::state::AppContext;

use super::target::{resolve_mcp_target, McpTarget};
use super::types::{
    McpInstalled, McpSkipReason, McpSkipped, McpUpdatePreflightArgs, UpdateMcpArgs,
};

/// Read an instance's stored param values from its own `.skmcp.params.yml` entry
/// (`None` when the file or the entry is absent). Port of the TS
/// `readStoredParams`.
fn read_stored_params(
    ctx: &AppContext,
    target: &McpTarget,
    instance_name: &str,
) -> Result<Option<BTreeMap<String, String>>, String> {
    if !ctx
        .fs
        .exists(&target.params_path)
        .map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    let params = parse_skmcp_params(
        &ctx.fs
            .read_file(&target.params_path)
            .map_err(|e| e.to_string())?,
    );
    Ok(params.get(instance_name).cloned())
}

pub(super) fn preflight_inner(
    ctx: &AppContext,
    args: &McpUpdatePreflightArgs,
) -> Result<Vec<String>, String> {
    let target = resolve_mcp_target(
        ctx,
        args.agent,
        args.scope,
        &args.project_path,
        &args.project_id,
    )?;
    let stored = read_stored_params(ctx, &target, &args.instance_name)?;
    Ok(missing_params(&args.def, stored.as_ref()))
}

pub(super) fn update_inner(
    ctx: &AppContext,
    args: &UpdateMcpArgs,
) -> Result<(Vec<McpInstalled>, Vec<McpSkipped>), String> {
    // Validate the RENDERER-supplied values against the new def's options
    // BEFORE any update below removes or writes anything -- the same pre-pass
    // `apply_inner` runs, for the same reason and against the same rule. These
    // are the newly-required params the user just filled in, so an
    // out-of-options value among them is the interface having been bypassed,
    // not a stale record: refusing it names something the user can change.
    // The instance's OWN stored values are migrated and reported instead, in
    // the loop below. See [`ValuesOrigin`].
    for u in &args.updates {
        if let Some((parameter, value)) =
            invalid_option_values(&u.def, &u.values).into_iter().next()
        {
            return Err(format!(
                "Invalid value \"{value}\" for mcp param \"{parameter}\" in \"{}\".",
                u.identity.source
            ));
        }
    }

    let mut updated: Vec<McpInstalled> = Vec::new();
    let mut skipped: Vec<McpSkipped> = Vec::new();
    for u in &args.updates {
        // The def may have changed transport since it was installed, to one
        // this agent cannot express -- `mcpInstallHasUpdate` compares hashes
        // and nothing else, so an ordinary Update click can carry it here.
        // `apply_inner` gates its installs on this; without the same gate the
        // remove below succeeds, the reinstall fails inside the writer, and a
        // working instance is gone along with the values stored for it.
        if !supports_transport(u.agent, u.def.transport) {
            skipped.push(McpSkipped {
                agent: u.agent,
                source: u.identity.source.clone(),
                reason: McpSkipReason::Transport,
                transport: Some(u.def.transport),
            });
            continue;
        }
        // Rewritten without its auth block, this server would look updated and
        // fail to authenticate. Declining is the honest outcome -- and it must
        // happen before the remove below, or the instance would be deleted and
        // not put back.
        if u.def.oauth.is_some() && !supports_oauth(u.agent) {
            skipped.push(McpSkipped {
                agent: u.agent,
                source: u.identity.source.clone(),
                reason: McpSkipReason::Oauth,
                transport: None,
            });
            continue;
        }
        let target = resolve_mcp_target(ctx, u.agent, args.scope, &u.project_path, &u.project_id)?;
        let stored = read_stored_params(ctx, &target, &u.instance_name)?;
        let mut values = stored.unwrap_or_default();
        for (key, value) in &u.values {
            values.insert(key.clone(), value.clone());
        }
        // Bring a STORED option value back in line with the new def's options
        // before the destructive remove below: a value an earlier install may
        // have recorded is no longer guaranteed to be offered, and the remove
        // below would otherwise delete the instance without first fixing up
        // the value that gets reinstalled under the same name. The
        // renderer-supplied overrides merged in above were already refused if
        // out of set, so this only ever migrates what came off disk.
        let option_notes = migrate_option_values(&u.def, &mut values);
        // The last thing checked before anything is destroyed: a placeholder
        // with no value fails inside `install_mcp_instance`, which runs AFTER
        // the remove below, so without this the instance and its stored values
        // are gone and the error names a parameter the user was never asked
        // for. `mcp_update_preflight` exists to collect these, but nothing
        // makes the renderer call it, and the CLI's own `mcp update` refuses
        // here rather than trusting its caller
        // (`crates/skillkeeper-cli/src/commands/mcp.rs`). Refusing now leaves
        // this instance exactly as it was.
        let missing = missing_params(&u.def, Some(&values));
        if !missing.is_empty() {
            return Err(format!(
                "Cannot update \"{}\": no value for mcp param{} {}.",
                u.identity.source,
                if missing.len() == 1 { "" } else { "s" },
                missing
                    .iter()
                    .map(|p| format!("\"{p}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        remove_mcp_instance(
            &ctx.fs,
            &RemoveMcpArgs {
                agent: u.agent,
                native_path: target.native_path.clone(),
                ledger_path: target.ledger_path.clone(),
                params_path: target.params_path.clone(),
                guidance_files: target.guidance_files.clone(),
                instance_name: u.instance_name.clone(),
            },
        )
        .map_err(|e| e.to_string())?;
        let outcome = install_mcp_instance(
            &ctx.fs,
            &InstallMcpArgs {
                agent: u.agent,
                native_path: target.native_path.clone(),
                ledger_path: target.ledger_path.clone(),
                params_path: target.params_path.clone(),
                guidance_files: target.guidance_files.clone(),
                identity: u.identity.to_core(),
                def: u.def.clone(),
                values,
                instance_name: Some(u.instance_name.clone()),
                // Gated on the RESOLVED scope, not the requested one: see
                // `McpTarget::scope`. Codex resolves globally even when the
                // renderer asked for a project, and a global write has no
                // repository whose `.gitignore` to touch.
                gitignore_project_path: if target.scope == Scope::Global {
                    None
                } else {
                    Some(u.project_path.clone())
                },
            },
        )
        .map_err(|e| e.to_string())?;
        let mut notes = option_notes;
        notes.extend(outcome.notes);
        updated.push(McpInstalled {
            agent: u.agent,
            instance_name: outcome.instance_name,
            notes,
        });
    }
    Ok((updated, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mcp::testutil::*;
    use crate::commands::mcp::{apply, installs, update, update_preflight};
    use crate::commands::test_support::TempAppData;
    use skillkeeper_core::mcp::{hash_mcp_def, UpsertNote, SKMCP_PARAMS_FILE};
    use skillkeeper_core::models::AgentKind;
    use std::path::Path;

    use super::super::types::{ApplyMcpArgs, McpBatch, McpUpdateReq};

    // ---- update / preflight ----

    #[test]
    fn update_preflight_reports_only_newly_required_params_then_update_reinstalls() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        assert!(
            apply(
                &app.ctx,
                apply_args(
                    &proj,
                    vec![McpBatch {
                        agent: AgentKind::Claude,
                        install: vec![install_req(stdio_token_def(), &[("token", "abc")])],
                        remove: vec![],
                    }],
                ),
            )
            .ok
        );

        // Preflight the updated def: token is stored, only org is missing.
        let pre = update_preflight(
            &app.ctx,
            McpUpdatePreflightArgs {
                scope: Scope::Project,
                project_id: "proj-1".to_string(),
                project_path: proj.path(),
                agent: AgentKind::Claude,
                instance_name: "github_1".to_string(),
                def: stdio_token_org_def(),
            },
        );
        assert!(pre.ok);
        assert_eq!(
            pre.missing_params.as_deref(),
            Some(["org".to_string()].as_slice())
        );

        // Update supplying only the newly-required org; token is merged from store.
        let updated = update(
            &app.ctx,
            UpdateMcpArgs {
                scope: Scope::Project,
                updates: vec![McpUpdateReq {
                    project_id: "proj-1".to_string(),
                    project_path: proj.path(),
                    agent: AgentKind::Claude,
                    instance_name: "github_1".to_string(),
                    identity: identity(),
                    def: stdio_token_org_def(),
                    values: values(&[("org", "acme")]),
                }],
            },
        );
        assert!(updated.ok, "update failed: {:?}", updated.error);
        assert_eq!(updated.updated.as_ref().map(Vec::len), Some(1));

        let native = std::fs::read_to_string(Path::new(&proj.path()).join(".mcp.json")).unwrap();
        assert!(native.contains("acme"));
        assert!(native.contains("abc")); // stored token preserved

        // Ledger hash refreshed to the new def; instance name reused.
        let listed = installs(&app.ctx);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].instance_name, "github_1");
        assert_eq!(listed[0].hash, hash_mcp_def(&stdio_token_org_def()));
    }

    // ---- option values ----

    #[test]
    fn update_migrates_a_stored_option_no_longer_offered_and_reports_it() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        assert!(
            apply(
                &app.ctx,
                apply_args(
                    &proj,
                    vec![McpBatch {
                        agent: AgentKind::Claude,
                        install: vec![install_req(choice_def(), &[("choice", "alpha")])],
                        remove: vec![],
                    }],
                ),
            )
            .ok
        );

        let updated = update(
            &app.ctx,
            UpdateMcpArgs {
                scope: Scope::Project,
                updates: vec![McpUpdateReq {
                    project_id: "proj-1".to_string(),
                    project_path: proj.path(),
                    agent: AgentKind::Claude,
                    instance_name: "github_1".to_string(),
                    identity: identity(),
                    def: choice_def_alpha_dropped(),
                    values: BTreeMap::new(),
                }],
            },
        );
        assert!(updated.ok, "update failed: {:?}", updated.error);
        let updated_list = updated.updated.expect("updated list");
        assert_eq!(updated_list.len(), 1);
        assert!(
            updated_list[0].notes.iter().any(|n| matches!(
                n,
                UpsertNote::OptionSubstituted { parameter, value }
                    if parameter == "choice" && value == "beta"
            )),
            "got {:?}",
            updated_list[0].notes
        );

        // Assert the substitution actually landed in the stored params, not
        // just in the returned note: a migration call that ran after the
        // destructive reinstall (or was skipped entirely) would still leave
        // this check passing if only the returned note were inspected.
        let params_text = std::fs::read_to_string(
            Path::new(&proj.path())
                .join(".claude/skills")
                .join(SKMCP_PARAMS_FILE),
        )
        .expect("params file written");
        let stored = parse_skmcp_params(&params_text);
        assert_eq!(
            stored.get("github_1").and_then(|m| m.get("choice")),
            Some(&"beta".to_string())
        );
    }

    /// An option list that went empty is silent, not a note: an empty list
    /// cannot be told apart from a parameter that only ever carried a
    /// `description`, so a note here fired on every described parameter on
    /// every update. The stored value still stands -- clearing it would break
    /// a working install.
    #[test]
    fn update_says_nothing_about_an_emptied_option_set_and_keeps_the_stored_value() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        assert!(
            apply(
                &app.ctx,
                apply_args(
                    &proj,
                    vec![McpBatch {
                        agent: AgentKind::Claude,
                        install: vec![install_req(choice_def(), &[("choice", "alpha")])],
                        remove: vec![],
                    }],
                ),
            )
            .ok
        );

        let mut emptied_options = choice_def();
        emptied_options
            .parameters
            .get_mut("choice")
            .unwrap()
            .options
            .clear();

        let updated = update(
            &app.ctx,
            UpdateMcpArgs {
                scope: Scope::Project,
                updates: vec![McpUpdateReq {
                    project_id: "proj-1".to_string(),
                    project_path: proj.path(),
                    agent: AgentKind::Claude,
                    instance_name: "github_1".to_string(),
                    identity: identity(),
                    def: emptied_options,
                    values: BTreeMap::new(),
                }],
            },
        );
        assert!(updated.ok, "update failed: {:?}", updated.error);
        let updated_list = updated.updated.expect("updated list");
        assert!(
            updated_list[0].notes.is_empty(),
            "an emptied option set has nothing true to report, got {:?}",
            updated_list[0].notes
        );

        let params_text = std::fs::read_to_string(
            Path::new(&proj.path())
                .join(".claude/skills")
                .join(SKMCP_PARAMS_FILE),
        )
        .expect("params file written");
        let stored = parse_skmcp_params(&params_text);
        assert_eq!(
            stored.get("github_1").and_then(|m| m.get("choice")),
            Some(&"alpha".to_string())
        );
    }

    /// The value came from the renderer's own prompt, so it is refused rather
    /// than migrated. Migrating it would rewrite what the user typed seconds
    /// ago and then report that the STORED value was no longer accepted --
    /// blaming a file for the user's own input.
    #[test]
    fn update_refuses_a_renderer_supplied_value_outside_the_options() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        assert!(
            apply(
                &app.ctx,
                apply_args(
                    &proj,
                    vec![McpBatch {
                        agent: AgentKind::Claude,
                        install: vec![install_req(choice_def(), &[("choice", "alpha")])],
                        remove: vec![],
                    }],
                ),
            )
            .ok
        );

        let updated = update(
            &app.ctx,
            UpdateMcpArgs {
                scope: Scope::Project,
                updates: vec![McpUpdateReq {
                    project_id: "proj-1".to_string(),
                    project_path: proj.path(),
                    agent: AgentKind::Claude,
                    instance_name: "github_1".to_string(),
                    identity: identity(),
                    def: choice_def(),
                    values: values(&[("choice", "admin")]),
                }],
            },
        );
        assert!(!updated.ok, "an out-of-options override must not succeed");
        let error = updated.error.unwrap_or_default();
        assert!(error.contains("choice"), "got {error}");
        assert!(error.contains("admin"), "got {error}");

        // The check runs before the destructive remove-then-reinstall, so the
        // instance is left exactly as it was -- not silently migrated, and
        // above all not deleted.
        let params_text = std::fs::read_to_string(
            Path::new(&proj.path())
                .join(".claude/skills")
                .join(SKMCP_PARAMS_FILE),
        )
        .expect("params file still there");
        let stored = parse_skmcp_params(&params_text);
        assert_eq!(
            stored.get("github_1").and_then(|m| m.get("choice")),
            Some(&"alpha".to_string())
        );
    }

    /// A def whose transport the agent cannot express, arriving through the
    /// ordinary update path. `mcpInstallHasUpdate` compares hashes and nothing
    /// else, so a source edited from http to sse reaches Codex's update as a
    /// normal pending change. Before the guard, the remove succeeded and the
    /// reinstall failed inside the writer, leaving nothing behind.
    #[test]
    fn update_skips_a_transport_the_agent_cannot_express_without_removing_it() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        assert!(
            apply(
                &app.ctx,
                apply_args(
                    &proj,
                    vec![McpBatch {
                        agent: AgentKind::Codex,
                        install: vec![install_req(http_def(), &[])],
                        remove: vec![],
                    }],
                ),
            )
            .ok
        );
        let native = Path::new(&proj.path()).join(".codex/config.toml");
        let before = std::fs::read_to_string(&native).expect("codex config written");
        assert!(before.contains("mcp_servers"), "got {before}");

        let updated = update(
            &app.ctx,
            UpdateMcpArgs {
                scope: Scope::Project,
                updates: vec![McpUpdateReq {
                    project_id: "proj-1".to_string(),
                    project_path: proj.path(),
                    agent: AgentKind::Codex,
                    instance_name: "github_1".to_string(),
                    identity: identity(),
                    def: sse_def(),
                    values: BTreeMap::new(),
                }],
            },
        );

        assert!(updated.ok, "the call itself must succeed, reporting a skip");
        assert_eq!(updated.updated.unwrap_or_default().len(), 0);
        let skipped = updated.skipped.unwrap_or_default();
        assert_eq!(skipped.len(), 1, "the decline must be reported");
        assert!(matches!(skipped[0].reason, McpSkipReason::Transport));
        assert_eq!(
            std::fs::read_to_string(&native).expect("codex config still there"),
            before,
            "the working instance must be left exactly as it was"
        );
    }

    /// The other way `install_mcp_instance` fails after the remove has already
    /// run: a placeholder with no value anywhere. The CLI's `mcp update`
    /// refuses this before touching anything; this backend did not.
    #[test]
    fn update_refuses_a_missing_parameter_value_without_removing_the_instance() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        assert!(
            apply(
                &app.ctx,
                apply_args(
                    &proj,
                    vec![McpBatch {
                        agent: AgentKind::Claude,
                        install: vec![install_req(choice_def(), &[("choice", "alpha")])],
                        remove: vec![],
                    }],
                ),
            )
            .ok
        );

        // The updated source needs a second placeholder nothing has a value
        // for -- exactly what `mcp_update_preflight` is meant to collect.
        let mut def = choice_def();
        def.url = Some("https://mcp.example.com/{region}/mcp".to_string());
        let updated = update(
            &app.ctx,
            UpdateMcpArgs {
                scope: Scope::Project,
                updates: vec![McpUpdateReq {
                    project_id: "proj-1".to_string(),
                    project_path: proj.path(),
                    agent: AgentKind::Claude,
                    instance_name: "github_1".to_string(),
                    identity: identity(),
                    def,
                    values: BTreeMap::new(),
                }],
            },
        );

        assert!(!updated.ok, "a missing value must not silently proceed");
        let error = updated.error.unwrap_or_default();
        assert!(error.contains("region"), "got {error}");

        let params_text = std::fs::read_to_string(
            Path::new(&proj.path())
                .join(".claude/skills")
                .join(SKMCP_PARAMS_FILE),
        )
        .expect("params file still there");
        assert_eq!(
            parse_skmcp_params(&params_text)
                .get("github_1")
                .and_then(|m| m.get("choice")),
            Some(&"alpha".to_string()),
            "the instance and its stored value must survive the refusal"
        );
    }

    // ---- global scope ----

    #[test]
    fn update_at_global_scope_touches_no_gitignore_for_a_non_codex_agent() {
        // Regression test for a fix-round-1 finding: update_inner's gitignore
        // gate used to key off `is_codex` instead of `args.scope`, so a global
        // update for a non-codex agent (empty project_path, as every global
        // call uses) resolved `format!("{project_path}/.gitignore")` to the
        // absolute root path `/.gitignore` instead of skipping gitignore
        // entirely.
        let app = CodexApp::new();

        assert!(
            apply(
                &app.ctx,
                ApplyMcpArgs {
                    scope: Scope::Global,
                    project_id: String::new(),
                    project_path: String::new(),
                    batches: vec![McpBatch {
                        agent: AgentKind::Claude,
                        install: vec![install_req(stdio_token_def(), &[("token", "abc")])],
                        remove: vec![],
                    }],
                },
            )
            .ok
        );

        let updated = update(
            &app.ctx,
            UpdateMcpArgs {
                scope: Scope::Global,
                updates: vec![McpUpdateReq {
                    project_id: String::new(),
                    project_path: String::new(),
                    agent: AgentKind::Claude,
                    instance_name: "github_1".to_string(),
                    identity: identity(),
                    def: stdio_token_org_def(),
                    values: values(&[("org", "acme")]),
                }],
            },
        );
        assert!(updated.ok, "global update failed: {:?}", updated.error);
        assert_eq!(updated.updated.as_ref().map(Vec::len), Some(1));

        // Native config reflects the new def; the stored token is preserved.
        let native = std::fs::read_to_string(app.home.join(".claude.json")).unwrap();
        assert!(native.contains("acme"));
        assert!(native.contains("abc"));

        // No .gitignore under the isolated home. (The old is_codex-gated bug
        // would have written the filesystem-root path `/.gitignore`, from an
        // empty project_path plus `format!("{}/.gitignore", "")`. That is not
        // asserted here: `/.gitignore` is outside the test's sandbox, so the
        // assertion would report the state of the developer's machine rather
        // than of this run. The `mcp_destination` / `base_dir` blank-input
        // guards are what keep an empty path from resolving to the root now.)
        assert!(!app.home.join(".gitignore").exists());
    }

    // ---- codex (TOML) + transport gating ----

    #[test]
    fn update_declines_a_copilot_instance_that_gained_an_oauth_block() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        // Installed while the preset had no oauth, which copilot can express.
        assert!(
            apply(
                &app.ctx,
                apply_args(
                    &proj,
                    vec![McpBatch {
                        agent: AgentKind::Copilot,
                        install: vec![install_req(http_def(), &[])],
                        remove: vec![],
                    }],
                ),
            )
            .ok
        );
        let native_path = Path::new(&proj.path()).join(".vscode/mcp.json");
        let before = std::fs::read_to_string(&native_path).expect("native config written");
        assert!(before.contains("github_1"));

        // The preset gains an oauth block copilot cannot express.
        let result = update(
            &app.ctx,
            UpdateMcpArgs {
                scope: Scope::Project,
                updates: vec![McpUpdateReq {
                    project_id: "proj-1".to_string(),
                    project_path: proj.path(),
                    agent: AgentKind::Copilot,
                    instance_name: "github_1".to_string(),
                    identity: identity(),
                    def: oauth_http_def(),
                    values: values(&[]),
                }],
            },
        );
        assert!(result.ok, "update failed: {:?}", result.error);
        assert_eq!(result.updated.as_ref().map(Vec::len), Some(0));
        let skipped = result.skipped.expect("skipped list present");
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].agent, AgentKind::Copilot);
        assert_eq!(skipped[0].source, "github");
        assert_eq!(skipped[0].reason, McpSkipReason::Oauth);
        assert_eq!(skipped[0].transport, None);

        // Untouched: not rewritten without its auth, and NOT deleted by the
        // remove half of the reinstall -- the gate runs before the remove.
        assert_eq!(
            std::fs::read_to_string(&native_path).expect("native config still there"),
            before
        );
        assert_eq!(installs(&app.ctx).len(), 1);
    }

    #[test]
    fn update_carries_the_writer_notes_on_the_updated_target() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        assert!(
            apply(
                &app.ctx,
                apply_args(
                    &proj,
                    vec![McpBatch {
                        agent: AgentKind::Cursor,
                        install: vec![install_req(http_def(), &[])],
                        remove: vec![],
                    }],
                ),
            )
            .ok
        );

        // Cursor CAN express an oauth client, minus the callback port.
        let result = update(
            &app.ctx,
            UpdateMcpArgs {
                scope: Scope::Project,
                updates: vec![McpUpdateReq {
                    project_id: "proj-1".to_string(),
                    project_path: proj.path(),
                    agent: AgentKind::Cursor,
                    instance_name: "github_1".to_string(),
                    identity: identity(),
                    def: oauth_http_def(),
                    values: values(&[]),
                }],
            },
        );
        assert!(result.ok, "update failed: {:?}", result.error);
        assert_eq!(result.skipped.as_ref().map(Vec::len), Some(0));
        let updated = result.updated.expect("updated list present");
        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0].agent, AgentKind::Cursor);
        assert_eq!(updated[0].instance_name, "github_1");
        assert_eq!(
            updated[0].notes,
            vec![UpsertNote::DroppedField {
                field: "callbackPort".to_string()
            }]
        );
    }
}
