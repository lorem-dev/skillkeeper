//! `mcp:apply`.

use std::collections::BTreeMap;

use skillkeeper_core::mcp::params::{invalid_option_values, migrate_option_values};
use skillkeeper_core::mcp::{
    install_mcp_instance, parse_skmcp_params, remove_mcp_instance, supports_oauth,
    supports_transport, InstallMcpArgs, RemoveMcpArgs,
};
use skillkeeper_core::models::Scope;
use skillkeeper_core::ports::FsPort;

use crate::state::AppContext;

use super::target::resolve_mcp_target;
use super::types::{ApplyMcpArgs, McpInstallReq, McpInstalled, McpSkipReason, McpSkipped};

/// Where one install request's parameter values came from, which is what
/// decides how an out-of-options value among them is treated.
///
/// A value the RENDERER supplied is an error: `paramValueValid` blocks it
/// client-side, so one arriving here means the interface was bypassed, and the
/// user is looking at the control that produced it. A value read off
/// `.skmcp.params.yml` is migrated and reported instead: the renderer never
/// sees it (`mcpPlan.ts` withholds it deliberately, because it may hold
/// secrets), so an error about it names a file the user may never have opened
/// -- and it would abort every unrelated install and remove in the same batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ValuesOrigin {
    /// From the install request itself, i.e. from the interface.
    Renderer,
    /// Read out of another agent's stored `.skmcp.params.yml` entry.
    Stored,
}

/// Resolve the values to render for one install request: `ins.values`, unless
/// `copyParamsFrom` names another agent's already-installed instance of the same
/// identity, in which case its stored `.skmcp.params.yml` entry is used (falling
/// back to `ins.values` when that entry cannot be read). Port of the TS
/// `resolveInstallValues`. The [`ValuesOrigin`] beside the map says which of
/// the two it ended up being; a fallback to `ins.values` is `Renderer`,
/// because that is where those values came from.
fn resolve_install_values(
    ctx: &AppContext,
    args: &ApplyMcpArgs,
    ins: &McpInstallReq,
) -> (BTreeMap<String, String>, ValuesOrigin) {
    let renderer = || (ins.values.clone(), ValuesOrigin::Renderer);
    let Some(copy) = &ins.copy_params_from else {
        return renderer();
    };
    let target = match resolve_mcp_target(
        ctx,
        copy.agent,
        args.scope,
        &args.project_path,
        &args.project_id,
    ) {
        Ok(t) => t,
        Err(_) => return renderer(),
    };
    if !ctx.fs.exists(&target.params_path).unwrap_or(false) {
        return renderer();
    }
    let text = match ctx.fs.read_file(&target.params_path) {
        Ok(t) => t,
        Err(_) => return renderer(),
    };
    match parse_skmcp_params(&text).get(&copy.instance_name).cloned() {
        Some(stored) => (stored, ValuesOrigin::Stored),
        None => renderer(),
    }
}

/// The fallible body of [`apply`](super::apply()), run under the state lock.
pub(super) fn apply_inner(
    ctx: &AppContext,
    args: &ApplyMcpArgs,
) -> Result<(Vec<McpInstalled>, usize, Vec<McpSkipped>), String> {
    // Validate every install request's RENDERER-supplied values against its
    // preset's options BEFORE any batch below removes or writes anything.
    // This is an error, not a per-agent `McpSkipped`: an invalid option value
    // is a property of the preset, not of one agent's native config, so it
    // applies to every target in this call. The renderer already blocks it
    // through `paramValueValid`, so a value reaching here means something
    // bypassed the interface.
    //
    // `ins.values` deliberately rather than `resolve_install_values`: a value
    // that came off `.skmcp.params.yml` is not the user's current input and is
    // migrated below instead of aborting the whole batch. See [`ValuesOrigin`].
    for batch in &args.batches {
        for ins in &batch.install {
            if let Some((parameter, value)) = invalid_option_values(&ins.def, &ins.values)
                .into_iter()
                .next()
            {
                return Err(format!(
                    "Invalid value \"{value}\" for mcp param \"{parameter}\" in \"{}\".",
                    ins.identity.source
                ));
            }
        }
    }

    let mut installed: Vec<McpInstalled> = Vec::new();
    let mut removed = 0usize;
    let mut skipped: Vec<McpSkipped> = Vec::new();

    for batch in &args.batches {
        let target = resolve_mcp_target(
            ctx,
            batch.agent,
            args.scope,
            &args.project_path,
            &args.project_id,
        )?;

        for rem in &batch.remove {
            remove_mcp_instance(
                &ctx.fs,
                &RemoveMcpArgs {
                    agent: batch.agent,
                    native_path: target.native_path.clone(),
                    ledger_path: target.ledger_path.clone(),
                    params_path: target.params_path.clone(),
                    guidance_files: target.guidance_files.clone(),
                    instance_name: rem.instance_name.clone(),
                },
            )
            .map_err(|e| e.to_string())?;
            removed += 1;
        }

        for ins in &batch.install {
            if !supports_transport(batch.agent, ins.def.transport) {
                skipped.push(McpSkipped {
                    agent: batch.agent,
                    source: ins.identity.source.clone(),
                    reason: McpSkipReason::Transport,
                    transport: Some(ins.def.transport),
                });
                continue;
            }
            // Written without its auth block, this server would look installed
            // and fail to authenticate. Skipping is the honest outcome.
            if ins.def.oauth.is_some() && !supports_oauth(batch.agent) {
                skipped.push(McpSkipped {
                    agent: batch.agent,
                    source: ins.identity.source.clone(),
                    reason: McpSkipReason::Oauth,
                    transport: None,
                });
                continue;
            }
            let (mut values, origin) = resolve_install_values(ctx, args, ins);
            // A stored value copied off another agent's `.skmcp.params.yml` may
            // name an option the source no longer offers. Migrating and
            // reporting it is the update path's answer to exactly this, and it
            // has to be this path's too: the renderer never saw the value, so
            // an error naming it is one the user cannot act on -- and it would
            // abort every unrelated install and remove in the batch. The
            // renderer's own values were refused outright above, so this runs
            // over disk-sourced values only.
            let option_notes = if origin == ValuesOrigin::Stored {
                migrate_option_values(&ins.def, &mut values)
            } else {
                Vec::new()
            };
            let outcome = install_mcp_instance(
                &ctx.fs,
                &InstallMcpArgs {
                    agent: batch.agent,
                    native_path: target.native_path.clone(),
                    ledger_path: target.ledger_path.clone(),
                    params_path: target.params_path.clone(),
                    guidance_files: target.guidance_files.clone(),
                    identity: ins.identity.to_core(),
                    def: ins.def.clone(),
                    values,
                    instance_name: None,
                    // Gated on the RESOLVED scope, not the requested one: a
                    // global write has no repository to keep the ledger out of.
                    gitignore_project_path: if target.scope == Scope::Global {
                        None
                    } else {
                        Some(args.project_path.clone())
                    },
                },
            )
            .map_err(|e| e.to_string())?;
            let mut notes = option_notes;
            notes.extend(outcome.notes);
            installed.push(McpInstalled {
                agent: batch.agent,
                instance_name: outcome.instance_name,
                notes,
            });
        }
    }

    Ok((installed, removed, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mcp::testutil::*;
    use crate::commands::mcp::{apply, installs, reconcile};
    use crate::commands::test_support::TempAppData;
    use skillkeeper_core::hooks::region::{
        insert_region, lift_regions, wrap_region, InsertMode, WrapRegionOptions,
    };
    use skillkeeper_core::mcp::{McpTransport, UpsertNote, SKMCP_FILE};
    use skillkeeper_core::models::AgentKind;
    use std::path::{Path, PathBuf};

    use super::super::types::{CopyParamsFrom, McpBatch, McpRemoveReq};

    // ---- apply (JSON: claude) ----

    #[test]
    fn apply_creates_native_server_ledger_and_gitignore() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        let result = apply(
            &app.ctx,
            apply_args(
                &proj,
                vec![McpBatch {
                    agent: AgentKind::Claude,
                    install: vec![install_req(stdio_token_def(), &[("token", "secret123")])],
                    remove: vec![],
                }],
            ),
        );
        assert!(result.ok, "apply failed: {:?}", result.error);
        assert_eq!(result.installed.as_ref().map(Vec::len), Some(1));
        assert_eq!(result.removed, Some(0));
        assert_eq!(result.skipped.as_ref().map(Vec::len), Some(0));

        // Native config written to the claude project destination.
        let native = std::fs::read_to_string(Path::new(&proj.path()).join(".mcp.json"))
            .expect("native config written");
        assert!(native.contains("github_1"));
        assert!(native.contains("secret123"));
        assert!(!native.contains("{token}"));

        // gitignore ensured for the project.
        let gitignore = std::fs::read_to_string(Path::new(&proj.path()).join(".gitignore"))
            .expect("gitignore written");
        assert!(gitignore.contains(".skmcp.params.yml"));

        // Ledger round-trips via installs(); hasParams true (token stored).
        let listed = installs(&app.ctx);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].agent, AgentKind::Claude);
        assert_eq!(listed[0].instance_name, "github_1");
        assert_eq!(listed[0].identity.source, "github");
        assert_eq!(listed[0].project_id, "proj-1");
        assert!(listed[0].has_params);
    }

    #[test]
    fn apply_preserves_a_foreign_user_server_and_removal_is_idempotent() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        // A user-authored server SkillKeeper must never clobber.
        std::fs::write(
            Path::new(&proj.path()).join(".mcp.json"),
            "{\n  \"mcpServers\": {\n    \"user_server\": { \"type\": \"stdio\", \"command\": \"user-defined\" }\n  }\n}\n",
        )
        .unwrap();

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
        let native = std::fs::read_to_string(Path::new(&proj.path()).join(".mcp.json")).unwrap();
        assert!(native.contains("user-defined"), "foreign server clobbered");
        assert!(native.contains("github_1"));

        // Remove our instance; the foreign server survives.
        let removed = apply(
            &app.ctx,
            apply_args(
                &proj,
                vec![McpBatch {
                    agent: AgentKind::Claude,
                    install: vec![],
                    remove: vec![McpRemoveReq {
                        instance_name: "github_1".to_string(),
                    }],
                }],
            ),
        );
        assert!(removed.ok);
        assert_eq!(removed.removed, Some(1));
        let native = std::fs::read_to_string(Path::new(&proj.path()).join(".mcp.json")).unwrap();
        assert!(native.contains("user-defined"));
        assert!(!native.contains("github_1"));

        // Removing the same (now absent) instance again is a safe no-op.
        let again = apply(
            &app.ctx,
            apply_args(
                &proj,
                vec![McpBatch {
                    agent: AgentKind::Claude,
                    install: vec![],
                    remove: vec![McpRemoveReq {
                        instance_name: "github_1".to_string(),
                    }],
                }],
            ),
        );
        assert!(again.ok);
        let native = std::fs::read_to_string(Path::new(&proj.path()).join(".mcp.json")).unwrap();
        assert!(native.contains("user-defined"));
        assert!(installs(&app.ctx).is_empty());
    }
    // ---- option values ----

    #[test]
    fn apply_rejects_a_value_outside_the_options_and_writes_nothing() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        let result = apply(
            &app.ctx,
            apply_args(
                &proj,
                vec![McpBatch {
                    agent: AgentKind::Claude,
                    install: vec![install_req(choice_def(), &[("choice", "nope")])],
                    remove: vec![],
                }],
            ),
        );

        assert!(!result.ok, "an out-of-options value must be rejected");
        let error = result.error.unwrap_or_default();
        assert!(error.contains("choice"), "got {error}");
        assert!(error.contains("nope"), "got {error}");

        // A refusal is not a partial install: the check must run before any
        // agent is touched, so neither the native config nor the ledger
        // exists. A check that ran AFTER the write would still return
        // `ok: false` here and this would be the only thing to catch it.
        assert!(!Path::new(&proj.path()).join(".mcp.json").exists());
        assert!(!Path::new(&proj.path())
            .join(".claude/skills")
            .join(SKMCP_FILE)
            .exists());
    }

    #[test]
    fn apply_accepts_a_value_that_is_one_of_the_options() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        let result = apply(
            &app.ctx,
            apply_args(
                &proj,
                vec![McpBatch {
                    agent: AgentKind::Claude,
                    install: vec![install_req(choice_def(), &[("choice", "alpha")])],
                    remove: vec![],
                }],
            ),
        );
        assert!(result.ok, "apply failed: {:?}", result.error);
    }
    /// `copyParamsFrom` reads the value off `.skmcp.params.yml`, which the
    /// renderer deliberately never sees because it may hold secrets. So an
    /// out-of-options value there is not something the user bypassed the
    /// interface with, and erroring would abort every unrelated install and
    /// remove in the batch over a file they may never have opened.
    #[test]
    fn apply_migrates_a_stored_copied_value_instead_of_failing_the_batch() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        // Claude holds a stored "alpha".
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

        // Cursor installs the SAME identity by copying claude's stored value,
        // against a def that no longer offers "alpha".
        let result = apply(
            &app.ctx,
            apply_args(
                &proj,
                vec![McpBatch {
                    agent: AgentKind::Cursor,
                    install: vec![McpInstallReq {
                        identity: identity(),
                        def: choice_def_alpha_dropped(),
                        values: BTreeMap::new(),
                        copy_params_from: Some(CopyParamsFrom {
                            agent: AgentKind::Claude,
                            instance_name: "github_1".to_string(),
                        }),
                    }],
                    remove: vec![],
                }],
            ),
        );
        assert!(result.ok, "the batch must not abort: {:?}", result.error);
        let installed = result.installed.expect("installed list");
        assert!(
            installed[0].notes.iter().any(|n| matches!(
                n,
                UpsertNote::OptionSubstituted { parameter, value }
                    if parameter == "choice" && value == "beta"
            )),
            "the substitution must be reported, never silent: {:?}",
            installed[0].notes
        );

        let cursor_target = resolve_mcp_target(
            &app.ctx,
            AgentKind::Cursor,
            Scope::Project,
            &proj.path(),
            "proj-1",
        )
        .expect("cursor target");
        let params_text = std::fs::read_to_string(&cursor_target.params_path)
            .expect("cursor params file written");
        let stored = parse_skmcp_params(&params_text);
        assert_eq!(
            stored
                .values()
                .next()
                .and_then(|m| m.get("choice"))
                .map(String::as_str),
            Some("beta"),
            "the migrated value is what gets written"
        );
    }
    // ---- global scope ----

    #[test]
    fn apply_installs_globally_for_a_project_agent() {
        // CodexApp isolates the home dir; reuse it for any global-scope write.
        let app = CodexApp::new();

        let result = apply(
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
        );
        assert!(result.ok, "global apply failed: {:?}", result.error);
        assert_eq!(result.installed.as_ref().map(Vec::len), Some(1));

        // Native config in the home, ledger under the agent's global skills root.
        let native = std::fs::read_to_string(app.home.join(".claude.json"))
            .expect("global claude config written");
        assert!(native.contains("github_1"));
        assert!(app.home.join(".claude/skills/.skmcp.yml").exists());

        // No .gitignore is touched at global scope: there is no repository.
        assert!(!app.home.join(".gitignore").exists());

        let listed = installs(&app.ctx);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].project_id, "global");
        assert_eq!(listed[0].agent, AgentKind::Claude);
    }

    #[test]
    fn apply_installs_a_codex_batch_at_project_scope() {
        let app = CodexApp::new();
        let project_path = app.home.join("proj").to_string_lossy().into_owned();

        let result = apply(
            &app.ctx,
            ApplyMcpArgs {
                scope: Scope::Project,
                project_id: "p1".to_string(),
                project_path: project_path.clone(),
                batches: vec![McpBatch {
                    agent: AgentKind::Codex,
                    install: vec![install_req(stdio_token_def(), &[("token", "abc")])],
                    remove: vec![],
                }],
            },
        );
        assert!(
            result.ok,
            "codex project install failed: {:?}",
            result.error
        );
        assert_eq!(result.installed.as_ref().map(Vec::len), Some(1));
        assert_eq!(result.skipped.as_ref().map(Vec::len), Some(0));

        // Native config written under the project, not the home.
        let native = std::fs::read_to_string(Path::new(&project_path).join(".codex/config.toml"))
            .expect("project-scoped codex config written");
        assert!(native.contains("[mcp_servers.github_1]"));
        assert!(!app.home.join(".codex/config.toml").exists());

        // Resolved scope is now Project, so the gitignore gate that keeps the
        // ledger out of the repository applies to codex exactly as it does for
        // every other agent.
        let gitignore = std::fs::read_to_string(Path::new(&project_path).join(".gitignore"))
            .expect("gitignore written for a project-scoped codex install");
        assert!(gitignore.contains(".skmcp.params.yml"));
    }
    #[test]
    fn apply_removes_a_codex_instance_at_project_scope() {
        // Before project scope was real, removing at PROJECT scope for codex was
        // reported as a skip (the batch could only ever land at Global). Now a
        // project-scope codex remove is honoured exactly like every other agent:
        // installed at project scope, then removed from that same project file.
        let app = CodexApp::new();
        let project_path = app.home.join("proj").to_string_lossy().into_owned();

        let installed = apply(
            &app.ctx,
            ApplyMcpArgs {
                scope: Scope::Project,
                project_id: "p1".to_string(),
                project_path: project_path.clone(),
                batches: vec![McpBatch {
                    agent: AgentKind::Codex,
                    install: vec![install_req(stdio_token_def(), &[("token", "abc")])],
                    remove: vec![],
                }],
            },
        );
        assert!(
            installed.ok,
            "project install failed: {:?}",
            installed.error
        );
        assert_eq!(installed.installed.as_ref().map(Vec::len), Some(1));

        let result = apply(
            &app.ctx,
            ApplyMcpArgs {
                scope: Scope::Project,
                project_id: "p1".to_string(),
                project_path: project_path.clone(),
                batches: vec![McpBatch {
                    agent: AgentKind::Codex,
                    install: vec![],
                    remove: vec![McpRemoveReq {
                        instance_name: "github_1".to_string(),
                    }],
                }],
            },
        );
        assert!(result.ok, "project remove failed: {:?}", result.error);
        assert_eq!(result.removed, Some(1));
        assert_eq!(result.skipped.as_ref().map(Vec::len), Some(0));

        let native = std::fs::read_to_string(Path::new(&project_path).join(".codex/config.toml"))
            .expect("project-scoped codex config still present");
        assert!(!native.contains("github_1"));
    }
    // ---- opencode global scope: MCP config and hook target are one file ----

    /// The exact block the delimited-text hook path writes into opencode's
    /// `opencode.json` (comment token `#`).
    fn opencode_hook_block() -> String {
        wrap_region(&WrapRegionOptions {
            comment_token: "#".to_string(),
            comment_close: None,
            delimiter_id: "9f8e7d6c5b4a".to_string(),
            label: "devtools/tool:preflight".to_string(),
            version: Some("1.0.0".to_string()),
            content: "echo preflight".to_string(),
        })
    }

    /// `~/.config/opencode/opencode.json` under the isolated home: opencode's
    /// global native MCP config AND its global hook target.
    fn opencode_global_config(app: &CodexApp) -> PathBuf {
        app.home.join(".config/opencode/opencode.json")
    }

    /// The JSON document inside a native config, with our hook regions lifted
    /// back out (the view the writer itself parses).
    fn native_json(path: &Path) -> serde_json::Value {
        let text = std::fs::read_to_string(path).expect("native config readable");
        let body = lift_regions(&text).0;
        serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("native config is not JSON: {e}\n{text}"))
    }

    fn global_opencode_apply(batches: Vec<McpBatch>) -> ApplyMcpArgs {
        ApplyMcpArgs {
            scope: Scope::Global,
            project_id: String::new(),
            project_path: String::new(),
            batches,
        }
    }

    #[test]
    fn global_opencode_mcp_install_and_removal_survive_an_existing_hook_region() {
        let app = CodexApp::new();
        let native = opencode_global_config(&app);
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();

        // A global opencode skill with hooks was installed first: the hook block
        // sits in the same file the MCP writer owns. This used to make every
        // later MCP install fail with a raw JSON parse error.
        let block = opencode_hook_block();
        std::fs::write(&native, format!("{{\n  \"theme\": \"dark\"\n}}\n{block}\n")).unwrap();

        let installed = apply(
            &app.ctx,
            global_opencode_apply(vec![McpBatch {
                agent: AgentKind::Opencode,
                install: vec![install_req(stdio_token_def(), &[("token", "abc")])],
                remove: vec![],
            }]),
        );
        assert!(installed.ok, "global apply failed: {:?}", installed.error);
        assert_eq!(installed.installed.as_ref().map(Vec::len), Some(1));

        let text = std::fs::read_to_string(&native).unwrap();
        assert!(text.contains(&block), "hook region lost: {text}");
        let json = native_json(&native);
        assert_eq!(json["theme"], "dark");
        assert_eq!(json["mcp"]["github_1"]["type"], "local");

        // reconcile reads the same file through `existing_names`; a parse error
        // there is swallowed by its global pass, which used to drop the instance
        // out of the interface while it stayed on disk.
        let listed = reconcile(&app.ctx);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].agent, AgentKind::Opencode);
        assert_eq!(listed[0].project_id, "global");
        assert_eq!(listed[0].instance_name, "github_1");

        let removed = apply(
            &app.ctx,
            global_opencode_apply(vec![McpBatch {
                agent: AgentKind::Opencode,
                install: vec![],
                remove: vec![McpRemoveReq {
                    instance_name: "github_1".to_string(),
                }],
            }]),
        );
        assert!(removed.ok, "global removal failed: {:?}", removed.error);
        assert_eq!(removed.removed, Some(1));

        let text = std::fs::read_to_string(&native).unwrap();
        assert!(text.contains(&block), "hook region lost on removal: {text}");
        let json = native_json(&native);
        assert_eq!(json["theme"], "dark");
        assert!(json["mcp"].get("github_1").is_none());
        assert!(reconcile(&app.ctx).is_empty());
    }

    #[test]
    fn global_opencode_survives_a_hook_region_appended_after_an_mcp_install() {
        // The reverse order: the MCP server goes in first, then a hooked skill
        // appends its block after the JSON.
        let app = CodexApp::new();
        assert!(
            apply(
                &app.ctx,
                global_opencode_apply(vec![McpBatch {
                    agent: AgentKind::Opencode,
                    install: vec![install_req(stdio_token_def(), &[("token", "abc")])],
                    remove: vec![],
                }]),
            )
            .ok
        );

        let native = opencode_global_config(&app);
        let block = opencode_hook_block();
        let hooked = insert_region(
            &std::fs::read_to_string(&native).unwrap(),
            &block,
            InsertMode::Append,
        );
        std::fs::write(&native, &hooked).unwrap();

        // A second install over that file, then a reconcile.
        let second = apply(
            &app.ctx,
            global_opencode_apply(vec![McpBatch {
                agent: AgentKind::Opencode,
                install: vec![install_req(http_def(), &[])],
                remove: vec![],
            }]),
        );
        assert!(second.ok, "second install failed: {:?}", second.error);

        let text = std::fs::read_to_string(&native).unwrap();
        assert!(text.contains(&block), "hook region lost: {text}");
        let json = native_json(&native);
        assert_eq!(json["mcp"]["github_1"]["type"], "local");
        assert_eq!(json["mcp"]["github_2"]["type"], "remote");

        let mut names: Vec<String> = reconcile(&app.ctx)
            .into_iter()
            .map(|i| i.instance_name)
            .collect();
        names.sort();
        assert_eq!(names, vec!["github_1", "github_2"]);
    }
    // ---- codex (TOML) + transport gating ----

    #[test]
    fn apply_writes_codex_toml_and_installs_reports_global_scope() {
        let app = CodexApp::new();

        let result = apply(
            &app.ctx,
            ApplyMcpArgs {
                scope: Scope::Global,
                project_id: String::new(),
                project_path: String::new(),
                batches: vec![McpBatch {
                    agent: AgentKind::Codex,
                    install: vec![install_req(stdio_token_def(), &[("token", "abc")])],
                    remove: vec![],
                }],
            },
        );
        assert!(result.ok, "codex apply failed: {:?}", result.error);
        assert_eq!(result.installed.as_ref().map(Vec::len), Some(1));

        // Native config is TOML under the (temp) home .codex dir.
        let toml = std::fs::read_to_string(app.home.join(".codex/config.toml"))
            .expect("codex config written");
        assert!(toml.contains("[mcp_servers.github_1]"));
        assert!(toml.contains("npx"));
        assert!(toml.contains("abc"));

        // No .gitignore is touched at GLOBAL scope, for any agent: there is
        // no project repository to write one into. Codex is not special here
        // any more -- the sibling tests in this file install it at project
        // scope and assert the .gitignore entry it does get there.
        let listed = installs(&app.ctx);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].agent, AgentKind::Codex);
        assert_eq!(listed[0].project_id, "global");
        assert_eq!(listed[0].instance_name, "github_1");
    }

    #[test]
    fn apply_skips_an_install_whose_transport_the_agent_cannot_express() {
        let app = CodexApp::new();

        // Codex accepts stdio and http; sse is the one transport it still
        // cannot express, so an sse def is skipped, not installed.
        let result = apply(
            &app.ctx,
            ApplyMcpArgs {
                scope: Scope::Global,
                project_id: String::new(),
                project_path: String::new(),
                batches: vec![McpBatch {
                    agent: AgentKind::Codex,
                    install: vec![install_req(sse_def(), &[])],
                    remove: vec![],
                }],
            },
        );
        assert!(result.ok);
        assert_eq!(result.installed.as_ref().map(Vec::len), Some(0));
        let skipped = result.skipped.expect("skipped list present");
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].agent, AgentKind::Codex);
        assert_eq!(skipped[0].source, "github");
        assert_eq!(skipped[0].transport, Some(McpTransport::Sse));
        assert_eq!(skipped[0].reason, McpSkipReason::Transport);
        assert!(installs(&app.ctx).is_empty());
    }
    #[test]
    fn apply_skips_copilot_for_an_oauth_preset_and_still_writes_claude() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        let result = apply(
            &app.ctx,
            apply_args(
                &proj,
                vec![
                    McpBatch {
                        agent: AgentKind::Copilot,
                        install: vec![install_req(oauth_http_def(), &[])],
                        remove: vec![],
                    },
                    McpBatch {
                        agent: AgentKind::Claude,
                        install: vec![install_req(oauth_http_def(), &[])],
                        remove: vec![],
                    },
                ],
            ),
        );
        assert!(result.ok, "apply failed: {:?}", result.error);

        let skipped = result.skipped.expect("skipped list present");
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].agent, AgentKind::Copilot);
        assert_eq!(skipped[0].source, "github");
        // Skipped over oauth, not the transport -- copilot takes http fine.
        assert_eq!(skipped[0].reason, McpSkipReason::Oauth);
        assert_eq!(skipped[0].transport, None);

        // Nothing was written for copilot: no server that looks installed and
        // cannot authenticate, and no ledger entry claiming one.
        assert!(!Path::new(&proj.path()).join(".vscode/mcp.json").exists());
        assert!(installs(&app.ctx)
            .iter()
            .all(|i| i.agent != AgentKind::Copilot));

        // Claude, which can express it, was written WITH the oauth block.
        let installed = result.installed.expect("installed list present");
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].agent, AgentKind::Claude);
        assert!(installed[0].notes.is_empty());
        let native = std::fs::read_to_string(Path::new(&proj.path()).join(".mcp.json"))
            .expect("native config written");
        assert!(native.contains("\"oauth\""), "no oauth block:\n{native}");
        assert!(native.contains("sk-client"));
        assert!(native.contains("8432"));
    }

    #[test]
    fn apply_carries_the_writer_notes_on_the_installed_target() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        let result = apply(
            &app.ctx,
            apply_args(
                &proj,
                vec![McpBatch {
                    agent: AgentKind::Cursor,
                    install: vec![install_req(oauth_http_def(), &[])],
                    remove: vec![],
                }],
            ),
        );
        assert!(result.ok, "apply failed: {:?}", result.error);

        // Cursor has no callback-port setting. The note rides out on the
        // per-target install record the renderer reads.
        let installed = result.installed.expect("installed list present");
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].agent, AgentKind::Cursor);
        assert_eq!(installed[0].instance_name, "github_1");
        assert_eq!(
            installed[0].notes,
            vec![UpsertNote::DroppedField {
                field: "callbackPort".to_string()
            }]
        );

        // The note is serialized for the renderer as a tagged union member.
        let json = serde_json::to_value(&installed[0]).expect("serializes");
        assert_eq!(
            json["notes"][0],
            serde_json::json!({ "kind": "droppedField", "field": "callbackPort" })
        );
    }
}
