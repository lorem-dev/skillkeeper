//! MCP preset discovery: the repository `mcp.yml`/`mcp.yaml` files and the
//! manual presets from config, plus the lookup the commands resolve a name
//! against.

use std::collections::BTreeMap;
use std::io::Write;

use skillkeeper_config::schema::McpOauth as ConfigOauth;
use skillkeeper_config::{McpPreset, McpTransport as ConfigTransport};
use skillkeeper_core::mcp::discovery::preset_group_dirs;
use skillkeeper_core::mcp::model::McpOauth;
use skillkeeper_core::mcp::{parse_mcp_config, McpIdentity, McpServerDef, McpTransport};
use skillkeeper_core::ports::FsPort;
use skillkeeper_core::skills::resolver::resolve_skills;
use skillkeeper_core::state::state::load_state;

use crate::commands::resolvewarnings::print_resolve_warnings;
use crate::error::CliError;

use super::hints::printable;
use super::{McpCtx, MCP_FILE_NAMES};

/// One MCP preset available for install: repo-discovered or manual.
pub(super) struct PresetEntry {
    pub(super) origin: &'static str,
    pub(super) def: McpServerDef,
    pub(super) remote: Option<String>,
    pub(super) group: Option<String>,
    pub(super) local_id: Option<String>,
}

/// Map a config manual-preset transport onto the core transport.
fn to_core_transport(t: ConfigTransport) -> McpTransport {
    match t {
        ConfigTransport::Stdio => McpTransport::Stdio,
        ConfigTransport::Http => McpTransport::Http,
        ConfigTransport::Sse => McpTransport::Sse,
    }
}

/// Map a config manual-preset oauth block onto the core one. The two structs
/// mirror each other field-for-field (see the comment on
/// `skillkeeper_config::McpOauth` for why they are mirrored rather than shared),
/// so this is a copy, not a reinterpretation.
fn to_core_oauth(o: &ConfigOauth) -> McpOauth {
    McpOauth {
        callback_port: o.callback_port,
        client_id: o.client_id.clone(),
        scopes: o.scopes.clone(),
    }
}

/// Convert a config manual [`McpPreset`] into a raw [`McpServerDef`] (dropping the
/// preset `id`, which becomes the ledger identity's `local`).
fn preset_to_def(preset: &McpPreset) -> McpServerDef {
    McpServerDef {
        name: preset.name.clone(),
        transport: to_core_transport(preset.r#type),
        url: preset.url.clone(),
        headers: preset.headers.clone(),
        command: preset.command.clone(),
        args: preset.args.clone(),
        env: preset.env.clone(),
        rules: preset.rules.clone(),
        // Carried through like every neighbour above: dropping it here would
        // silently install a manual preset without the auth it asked for, and
        // would keep the `supports_oauth` gate below from ever seeing one.
        oauth: preset.oauth.as_ref().map(to_core_oauth),
        description: preset.description.clone(),
        // Manual presets have no config-side equivalent yet.
        parameters: BTreeMap::new(),
    }
}

/// Read and parse the first mcp.yml/mcp.yaml found directly under `dir`
/// (preferring `mcp.yml`). Empty on absent/unparsable. Port of `readMcpDefs`.
fn read_mcp_defs(fs: &dyn FsPort, dir: &str, err: &mut dyn Write) -> Vec<McpServerDef> {
    for file_name in MCP_FILE_NAMES {
        let path = format!("{dir}/{file_name}");
        if !fs.exists(&path).unwrap_or(false) {
            continue;
        }
        let text = match fs.read_file(&path) {
            Ok(t) => t,
            // Present but unreadable (permissions, I/O, not valid UTF-8). This
            // used to return silently, making a skipped file look like an
            // absent one.
            Err(e) => {
                let _ = writeln!(err, "[mcp] Could not read \"{path}\": {e}");
                return Vec::new();
            }
        };
        return match parse_mcp_config(&text) {
            Ok(cfg) => {
                // A file that only parsed because of the YAML leniency still
                // says so: tolerated is not the same as correct, and the note
                // names the line to quote.
                for warning in &cfg.warnings {
                    let _ = writeln!(err, "[mcp] {path}: {warning}");
                }
                cfg.servers
            }
            Err(e) => {
                let _ = writeln!(err, "[mcp] Skipping invalid MCP config at \"{path}\": {e}");
                Vec::new()
            }
        };
    }
    Vec::new()
}

/// Every MCP preset available: repo-discovered (root + skill-group directories)
/// plus every manual preset from config. Port of `listPresets`.
pub(super) fn list_presets(ctx: &McpCtx, err: &mut dyn Write) -> Vec<PresetEntry> {
    let mut out = Vec::new();
    let state = match load_state(ctx.fs, ctx.state_path) {
        Ok(s) => s,
        Err(_) => return out,
    };

    for repo in &state.repositories {
        if !ctx.fs.exists(&repo.local_path).unwrap_or(false) {
            continue;
        }
        for def in read_mcp_defs(ctx.fs, &repo.local_path, err) {
            out.push(PresetEntry {
                origin: "repo",
                def,
                remote: Some(repo.url.clone()),
                group: None,
                local_id: None,
            });
        }
        // Group candidates: every ancestor directory of each resolved skill, so
        // `a/b` counts even when the only skill is at `a/b/c/deep` and that
        // directory holds no skill of its own.
        // A skill that fails to resolve cannot contribute its directory as a
        // group, so an unresolved path can also hide a group's `mcp.yml` --
        // worth reporting here, not only from the skill commands.
        let resolved = resolve_skills(ctx.fs, &repo.local_path);
        let _ = print_resolve_warnings(err, &repo.name, &resolved.warnings);
        for group in preset_group_dirs(&resolved.skills) {
            let dir = format!("{}/{}", repo.local_path, group);
            for def in read_mcp_defs(ctx.fs, &dir, err) {
                out.push(PresetEntry {
                    origin: "repo",
                    def,
                    remote: Some(repo.url.clone()),
                    group: Some(group.clone()),
                    local_id: None,
                });
            }
        }
    }

    for preset in ctx.manual_presets {
        out.push(PresetEntry {
            origin: "manual",
            def: preset_to_def(preset),
            remote: None,
            group: None,
            local_id: Some(preset.id.clone()),
        });
    }

    out
}

/// Display/match label for a preset: `group/name` when grouped, else `name`.
pub(super) fn preset_label(p: &PresetEntry) -> String {
    match &p.group {
        Some(group) => format!("{group}/{}", p.def.name),
        None => p.def.name.clone(),
    }
}

/// The `.skmcp.yml` ledger identity for a preset entry.
pub(super) fn preset_identity(p: &PresetEntry) -> McpIdentity {
    McpIdentity {
        remote: p.remote.clone(),
        group: p.group.clone(),
        local: p.local_id.clone(),
        source: p.def.name.clone(),
    }
}

/// Resolve one preset by exact `def.name` or its `group/name` label. Errors when
/// none or more than one match. Port of `findPreset`.
pub(super) fn find_preset(presets: Vec<PresetEntry>, name: &str) -> Result<PresetEntry, CliError> {
    let mut matches: Vec<PresetEntry> = presets
        .into_iter()
        .filter(|p| p.def.name == name || preset_label(p) == name)
        .collect();
    if matches.is_empty() {
        return Err(CliError(format!("MCP preset not found: {name}")));
    }
    if matches.len() > 1 {
        let labels: Vec<String> = matches
            .iter()
            .map(|p| format!("{} ({})", printable(&preset_label(p)), p.origin))
            .collect();
        return Err(CliError(format!(
            "Ambiguous MCP preset name \"{name}\"; candidates: {}",
            labels.join(", ")
        )));
    }
    Ok(matches.remove(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mcp::install::install;
    use crate::commands::mcp::testutil::{manual_oauth_preset, seed_state, TestApp, PROJECT};
    use skillkeeper_core::testing::MemFs;

    #[test]
    fn preset_to_def_carries_the_manual_presets_description() {
        let mut preset = manual_oauth_preset();
        preset.description = Some("A [doc](https://mcp.example.com/d)".to_string());
        let def = preset_to_def(&preset);
        assert_eq!(
            def.description.as_deref(),
            Some("A [doc](https://mcp.example.com/d)")
        );
        assert!(def.parameters.is_empty());
    }

    #[test]
    fn a_manual_presets_oauth_block_survives_the_conversion_to_a_def() {
        let mut app = TestApp::new(MemFs::new());
        app.manual = vec![manual_oauth_preset()];
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "manual-remote",
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

        // Claude got the whole block, values intact.
        let native = app.fs.read_file("/proj/.mcp.json").unwrap();
        assert!(
            native.contains("\"oauth\""),
            "the manual preset lost its oauth block:\n{native}"
        );
        assert!(native.contains("sk-client"));
        assert!(native.contains("8432"));
        assert!(native.contains("repo"));

        // And the gate can SEE it, which it cannot when the field is dropped
        // during the conversion.
        assert!(
            out.contains("Skipped copilot: cannot express an oauth client."),
            "the oauth gate never saw the manual preset:\n{out}"
        );
    }
}
