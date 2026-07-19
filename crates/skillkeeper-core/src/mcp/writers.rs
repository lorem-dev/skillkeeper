//! Native MCP config writers (Rust port of `packages/core/src/mcp/writers/`).
//!
//! Each supported agent stores its MCP servers in a different native config
//! format. A [`McpConfigWriter`] is a pure text transform: the caller reads the
//! destination file (or passes `""` when absent), calls the writer, and writes
//! the result back. JSON agents (claude/cursor/copilot/opencode) share one
//! parse/merge/serialize skeleton; codex uses TOML.
//!
//! Unrelated top-level keys and unrelated container entries are preserved. JSON
//! output is deterministic (keys sorted recursively, two-space indent) because
//! `serde_json`'s default object map is sorted; TOML output is likewise
//! deterministic.
//!
//! LIMITATION (codex): the TOML writer round-trips through `toml`'s
//! parse/serialize. Table structure and values survive but the user's original
//! comments and formatting do not -- an accepted v1 tradeoff (see the design
//! doc), matching the TypeScript writer.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use thiserror::Error;

use crate::mcp::model::{McpServerDef, McpTransport};
use crate::models::{AgentKind, Scope};

/// Raised by a writer when handed a malformed server definition or a native
/// config whose root is not the expected shape.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{0}")]
pub struct WriterError(pub String);

/// Translates a rendered [`McpServerDef`] into one agent's native MCP config
/// text. All operations are pure text transforms (no I/O).
pub trait McpConfigWriter {
    /// Add server `name`, or replace it if already present.
    fn upsert(&self, text: &str, name: &str, def: &McpServerDef) -> Result<String, WriterError>;
    /// Drop server `name`. No-op (returns `text` unchanged) if absent.
    fn remove(&self, text: &str, name: &str) -> Result<String, WriterError>;
    /// All server names currently present, owned or not.
    fn existing_names(&self, text: &str) -> Result<Vec<String>, WriterError>;
}

fn transport_str(t: McpTransport) -> &'static str {
    match t {
        McpTransport::Stdio => "stdio",
        McpTransport::Http => "http",
        McpTransport::Sse => "sse",
    }
}

fn str_map_to_json(map: &BTreeMap<String, String>) -> Value {
    Value::Object(
        map.iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect(),
    )
}

/// The claude/cursor/copilot server shape: a `type`-tagged object.
fn to_standard_server_json(def: &McpServerDef) -> Result<Value, WriterError> {
    if def.transport == McpTransport::Stdio {
        let command = def
            .command
            .as_ref()
            .ok_or_else(|| WriterError("stdio server definition requires \"command\"".into()))?;
        let mut obj = Map::new();
        obj.insert("type".into(), Value::String("stdio".into()));
        obj.insert("command".into(), Value::String(command.clone()));
        if let Some(args) = &def.args {
            obj.insert(
                "args".into(),
                Value::Array(args.iter().map(|a| Value::String(a.clone())).collect()),
            );
        }
        if let Some(env) = &def.env {
            obj.insert("env".into(), str_map_to_json(env));
        }
        return Ok(Value::Object(obj));
    }
    let url = def.url.as_ref().ok_or_else(|| {
        WriterError(format!(
            "{} server definition requires \"url\"",
            transport_str(def.transport)
        ))
    })?;
    let mut obj = Map::new();
    obj.insert(
        "type".into(),
        Value::String(transport_str(def.transport).into()),
    );
    obj.insert("url".into(), Value::String(url.clone()));
    if let Some(headers) = &def.headers {
        obj.insert("headers".into(), str_map_to_json(headers));
    }
    Ok(Value::Object(obj))
}

/// The opencode server shape: `local` (stdio) with `command` as an array and
/// `env` renamed `environment`, or `remote` (http and sse both map to `remote`).
fn to_opencode_server_json(def: &McpServerDef) -> Result<Value, WriterError> {
    if def.transport == McpTransport::Stdio {
        let command = def
            .command
            .as_ref()
            .ok_or_else(|| WriterError("stdio server definition requires \"command\"".into()))?;
        let mut command_arr = vec![Value::String(command.clone())];
        if let Some(args) = &def.args {
            command_arr.extend(args.iter().map(|a| Value::String(a.clone())));
        }
        let mut obj = Map::new();
        obj.insert("type".into(), Value::String("local".into()));
        obj.insert("command".into(), Value::Array(command_arr));
        obj.insert("enabled".into(), Value::Bool(true));
        if let Some(env) = &def.env {
            obj.insert("environment".into(), str_map_to_json(env));
        }
        return Ok(Value::Object(obj));
    }
    let url = def.url.as_ref().ok_or_else(|| {
        WriterError(format!(
            "{} server definition requires \"url\"",
            transport_str(def.transport)
        ))
    })?;
    let mut obj = Map::new();
    obj.insert("type".into(), Value::String("remote".into()));
    obj.insert("url".into(), Value::String(url.clone()));
    obj.insert("enabled".into(), Value::Bool(true));
    if let Some(headers) = &def.headers {
        obj.insert("headers".into(), str_map_to_json(headers));
    }
    Ok(Value::Object(obj))
}

type ShapeFn = fn(&McpServerDef) -> Result<Value, WriterError>;

/// A JSON writer keyed on `container_key` (`mcpServers`, `servers`, `mcp`),
/// mapping each server def through `to_server`.
struct JsonWriter {
    container_key: &'static str,
    to_server: ShapeFn,
}

fn parse_json_root(text: &str) -> Result<Map<String, Value>, WriterError> {
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    let parsed: Value =
        serde_json::from_str(text).map_err(|e| WriterError(format!("invalid JSON: {e}")))?;
    match parsed {
        Value::Object(map) => Ok(map),
        _ => Err(WriterError("JSON root must be an object".into())),
    }
}

fn serialize_json(root: Map<String, Value>) -> String {
    serde_json::to_string_pretty(&Value::Object(root)).expect("serialize json")
}

impl McpConfigWriter for JsonWriter {
    fn upsert(&self, text: &str, name: &str, def: &McpServerDef) -> Result<String, WriterError> {
        let mut root = parse_json_root(text)?;
        let mut container = match root.get(self.container_key) {
            Some(Value::Object(existing)) => existing.clone(),
            _ => Map::new(),
        };
        container.insert(name.to_string(), (self.to_server)(def)?);
        root.insert(self.container_key.to_string(), Value::Object(container));
        Ok(serialize_json(root))
    }

    fn remove(&self, text: &str, name: &str) -> Result<String, WriterError> {
        if text.trim().is_empty() {
            return Ok(text.to_string());
        }
        let mut root = parse_json_root(text)?;
        let Some(Value::Object(existing)) = root.get(self.container_key) else {
            return Ok(text.to_string());
        };
        if !existing.contains_key(name) {
            return Ok(text.to_string());
        }
        let mut container = existing.clone();
        container.remove(name);
        root.insert(self.container_key.to_string(), Value::Object(container));
        Ok(serialize_json(root))
    }

    fn existing_names(&self, text: &str) -> Result<Vec<String>, WriterError> {
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        let root = parse_json_root(text)?;
        match root.get(self.container_key) {
            Some(Value::Object(existing)) => Ok(existing.keys().cloned().collect()),
            _ => Ok(Vec::new()),
        }
    }
}

const CODEX_CONTAINER_KEY: &str = "mcp_servers";

/// The codex native MCP config writer: `~/.codex/config.toml`, TOML table
/// `[mcp_servers.<name>]`. Codex only supports the `stdio` transport;
/// [`Self::upsert`] rejects a non-stdio def as a defensive check.
struct CodexTomlWriter;

fn parse_toml_root(text: &str) -> Result<toml::Table, WriterError> {
    if text.trim().is_empty() {
        return Ok(toml::Table::new());
    }
    toml::from_str::<toml::Table>(text).map_err(|e| WriterError(format!("invalid TOML: {e}")))
}

fn to_codex_server_object(def: &McpServerDef) -> Result<toml::Value, WriterError> {
    if def.transport != McpTransport::Stdio {
        return Err(WriterError(format!(
            "codex only supports the stdio transport, got \"{}\"",
            transport_str(def.transport)
        )));
    }
    let command = def
        .command
        .as_ref()
        .ok_or_else(|| WriterError("stdio server definition requires \"command\"".into()))?;
    let mut obj = toml::Table::new();
    obj.insert("command".into(), toml::Value::String(command.clone()));
    if let Some(args) = &def.args {
        obj.insert(
            "args".into(),
            toml::Value::Array(
                args.iter()
                    .map(|a| toml::Value::String(a.clone()))
                    .collect(),
            ),
        );
    }
    if let Some(env) = &def.env {
        let table: toml::Table = env
            .iter()
            .map(|(k, v)| (k.clone(), toml::Value::String(v.clone())))
            .collect();
        obj.insert("env".into(), toml::Value::Table(table));
    }
    Ok(toml::Value::Table(obj))
}

impl McpConfigWriter for CodexTomlWriter {
    fn upsert(&self, text: &str, name: &str, def: &McpServerDef) -> Result<String, WriterError> {
        let mut root = parse_toml_root(text)?;
        let mut container = match root.get(CODEX_CONTAINER_KEY) {
            Some(toml::Value::Table(existing)) => existing.clone(),
            _ => toml::Table::new(),
        };
        container.insert(name.to_string(), to_codex_server_object(def)?);
        root.insert(
            CODEX_CONTAINER_KEY.to_string(),
            toml::Value::Table(container),
        );
        toml::to_string(&toml::Value::Table(root)).map_err(|e| WriterError(e.to_string()))
    }

    fn remove(&self, text: &str, name: &str) -> Result<String, WriterError> {
        if text.trim().is_empty() {
            return Ok(text.to_string());
        }
        let mut root = parse_toml_root(text)?;
        let Some(toml::Value::Table(existing)) = root.get(CODEX_CONTAINER_KEY) else {
            return Ok(text.to_string());
        };
        if !existing.contains_key(name) {
            return Ok(text.to_string());
        }
        let mut container = existing.clone();
        container.remove(name);
        root.insert(
            CODEX_CONTAINER_KEY.to_string(),
            toml::Value::Table(container),
        );
        toml::to_string(&toml::Value::Table(root)).map_err(|e| WriterError(e.to_string()))
    }

    fn existing_names(&self, text: &str) -> Result<Vec<String>, WriterError> {
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        let root = parse_toml_root(text)?;
        match root.get(CODEX_CONTAINER_KEY) {
            Some(toml::Value::Table(existing)) => Ok(existing.keys().cloned().collect()),
            _ => Ok(Vec::new()),
        }
    }
}

/// The [`McpConfigWriter`] for `agent`'s native MCP config format.
pub fn writer_for(agent: AgentKind) -> Box<dyn McpConfigWriter> {
    match agent {
        AgentKind::Claude => Box::new(JsonWriter {
            container_key: "mcpServers",
            to_server: to_standard_server_json,
        }),
        AgentKind::Cursor => Box::new(JsonWriter {
            container_key: "mcpServers",
            to_server: to_standard_server_json,
        }),
        AgentKind::Copilot => Box::new(JsonWriter {
            container_key: "servers",
            to_server: to_standard_server_json,
        }),
        AgentKind::Opencode => Box::new(JsonWriter {
            container_key: "mcp",
            to_server: to_opencode_server_json,
        }),
        AgentKind::Codex => Box::new(CodexTomlWriter),
    }
}

/// Whether `agent`'s native config can express transport `t`. Codex is
/// stdio-only.
pub fn supports_transport(agent: AgentKind, t: McpTransport) -> bool {
    if agent == AgentKind::Codex {
        return t == McpTransport::Stdio;
    }
    true
}

/// Inputs needed to resolve an agent's native MCP config destination.
#[derive(Debug, Clone, Default)]
pub struct McpDestinationTarget {
    /// Project root; required for every agent except codex (global).
    pub project_path: Option<String>,
    /// User home directory; required for codex only.
    pub home_dir: Option<String>,
}

/// Resolved native MCP config file location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpDestination {
    pub path: String,
    pub scope: Scope,
}

/// Resolve where `agent` keeps its native MCP config. Project-scoped agents
/// resolve under `target.project_path`; codex is global, under
/// `target.home_dir`. Returns an error when the required target field is absent.
pub fn mcp_destination(
    agent: AgentKind,
    target: &McpDestinationTarget,
) -> Result<McpDestination, String> {
    if agent == AgentKind::Codex {
        let home = target
            .home_dir
            .as_ref()
            .ok_or_else(|| "codex destination requires \"homeDir\"".to_string())?;
        return Ok(McpDestination {
            path: format!("{home}/.codex/config.toml"),
            scope: Scope::Global,
        });
    }
    let project = target
        .project_path
        .as_ref()
        .ok_or_else(|| format!("{agent:?} destination requires \"projectPath\""))?;
    let path = match agent {
        AgentKind::Claude => format!("{project}/.mcp.json"),
        AgentKind::Cursor => format!("{project}/.cursor/mcp.json"),
        AgentKind::Copilot => format!("{project}/.vscode/mcp.json"),
        AgentKind::Opencode => format!("{project}/opencode.json"),
        AgentKind::Codex => unreachable!("codex handled above"),
    };
    Ok(McpDestination {
        path,
        scope: Scope::Project,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio_def() -> McpServerDef {
        let mut env = BTreeMap::new();
        env.insert("GITHUB_TOKEN".to_string(), "secret".to_string());
        McpServerDef {
            name: "github".to_string(),
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

    fn stdio_def_no_args_env() -> McpServerDef {
        McpServerDef {
            name: "bare".to_string(),
            transport: McpTransport::Stdio,
            url: None,
            headers: None,
            command: Some("my-server".to_string()),
            args: None,
            env: None,
            rules: None,
        }
    }

    fn http_def() -> McpServerDef {
        let mut headers = BTreeMap::new();
        headers.insert("Authorization".to_string(), "Bearer x".to_string());
        McpServerDef {
            name: "remote-http".to_string(),
            transport: McpTransport::Http,
            url: Some("https://example.com/mcp".to_string()),
            headers: Some(headers),
            command: None,
            args: None,
            env: None,
            rules: None,
        }
    }

    fn sse_def() -> McpServerDef {
        McpServerDef {
            name: "remote-sse".to_string(),
            transport: McpTransport::Sse,
            url: Some("https://example.com/sse".to_string()),
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: None,
        }
    }

    fn parse(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    const JSON_AGENTS: [(AgentKind, &str); 3] = [
        (AgentKind::Claude, "mcpServers"),
        (AgentKind::Cursor, "mcpServers"),
        (AgentKind::Copilot, "servers"),
    ];

    #[test]
    fn json_upserts_a_stdio_server_into_empty_text() {
        for (agent, container_key) in JSON_AGENTS {
            let writer = writer_for(agent);
            let text = writer.upsert("", "github_1", &stdio_def()).unwrap();
            let parsed = parse(&text);
            let server = &parsed[container_key]["github_1"];
            assert_eq!(server["type"], "stdio");
            assert_eq!(server["command"], "npx");
            assert_eq!(server["args"][0], "-y");
            assert_eq!(server["env"]["GITHUB_TOKEN"], "secret");
        }
    }

    #[test]
    fn json_omits_args_env_when_absent_on_stdio() {
        for (agent, container_key) in JSON_AGENTS {
            let writer = writer_for(agent);
            let text = writer
                .upsert("", "bare_1", &stdio_def_no_args_env())
                .unwrap();
            let parsed = parse(&text);
            let server = &parsed[container_key]["bare_1"];
            assert!(server.get("args").is_none());
            assert!(server.get("env").is_none());
            assert_eq!(server["command"], "my-server");
        }
    }

    #[test]
    fn json_shapes_http_and_sse() {
        for (agent, container_key) in JSON_AGENTS {
            let writer = writer_for(agent);
            let http_text = writer.upsert("", "remote_http_1", &http_def()).unwrap();
            let http = parse(&http_text);
            assert_eq!(http[container_key]["remote_http_1"]["type"], "http");
            assert_eq!(
                http[container_key]["remote_http_1"]["url"],
                "https://example.com/mcp"
            );
            assert_eq!(
                http[container_key]["remote_http_1"]["headers"]["Authorization"],
                "Bearer x"
            );

            let sse_text = writer.upsert("", "remote_sse_1", &sse_def()).unwrap();
            let sse = parse(&sse_text);
            assert_eq!(sse[container_key]["remote_sse_1"]["type"], "sse");
            assert!(sse[container_key]["remote_sse_1"].get("headers").is_none());
        }
    }

    #[test]
    fn json_preserves_unrelated_keys_and_servers() {
        for (agent, container_key) in JSON_AGENTS {
            let writer = writer_for(agent);
            let existing = serde_json::json!({
                "someOtherTopLevelKey": { "keep": true },
                container_key: { "user_server": { "type": "stdio", "command": "user-defined" } },
            })
            .to_string();
            let text = writer.upsert(&existing, "github_1", &stdio_def()).unwrap();
            let parsed = parse(&text);
            assert_eq!(parsed["someOtherTopLevelKey"]["keep"], true);
            assert_eq!(
                parsed[container_key]["user_server"]["command"],
                "user-defined"
            );
            assert!(parsed[container_key].get("github_1").is_some());
        }
    }

    #[test]
    fn json_remove_and_existing_names() {
        for (agent, container_key) in JSON_AGENTS {
            let writer = writer_for(agent);
            let with_one = writer.upsert("", "github_1", &stdio_def()).unwrap();
            let with_two = writer.upsert(&with_one, "other_1", &http_def()).unwrap();

            let mut names = writer.existing_names(&with_two).unwrap();
            names.sort();
            assert_eq!(names, vec!["github_1", "other_1"]);
            assert_eq!(writer.existing_names("").unwrap(), Vec::<String>::new());

            let removed = writer.remove(&with_two, "github_1").unwrap();
            let parsed = parse(&removed);
            assert!(parsed[container_key].get("github_1").is_none());
            assert!(parsed[container_key].get("other_1").is_some());

            // Remove is a no-op (text unchanged) when the server is absent.
            assert_eq!(
                writer.remove(&with_one, "does_not_exist").unwrap(),
                with_one
            );
            assert_eq!(writer.remove("", "does_not_exist").unwrap(), "");
        }
    }

    #[test]
    fn opencode_maps_stdio_to_local() {
        let writer = writer_for(AgentKind::Opencode);
        let text = writer.upsert("", "github_1", &stdio_def()).unwrap();
        let parsed = parse(&text);
        let server = &parsed["mcp"]["github_1"];
        assert_eq!(server["type"], "local");
        assert_eq!(
            server["command"],
            serde_json::json!(["npx", "-y", "@modelcontextprotocol/server-github"])
        );
        assert_eq!(server["environment"]["GITHUB_TOKEN"], "secret");
        assert_eq!(server["enabled"], true);
    }

    #[test]
    fn opencode_omits_environment_and_bare_command() {
        let writer = writer_for(AgentKind::Opencode);
        let text = writer
            .upsert("", "bare_1", &stdio_def_no_args_env())
            .unwrap();
        let parsed = parse(&text);
        let server = &parsed["mcp"]["bare_1"];
        assert_eq!(server["type"], "local");
        assert_eq!(server["command"], serde_json::json!(["my-server"]));
        assert_eq!(server["enabled"], true);
        assert!(server.get("environment").is_none());
    }

    #[test]
    fn opencode_maps_http_and_sse_to_remote() {
        let writer = writer_for(AgentKind::Opencode);
        let http_text = writer.upsert("", "remote_http_1", &http_def()).unwrap();
        let http = parse(&http_text);
        let s = &http["mcp"]["remote_http_1"];
        assert_eq!(s["type"], "remote");
        assert_eq!(s["url"], "https://example.com/mcp");
        assert_eq!(s["headers"]["Authorization"], "Bearer x");
        assert_eq!(s["enabled"], true);

        let sse_text = writer.upsert("", "remote_sse_1", &sse_def()).unwrap();
        let sse = parse(&sse_text);
        let s = &sse["mcp"]["remote_sse_1"];
        assert_eq!(s["type"], "remote");
        assert_eq!(s["url"], "https://example.com/sse");
        assert_eq!(s["enabled"], true);
        assert!(s.get("headers").is_none());
    }

    #[test]
    fn opencode_preserves_unrelated_keys() {
        let writer = writer_for(AgentKind::Opencode);
        let existing = serde_json::json!({
            "theme": "dark",
            "mcp": { "user_server": { "type": "remote", "url": "https://user.example", "enabled": true } },
        })
        .to_string();
        let text = writer.upsert(&existing, "github_1", &stdio_def()).unwrap();
        let parsed = parse(&text);
        assert_eq!(parsed["theme"], "dark");
        assert_eq!(parsed["mcp"]["user_server"]["url"], "https://user.example");
    }

    #[test]
    fn codex_round_trips_a_stdio_server() {
        let writer = writer_for(AgentKind::Codex);
        let text = writer.upsert("", "github_1", &stdio_def()).unwrap();
        assert!(text.contains("[mcp_servers.github_1]"));
        assert_eq!(writer.existing_names(&text).unwrap(), vec!["github_1"]);
        // Re-upserting the same def yields identical text.
        let again = writer.upsert(&text, "github_1", &stdio_def()).unwrap();
        assert_eq!(again, text);
    }

    #[test]
    fn codex_omits_args_env_when_absent() {
        let writer = writer_for(AgentKind::Codex);
        let text = writer
            .upsert("", "bare_1", &stdio_def_no_args_env())
            .unwrap();
        assert!(!text.contains("args"));
        assert!(!text.contains("env"));
    }

    #[test]
    fn codex_preserves_unrelated_tables() {
        let writer = writer_for(AgentKind::Codex);
        let existing = [
            "[model]",
            "name = \"gpt-5\"",
            "",
            "[mcp_servers.user_server]",
            "command = \"user-defined\"",
            "",
        ]
        .join("\n");
        let text = writer.upsert(&existing, "github_1", &stdio_def()).unwrap();
        assert!(text.contains("[model]"));
        assert!(text.contains("name = \"gpt-5\""));
        assert!(text.contains("[mcp_servers.user_server]"));
        assert!(text.contains("command = \"user-defined\""));
        assert!(text.contains("[mcp_servers.github_1]"));
    }

    #[test]
    fn codex_remove_and_existing_names() {
        let writer = writer_for(AgentKind::Codex);
        let with_one = writer.upsert("", "github_1", &stdio_def()).unwrap();
        let with_two = writer
            .upsert(&with_one, "other_1", &stdio_def_no_args_env())
            .unwrap();

        let removed = writer.remove(&with_two, "github_1").unwrap();
        assert!(!removed.contains("[mcp_servers.github_1]"));
        assert!(removed.contains("[mcp_servers.other_1]"));

        assert_eq!(writer.remove(&removed, "does_not_exist").unwrap(), removed);
        assert_eq!(writer.remove("", "does_not_exist").unwrap(), "");

        let mut names = writer.existing_names(&with_two).unwrap();
        names.sort();
        assert_eq!(names, vec!["github_1", "other_1"]);
        assert_eq!(writer.existing_names("").unwrap(), Vec::<String>::new());
    }

    #[test]
    fn codex_rejects_a_non_stdio_def() {
        let writer = writer_for(AgentKind::Codex);
        assert!(writer.upsert("", "remote_http_1", &http_def()).is_err());
    }

    #[test]
    fn defensive_validation_of_malformed_defs_and_files() {
        let bad_stdio = McpServerDef {
            name: "x".to_string(),
            transport: McpTransport::Stdio,
            url: None,
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: None,
        };
        let bad_http = McpServerDef {
            name: "x".to_string(),
            transport: McpTransport::Http,
            url: None,
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: None,
        };
        let claude = writer_for(AgentKind::Claude);
        assert!(claude.upsert("", "x", &bad_stdio).is_err());
        let opencode = writer_for(AgentKind::Opencode);
        assert!(opencode.upsert("", "x", &bad_http).is_err());
        // Non-object JSON root.
        assert!(claude.upsert("[]", "x", &stdio_def()).is_err());
        assert!(claude.existing_names("[]").is_err());
        // Codex rejects stdio without a command.
        let codex = writer_for(AgentKind::Codex);
        assert!(codex.upsert("", "x", &bad_stdio).is_err());
    }

    #[test]
    fn supports_transport_gates_codex_to_stdio() {
        assert!(supports_transport(AgentKind::Codex, McpTransport::Stdio));
        assert!(!supports_transport(AgentKind::Codex, McpTransport::Http));
        assert!(!supports_transport(AgentKind::Codex, McpTransport::Sse));
        for agent in [
            AgentKind::Claude,
            AgentKind::Cursor,
            AgentKind::Copilot,
            AgentKind::Opencode,
        ] {
            assert!(supports_transport(agent, McpTransport::Stdio));
            assert!(supports_transport(agent, McpTransport::Http));
            assert!(supports_transport(agent, McpTransport::Sse));
        }
    }

    #[test]
    fn mcp_destination_resolves_project_scoped_paths() {
        let target = McpDestinationTarget {
            project_path: Some("/proj".to_string()),
            home_dir: Some("/home/user".to_string()),
        };
        assert_eq!(
            mcp_destination(AgentKind::Claude, &target).unwrap(),
            McpDestination {
                path: "/proj/.mcp.json".to_string(),
                scope: Scope::Project,
            }
        );
        assert_eq!(
            mcp_destination(AgentKind::Cursor, &target).unwrap().path,
            "/proj/.cursor/mcp.json"
        );
        assert_eq!(
            mcp_destination(AgentKind::Copilot, &target).unwrap().path,
            "/proj/.vscode/mcp.json"
        );
        assert_eq!(
            mcp_destination(AgentKind::Opencode, &target).unwrap().path,
            "/proj/opencode.json"
        );
    }

    #[test]
    fn mcp_destination_resolves_codex_globally() {
        let target = McpDestinationTarget {
            project_path: Some("/proj".to_string()),
            home_dir: Some("/home/user".to_string()),
        };
        assert_eq!(
            mcp_destination(AgentKind::Codex, &target).unwrap(),
            McpDestination {
                path: "/home/user/.codex/config.toml".to_string(),
                scope: Scope::Global,
            }
        );
    }

    #[test]
    fn mcp_destination_errors_on_missing_target_field() {
        assert!(mcp_destination(AgentKind::Claude, &McpDestinationTarget::default()).is_err());
        assert!(mcp_destination(AgentKind::Codex, &McpDestinationTarget::default()).is_err());
    }
}
