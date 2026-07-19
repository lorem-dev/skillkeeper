//! Install and remove composed MCP server instances (Rust port of
//! `packages/core/src/mcp/install.ts`).
//!
//! Renders parameters, writes the native agent config, upserts/removes guidance,
//! and keeps both ledger files (`.skmcp.yml`, `.skmcp.params.yml`) in sync. The
//! ownership model: SkillKeeper only ever touches the exact instance names it
//! records in its ledger, so user-authored MCP servers in the same native config
//! are never clobbered.
//!
//! The core stays pure: callers pass already-resolved absolute paths (native
//! config, ledger, params, guidance files). The `fs` port is the only side
//! effect.

use std::collections::BTreeMap;

use thiserror::Error;

use crate::hooks::guidance::{
    guidance_key, remove_guidance_block, strip_guidance_markers, upsert_guidance_block,
};
use crate::mcp::gitignore_ensure::ensure_gitignore;
use crate::mcp::hashing::hash_mcp_def;
use crate::mcp::model::McpServerDef;
use crate::mcp::naming::allocate_instance_name;
use crate::mcp::params::{render_params, MissingValuesError};
use crate::mcp::skmcp::{
    parse_skmcp, parse_skmcp_params, serialize_skmcp, serialize_skmcp_params, SkmcpEntry,
    SkmcpFile, SKMCP_SCHEMA,
};
use crate::mcp::writers::{writer_for, WriterError};
use crate::models::AgentKind;
use crate::ports::{FsPort, PortError};

/// Anything that can go wrong installing or removing an MCP instance.
#[derive(Debug, Error)]
pub enum McpInstallError {
    #[error(transparent)]
    Port(#[from] PortError),
    #[error(transparent)]
    Params(#[from] MissingValuesError),
    #[error(transparent)]
    Writer(#[from] WriterError),
}

/// Identity of an MCP install source, matching a `.skmcp.yml` entry.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/",
        optional_fields
    )
)]
pub struct McpIdentity {
    /// Source repository remote URL (absent for manual presets).
    pub remote: Option<String>,
    /// Skill-group directory the preset lives in (absent at the repo root).
    pub group: Option<String>,
    /// Manual preset id (present only for manual presets).
    pub local: Option<String>,
    /// Server name as it appears in `mcp.yml`/the preset.
    pub source: String,
}

/// Arguments for [`install_mcp_instance`].
#[derive(Debug, Clone)]
pub struct InstallMcpArgs {
    /// Selects the native writer via `writer_for(agent)`.
    pub agent: AgentKind,
    /// Native agent MCP config file.
    pub native_path: String,
    /// `.skmcp.yml` path.
    pub ledger_path: String,
    /// `.skmcp.params.yml` path.
    pub params_path: String,
    /// Absolute guidance files to receive the rendered `rules` block, if any.
    pub guidance_files: Vec<String>,
    pub identity: McpIdentity,
    /// The raw server def (placeholders intact).
    pub def: McpServerDef,
    /// Parameter values to render into `def`.
    pub values: BTreeMap<String, String>,
    /// When set, this exact instance name is used verbatim (the allocator is
    /// skipped), even if it collides with a name already in the native config.
    /// Used by update to reinstall under the SAME name. When absent, a fresh name
    /// is allocated.
    pub instance_name: Option<String>,
    /// When set (project scope), `ensure_gitignore` is run against this path.
    pub gitignore_project_path: Option<String>,
}

/// Arguments for [`remove_mcp_instance`].
#[derive(Debug, Clone)]
pub struct RemoveMcpArgs {
    pub agent: AgentKind,
    pub native_path: String,
    pub ledger_path: String,
    pub params_path: String,
    pub guidance_files: Vec<String>,
    pub instance_name: String,
}

/// The `.skmcp.yml` guidance identity: `remote`, or `local:<id>` for manual
/// presets.
fn guidance_identity(remote: Option<&str>, local: Option<&str>) -> String {
    match remote {
        Some(remote) => remote.to_string(),
        None => format!("local:{}", local.unwrap_or("undefined")),
    }
}

fn read_or_empty(fs: &dyn FsPort, path: &str) -> Result<String, PortError> {
    if fs.exists(path)? {
        fs.read_file(path)
    } else {
        Ok(String::new())
    }
}

/// Install one MCP server instance: render its parameters, write the native
/// config, upsert guidance (when the def carries `rules`), and record the install
/// in both ledger files. Returns the assigned instance name.
pub fn install_mcp_instance(
    fs: &dyn FsPort,
    args: &InstallMcpArgs,
) -> Result<String, McpInstallError> {
    let rendered = render_params(&args.def, &args.values)?;

    let native_text = read_or_empty(fs, &args.native_path)?;
    let writer = writer_for(args.agent);

    let instance_name = match &args.instance_name {
        Some(name) => name.clone(),
        None => {
            allocate_instance_name(&args.identity.source, &writer.existing_names(&native_text)?)
        }
    };

    fs.write_file(
        &args.native_path,
        &writer.upsert(&native_text, &instance_name, &rendered)?,
    )?;

    if args.def.rules.is_some() {
        let key = guidance_key(
            &guidance_identity(
                args.identity.remote.as_deref(),
                args.identity.local.as_deref(),
            ),
            &instance_name,
        );
        let body = strip_guidance_markers(rendered.rules.as_deref().unwrap_or(""));
        for guidance_file in &args.guidance_files {
            let file_text = read_or_empty(fs, guidance_file)?;
            fs.write_file(
                guidance_file,
                &upsert_guidance_block(&file_text, &key, &body),
            )?;
        }
    }

    let ledger_text = read_or_empty(fs, &args.ledger_path)?;
    let ledger = parse_skmcp(&ledger_text).unwrap_or(SkmcpFile {
        schema: SKMCP_SCHEMA,
        servers: Vec::new(),
    });
    let entry = SkmcpEntry {
        remote: args.identity.remote.clone(),
        group: args.identity.group.clone(),
        local: args.identity.local.clone(),
        source: args.identity.source.clone(),
        name: instance_name.clone(),
        hash: hash_mcp_def(&args.def),
    };
    let mut servers = ledger.servers;
    servers.push(entry);
    fs.write_file(
        &args.ledger_path,
        &serialize_skmcp(&SkmcpFile {
            schema: ledger.schema,
            servers,
        }),
    )?;

    let params_text = read_or_empty(fs, &args.params_path)?;
    let mut params_map = parse_skmcp_params(&params_text);
    params_map.insert(instance_name.clone(), args.values.clone());
    fs.write_file(&args.params_path, &serialize_skmcp_params(&params_map))?;

    if let Some(gitignore_path) = &args.gitignore_project_path {
        ensure_gitignore(fs, gitignore_path)?;
    }

    Ok(instance_name)
}

/// Remove one MCP server instance by name: the reverse of
/// [`install_mcp_instance`]. No-op safe on each side that has already been
/// dropped (missing native server, missing guidance block, missing ledger
/// entry).
pub fn remove_mcp_instance(fs: &dyn FsPort, args: &RemoveMcpArgs) -> Result<(), McpInstallError> {
    let ledger_text = read_or_empty(fs, &args.ledger_path)?;
    let ledger = parse_skmcp(&ledger_text).unwrap_or(SkmcpFile {
        schema: SKMCP_SCHEMA,
        servers: Vec::new(),
    });
    let entry = ledger
        .servers
        .iter()
        .find(|s| s.name == args.instance_name)
        .cloned();

    let native_text = read_or_empty(fs, &args.native_path)?;
    let writer = writer_for(args.agent);
    fs.write_file(
        &args.native_path,
        &writer.remove(&native_text, &args.instance_name)?,
    )?;

    if let Some(entry) = &entry {
        let key = guidance_key(
            &guidance_identity(entry.remote.as_deref(), entry.local.as_deref()),
            &args.instance_name,
        );
        for guidance_file in &args.guidance_files {
            let file_text = read_or_empty(fs, guidance_file)?;
            fs.write_file(guidance_file, &remove_guidance_block(&file_text, &key))?;
        }
    }

    let next_servers: Vec<SkmcpEntry> = ledger
        .servers
        .into_iter()
        .filter(|s| s.name != args.instance_name)
        .collect();
    fs.write_file(
        &args.ledger_path,
        &serialize_skmcp(&SkmcpFile {
            schema: ledger.schema,
            servers: next_servers,
        }),
    )?;

    let params_text = read_or_empty(fs, &args.params_path)?;
    let mut params_map = parse_skmcp_params(&params_text);
    params_map.remove(&args.instance_name);
    fs.write_file(&args.params_path, &serialize_skmcp_params(&params_map))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::model::McpTransport;
    use crate::testing::MemFs;

    const NATIVE_PATH: &str = "/proj/.mcp.json";
    const LEDGER_PATH: &str = "/proj/.claude/skills/.skmcp.yml";
    const PARAMS_PATH: &str = "/proj/.claude/skills/.skmcp.params.yml";

    fn values() -> BTreeMap<String, String> {
        let mut m = BTreeMap::new();
        m.insert("token".to_string(), "secret123".to_string());
        m
    }

    fn stdio_def() -> McpServerDef {
        let mut env = BTreeMap::new();
        env.insert("TOKEN".to_string(), "{token}".to_string());
        McpServerDef {
            name: "GitHub MCP".to_string(),
            transport: McpTransport::Stdio,
            url: None,
            headers: None,
            command: Some("npx".to_string()),
            args: Some(vec![
                "-y".to_string(),
                "@modelcontextprotocol/server-github".to_string(),
            ]),
            env: Some(env),
            rules: None,
        }
    }

    fn rules_def() -> McpServerDef {
        McpServerDef {
            rules: Some(
                "Use the {token} carefully.\n<!-- SKILLKEEPER_START: bogus -->\nstill here"
                    .to_string(),
            ),
            ..stdio_def()
        }
    }

    fn base_args() -> InstallMcpArgs {
        InstallMcpArgs {
            agent: AgentKind::Claude,
            native_path: NATIVE_PATH.to_string(),
            ledger_path: LEDGER_PATH.to_string(),
            params_path: PARAMS_PATH.to_string(),
            guidance_files: Vec::new(),
            identity: McpIdentity {
                remote: Some("git@github.com:acme/mcps.git".to_string()),
                group: None,
                local: None,
                source: "github".to_string(),
            },
            def: stdio_def(),
            values: values(),
            instance_name: None,
            gitignore_project_path: None,
        }
    }

    #[test]
    fn writes_native_ledger_with_raw_hash_and_params() {
        let fs = MemFs::new();
        let instance_name = install_mcp_instance(&fs, &base_args()).unwrap();
        assert_eq!(instance_name, "github_1");

        let native_text = fs.read_file(NATIVE_PATH).unwrap();
        assert!(!native_text.contains("{token}"));
        assert!(native_text.contains("secret123"));
        assert!(native_text.contains("github_1"));

        let ledger = parse_skmcp(&fs.read_file(LEDGER_PATH).unwrap()).unwrap();
        assert_eq!(ledger.servers.len(), 1);
        let entry = &ledger.servers[0];
        assert_eq!(
            entry.remote.as_deref(),
            Some("git@github.com:acme/mcps.git")
        );
        assert_eq!(entry.source, "github");
        assert_eq!(entry.name, "github_1");
        assert_eq!(entry.hash, hash_mcp_def(&stdio_def()));

        let params = parse_skmcp_params(&fs.read_file(PARAMS_PATH).unwrap());
        assert_eq!(params.get("github_1"), Some(&values()));
    }

    #[test]
    fn upserts_rendered_marker_stripped_guidance_into_each_file() {
        let fs = MemFs::new();
        let guidance_files = vec!["/proj/CLAUDE.md".to_string(), "/proj/AGENTS.md".to_string()];
        let mut args = base_args();
        args.def = rules_def();
        args.guidance_files = guidance_files.clone();
        let instance_name = install_mcp_instance(&fs, &args).unwrap();

        let key = guidance_key("git@github.com:acme/mcps.git", &instance_name);
        for file in &guidance_files {
            let text = fs.read_file(file).unwrap();
            assert!(text.contains(&format!("SKILLKEEPER_START: {key}")));
            assert!(text.contains("Use the secret123 carefully."));
            assert!(!text.contains("SKILLKEEPER_START: bogus"));
        }
    }

    #[test]
    fn does_not_touch_guidance_files_when_no_rules() {
        let fs = MemFs::new();
        let mut args = base_args();
        args.guidance_files = vec!["/proj/CLAUDE.md".to_string()];
        install_mcp_instance(&fs, &args).unwrap();
        assert!(!fs.exists("/proj/CLAUDE.md").unwrap());
    }

    #[test]
    fn allocates_the_next_free_instance_name_on_a_second_install() {
        let fs = MemFs::new();
        let first = install_mcp_instance(&fs, &base_args()).unwrap();
        let second = install_mcp_instance(&fs, &base_args()).unwrap();
        assert_eq!(first, "github_1");
        assert_eq!(second, "github_2");

        let ledger = parse_skmcp(&fs.read_file(LEDGER_PATH).unwrap()).unwrap();
        let names: Vec<&str> = ledger.servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["github_1", "github_2"]);
    }

    #[test]
    fn uses_a_forced_instance_name_verbatim_even_on_collision() {
        let fs = MemFs::new();
        let first = install_mcp_instance(&fs, &base_args()).unwrap();
        assert_eq!(first, "github_1");

        let mut args = base_args();
        args.instance_name = Some("github_1".to_string());
        let forced = install_mcp_instance(&fs, &args).unwrap();
        assert_eq!(forced, "github_1");

        let ledger = parse_skmcp(&fs.read_file(LEDGER_PATH).unwrap()).unwrap();
        let last = ledger.servers.last().unwrap();
        assert_eq!(last.name, "github_1");
        assert_eq!(last.hash, hash_mcp_def(&stdio_def()));
    }

    #[test]
    fn ensures_the_project_gitignore_when_path_set() {
        let fs = MemFs::new();
        let mut args = base_args();
        args.gitignore_project_path = Some("/proj".to_string());
        install_mcp_instance(&fs, &args).unwrap();

        let gitignore = fs.read_file("/proj/.gitignore").unwrap();
        assert!(gitignore.contains(".skmcp.params.yml"));
        assert!(gitignore.contains(".skmcp.params.yaml"));
    }

    #[test]
    fn does_not_touch_gitignore_when_path_absent() {
        let fs = MemFs::new();
        install_mcp_instance(&fs, &base_args()).unwrap();
        assert!(!fs.exists("/proj/.gitignore").unwrap());
    }

    #[test]
    fn uses_a_local_identity_for_manual_presets() {
        let fs = MemFs::new();
        let guidance_files = vec!["/proj/CLAUDE.md".to_string()];
        let mut args = base_args();
        args.identity = McpIdentity {
            remote: None,
            group: None,
            local: Some("abc123".to_string()),
            source: "local-tool".to_string(),
        };
        args.def = McpServerDef {
            name: "local-tool".to_string(),
            ..rules_def()
        };
        args.guidance_files = guidance_files.clone();
        let instance_name = install_mcp_instance(&fs, &args).unwrap();

        let ledger = parse_skmcp(&fs.read_file(LEDGER_PATH).unwrap()).unwrap();
        assert_eq!(ledger.servers[0].local.as_deref(), Some("abc123"));
        assert_eq!(ledger.servers[0].remote, None);

        let key = guidance_key("local:abc123", &instance_name);
        let text = fs.read_file(&guidance_files[0]).unwrap();
        assert!(text.contains(&format!("SKILLKEEPER_START: {key}")));
    }

    fn remove_args(instance_name: &str, guidance_files: Vec<String>) -> RemoveMcpArgs {
        RemoveMcpArgs {
            agent: AgentKind::Claude,
            native_path: NATIVE_PATH.to_string(),
            ledger_path: LEDGER_PATH.to_string(),
            params_path: PARAMS_PATH.to_string(),
            guidance_files,
            instance_name: instance_name.to_string(),
        }
    }

    #[test]
    fn remove_deletes_native_guidance_ledger_and_params() {
        let fs = MemFs::new();
        let guidance_files = vec!["/proj/CLAUDE.md".to_string()];
        let mut args = base_args();
        args.def = rules_def();
        args.guidance_files = guidance_files.clone();
        let instance_name = install_mcp_instance(&fs, &args).unwrap();

        remove_mcp_instance(&fs, &remove_args(&instance_name, guidance_files.clone())).unwrap();

        let native_text = fs.read_file(NATIVE_PATH).unwrap();
        assert!(!native_text.contains(&instance_name));

        let guidance_text = fs.read_file(&guidance_files[0]).unwrap();
        assert!(!guidance_text.contains("SKILLKEEPER_START"));

        let ledger = parse_skmcp(&fs.read_file(LEDGER_PATH).unwrap()).unwrap();
        assert_eq!(ledger.servers.len(), 0);

        let params = parse_skmcp_params(&fs.read_file(PARAMS_PATH).unwrap());
        assert!(!params.contains_key(&instance_name));
    }

    #[test]
    fn remove_is_a_no_op_when_the_instance_is_already_gone() {
        let fs = MemFs::new();
        remove_mcp_instance(
            &fs,
            &remove_args("ghost_1", vec!["/proj/CLAUDE.md".to_string()]),
        )
        .unwrap();

        assert!(!fs.exists("/proj/CLAUDE.md").unwrap());
        let ledger = parse_skmcp(&fs.read_file(LEDGER_PATH).unwrap()).unwrap();
        assert_eq!(ledger.servers.len(), 0);
    }

    #[test]
    fn remove_targets_only_the_named_instance() {
        let fs = MemFs::new();
        let first = install_mcp_instance(&fs, &base_args()).unwrap();
        let second = install_mcp_instance(&fs, &base_args()).unwrap();

        remove_mcp_instance(&fs, &remove_args(&first, Vec::new())).unwrap();

        let native_text = fs.read_file(NATIVE_PATH).unwrap();
        assert!(!native_text.contains(&first));
        assert!(native_text.contains(&second));

        let ledger = parse_skmcp(&fs.read_file(LEDGER_PATH).unwrap()).unwrap();
        let names: Vec<&str> = ledger.servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec![second.as_str()]);
    }
}
