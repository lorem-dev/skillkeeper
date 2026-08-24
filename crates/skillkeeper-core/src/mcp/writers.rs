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
//! The JSON writers also carry a SkillKeeper hook region through the
//! read-modify-write untouched, because opencode's global native MCP config is
//! the very file opencode's hooks are delimited into (see the comment on the
//! [`JsonWriter`] impl). Note that this only keeps SkillKeeper from failing and
//! from destroying the region: a `#`-delimited block is not valid JSON, so a
//! file holding both is still unreadable BY OPENCODE. Making the combined file
//! valid means moving the opencode hook strategy to `json-merge`, tracked
//! separately.
//!
//! LIMITATION (codex): the TOML writer round-trips through `toml`'s
//! parse/serialize. Table structure and values survive but the user's original
//! comments and formatting do not -- an accepted v1 tradeoff (see the design
//! doc), matching the TypeScript writer.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value};
use thiserror::Error;

use crate::hooks::region::{lift_regions, restore_regions};
use crate::mcp::model::{McpServerDef, McpTransport};
use crate::models::{AgentKind, Scope};

/// Raised by a writer when handed a malformed server definition or a native
/// config whose root is not the expected shape.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{0}")]
pub struct WriterError(pub String);

/// Something worth telling the user about an otherwise successful upsert.
///
/// Structured rather than a formatted sentence: the renderer localizes these
/// into 18 catalogs, so the writer must not bake English prose into them. The
/// serialized form is a discriminated union the bridge already handles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/"
    )
)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpsertNote {
    /// The agent cannot express this field, so it was not written. `field` is
    /// the canonical name (`"callbackPort"`, `"scopes"`), not a native key.
    DroppedField { field: String },
    /// Codex already sets its global callback keys to something else, so they
    /// were left alone. `found` is the existing value of whichever of the two
    /// keys conflicts, rendered for display rather than typed: a hand-edited
    /// config can hold a port outside `u16`, a port written as a quoted string,
    /// or only the url -- and reporting any of those as a clamped number would
    /// tell the user something untrue about their own file.
    CodexCallbackConflict { found: String, wanted: u16 },
}

/// The result of an upsert: the rewritten config text, plus any notes. A note
/// is not an error -- the server is written -- but it must reach the user,
/// because a silently dropped auth field reads as configured when it is not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpsertOutcome {
    pub text: String,
    pub notes: Vec<UpsertNote>,
}

/// Translates a rendered [`McpServerDef`] into one agent's native MCP config
/// text. All operations are pure text transforms (no I/O).
pub trait McpConfigWriter {
    /// Add server `name`, or replace it if already present.
    fn upsert(
        &self,
        text: &str,
        name: &str,
        def: &McpServerDef,
    ) -> Result<UpsertOutcome, WriterError>;
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

fn str_map_to_toml(map: &BTreeMap<String, String>) -> toml::Table {
    map.iter()
        .map(|(k, v)| (k.clone(), toml::Value::String(v.clone())))
        .collect()
}

/// The plain claude/cursor/copilot server shape: a `type`-tagged object with no
/// auth block. The base each per-agent wrapper below starts from.
fn to_plain_server_json(def: &McpServerDef) -> Result<Value, WriterError> {
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

/// Copilot's shape: the plain object with no auth block. Copilot cannot express
/// an OAuth client ([`supports_oauth`]), and every path that reaches a writer
/// gates on that first -- `mcp install` and `mcp update` in the CLI, `mcp:apply`
/// and `mcp:update` in the desktop -- so a def carrying an oauth block is
/// declined before it gets here and there is nothing to note.
fn to_copilot_server_json(def: &McpServerDef) -> Result<(Value, Vec<UpsertNote>), WriterError> {
    Ok((to_plain_server_json(def)?, Vec::new()))
}

/// A stdio def carrying an `oauth` block: the block is not written, and the
/// drop is reported. `oauth` is meaningful only for `http` and `sse` (nothing
/// authenticates a local subprocess), and nothing upstream of the writers
/// rejects the combination -- so without this, a nonsense def either had an
/// auth block written onto a stdio server object or had it silently discarded,
/// differently per agent. Reporting is the rule the rest of this module
/// follows: a dropped auth field must never read as configured.
fn stdio_oauth_notes(def: &McpServerDef) -> Vec<UpsertNote> {
    if def.transport == McpTransport::Stdio && def.oauth.is_some() {
        return vec![UpsertNote::DroppedField {
            field: "oauth".to_string(),
        }];
    }
    Vec::new()
}

/// Claude Code's shape: an `oauth` object with camelCase keys, whose `scopes`
/// is the single space-separated string of RFC 6749 section 3.3.
fn to_claude_server_json(def: &McpServerDef) -> Result<(Value, Vec<UpsertNote>), WriterError> {
    let mut value = to_plain_server_json(def)?;
    let Some(oauth) = &def.oauth else {
        return Ok((value, Vec::new()));
    };
    let stdio_notes = stdio_oauth_notes(def);
    if !stdio_notes.is_empty() {
        return Ok((value, stdio_notes));
    }
    let mut block = Map::new();
    if let Some(client_id) = &oauth.client_id {
        block.insert("clientId".into(), Value::String(client_id.clone()));
    }
    if let Some(port) = oauth.callback_port {
        block.insert("callbackPort".into(), Value::Number(port.into()));
    }
    if !oauth.scopes.is_empty() {
        block.insert("scopes".into(), Value::String(oauth.scopes.join(" ")));
    }
    if !block.is_empty() {
        if let Value::Object(obj) = &mut value {
            obj.insert("oauth".into(), Value::Object(block));
        }
    }
    Ok((value, Vec::new()))
}

/// Cursor's shape: an `auth` object whose client id key is `CLIENT_ID` and
/// whose `scopes` is an array. Cursor has no callback-port setting, so that
/// field is dropped with a note.
fn to_cursor_server_json(def: &McpServerDef) -> Result<(Value, Vec<UpsertNote>), WriterError> {
    let mut value = to_plain_server_json(def)?;
    let Some(oauth) = &def.oauth else {
        return Ok((value, Vec::new()));
    };
    let stdio_notes = stdio_oauth_notes(def);
    if !stdio_notes.is_empty() {
        return Ok((value, stdio_notes));
    }
    let mut notes = Vec::new();
    let mut block = Map::new();
    if let Some(client_id) = &oauth.client_id {
        block.insert("CLIENT_ID".into(), Value::String(client_id.clone()));
    }
    if !oauth.scopes.is_empty() {
        block.insert(
            "scopes".into(),
            Value::Array(
                oauth
                    .scopes
                    .iter()
                    .map(|s| Value::String(s.clone()))
                    .collect(),
            ),
        );
    }
    if oauth.callback_port.is_some() {
        notes.push(UpsertNote::DroppedField {
            field: "callbackPort".to_string(),
        });
    }
    if !block.is_empty() {
        if let Value::Object(obj) = &mut value {
            obj.insert("auth".into(), Value::Object(block));
        }
    }
    Ok((value, notes))
}

/// The opencode server shape: `local` (stdio) with `command` as an array and
/// `env` renamed `environment`, or `remote` (http and sse both map to `remote`).
fn to_opencode_server_json(def: &McpServerDef) -> Result<(Value, Vec<UpsertNote>), WriterError> {
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
        return Ok((Value::Object(obj), stdio_oauth_notes(def)));
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
    let mut notes = Vec::new();
    if let Some(oauth) = &def.oauth {
        let mut block = Map::new();
        if let Some(client_id) = &oauth.client_id {
            block.insert("clientId".into(), Value::String(client_id.clone()));
        }
        if oauth.callback_port.is_some() {
            notes.push(UpsertNote::DroppedField {
                field: "callbackPort".to_string(),
            });
        }
        // Whether opencode accepts a scopes field, and under what name, is
        // unverified; omit it and say so rather than guess a key.
        if !oauth.scopes.is_empty() {
            notes.push(UpsertNote::DroppedField {
                field: "scopes".to_string(),
            });
        }
        if !block.is_empty() {
            obj.insert("oauth".into(), Value::Object(block));
        }
    }
    Ok((Value::Object(obj), notes))
}

type ShapeFn = fn(&McpServerDef) -> Result<(Value, Vec<UpsertNote>), WriterError>;

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

// Every method here lifts SkillKeeper's own hook regions out before
// `serde_json` sees the text and restores them afterwards. At global scope
// opencode's native MCP config and opencode's hook target are the same file,
// `~/.config/opencode/opencode.json`, and the hook side writes a `#`-delimited
// text region into it. Without the lift, installing an MCP server into a file
// that already carries a hook region fails with a raw JSON parse error, and the
// writer's own output would drop the region on the floor. Only our own complete
// regions are lifted (see [`lift_regions`]); every other non-JSON byte stays in
// the text and is still rejected by [`parse_json_root`].
impl McpConfigWriter for JsonWriter {
    fn upsert(
        &self,
        text: &str,
        name: &str,
        def: &McpServerDef,
    ) -> Result<UpsertOutcome, WriterError> {
        let (json_text, regions) = lift_regions(text);
        let mut root = parse_json_root(&json_text)?;
        let mut container = match root.get(self.container_key) {
            Some(Value::Object(existing)) => existing.clone(),
            _ => Map::new(),
        };
        let (server, notes) = (self.to_server)(def)?;
        container.insert(name.to_string(), server);
        root.insert(self.container_key.to_string(), Value::Object(container));
        Ok(UpsertOutcome {
            text: restore_regions(&serialize_json(root), &regions),
            notes,
        })
    }

    fn remove(&self, text: &str, name: &str) -> Result<String, WriterError> {
        let (json_text, regions) = lift_regions(text);
        // A file that holds nothing but our region carries no JSON document, so
        // there is no server to drop and nothing to rewrite.
        if json_text.trim().is_empty() {
            return Ok(text.to_string());
        }
        let mut root = parse_json_root(&json_text)?;
        let Some(Value::Object(existing)) = root.get(self.container_key) else {
            return Ok(text.to_string());
        };
        if !existing.contains_key(name) {
            return Ok(text.to_string());
        }
        let mut container = existing.clone();
        container.remove(name);
        root.insert(self.container_key.to_string(), Value::Object(container));
        Ok(restore_regions(&serialize_json(root), &regions))
    }

    fn existing_names(&self, text: &str) -> Result<Vec<String>, WriterError> {
        let (json_text, _) = lift_regions(text);
        if json_text.trim().is_empty() {
            return Ok(Vec::new());
        }
        let root = parse_json_root(&json_text)?;
        match root.get(self.container_key) {
            Some(Value::Object(existing)) => Ok(existing.keys().cloned().collect()),
            _ => Ok(Vec::new()),
        }
    }
}

const CODEX_CONTAINER_KEY: &str = "mcp_servers";

/// The codex native MCP config writer: `~/.codex/config.toml`, TOML table
/// `[mcp_servers.<name>]`. Codex supports the `stdio` and `http` transports;
/// [`Self::upsert`] rejects `sse` as a defensive check (see
/// [`supports_transport`]).
struct CodexTomlWriter;

fn parse_toml_root(text: &str) -> Result<toml::Table, WriterError> {
    if text.trim().is_empty() {
        return Ok(toml::Table::new());
    }
    toml::from_str::<toml::Table>(text).map_err(|e| WriterError(format!("invalid TOML: {e}")))
}

/// The codex server table, plus any notes raised building it (a stdio def
/// carrying an `oauth` block has it dropped and said so, like every other
/// writer).
fn to_codex_server_object(
    def: &McpServerDef,
) -> Result<(toml::Value, Vec<UpsertNote>), WriterError> {
    match def.transport {
        McpTransport::Stdio => {
            let command = def.command.as_ref().ok_or_else(|| {
                WriterError("stdio server definition requires \"command\"".into())
            })?;
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
                obj.insert("env".into(), toml::Value::Table(str_map_to_toml(env)));
            }
            Ok((toml::Value::Table(obj), stdio_oauth_notes(def)))
        }
        McpTransport::Http => {
            let url = def
                .url
                .as_ref()
                .ok_or_else(|| WriterError("http server definition requires \"url\"".into()))?;
            let mut obj = toml::Table::new();
            obj.insert("url".into(), toml::Value::String(url.clone()));
            if let Some(headers) = &def.headers {
                obj.insert(
                    "http_headers".into(),
                    toml::Value::Table(str_map_to_toml(headers)),
                );
            }
            if let Some(oauth) = &def.oauth {
                // Codex reads `scopes` from the server table itself, and takes
                // the client id from a nested `oauth` table in snake_case.
                if !oauth.scopes.is_empty() {
                    obj.insert(
                        "scopes".into(),
                        toml::Value::Array(
                            oauth
                                .scopes
                                .iter()
                                .map(|s| toml::Value::String(s.clone()))
                                .collect(),
                        ),
                    );
                }
                if let Some(client_id) = &oauth.client_id {
                    let mut nested = toml::Table::new();
                    nested.insert("client_id".into(), toml::Value::String(client_id.clone()));
                    obj.insert("oauth".into(), toml::Value::Table(nested));
                }
            }
            Ok((toml::Value::Table(obj), Vec::new()))
        }
        // Codex's support for sse over its remote client is unverified; keep it
        // rejected so `supports_transport` and this writer never disagree.
        McpTransport::Sse => Err(WriterError(format!(
            "codex does not support the {} transport",
            transport_str(def.transport)
        ))),
    }
}

const CODEX_CALLBACK_PORT_KEY: &str = "mcp_oauth_callback_port";
const CODEX_CALLBACK_URL_KEY: &str = "mcp_oauth_callback_url";

/// Renders an existing config value for a conflict message. An integer prints
/// bare; a string keeps its quotes, so a port hand-written as `"8432"` does not
/// read identically to the number we wanted and leave the user with a message
/// that makes no sense; anything else names its type, which is all there is
/// useful to say about it.
fn describe_toml_value(value: &toml::Value) -> String {
    match value {
        toml::Value::Integer(i) => i.to_string(),
        toml::Value::String(s) => format!("{s:?}"),
        other => other.type_str().to_string(),
    }
}

/// Apply codex's two top-level OAuth callback keys.
///
/// These are global, unlike every other native write SkillKeeper makes, which
/// stays inside the table it owns. So the rules are deliberately conservative:
/// write both or neither (the url is derived from the port, and a half-written
/// pair is worse than none), write only when each key is absent or already
/// exactly the value we would write, and never remove -- another server or the
/// user may depend on them.
///
/// BOTH keys are consulted, not only the port, and a port that is present but
/// not an integer counts as a conflict rather than as nothing. A url standing
/// on its own, or a port hand-written as `"8432"`, is a pre-existing value
/// SkillKeeper did not set; silently rewriting a global setting that another
/// server may depend on is the single thing this policy exists to prevent.
fn apply_codex_callback_keys(root: &mut toml::Table, port: u16) -> Vec<UpsertNote> {
    let want_url = format!("http://localhost:{port}/callback");
    let port_conflict = root
        .get(CODEX_CALLBACK_PORT_KEY)
        .filter(|value| value.as_integer() != Some(i64::from(port)));
    let url_conflict = root
        .get(CODEX_CALLBACK_URL_KEY)
        .filter(|value| value.as_str() != Some(want_url.as_str()));
    if let Some(found) = port_conflict.or(url_conflict) {
        return vec![UpsertNote::CodexCallbackConflict {
            found: describe_toml_value(found),
            wanted: port,
        }];
    }
    root.insert(
        CODEX_CALLBACK_PORT_KEY.to_string(),
        toml::Value::Integer(i64::from(port)),
    );
    root.insert(
        CODEX_CALLBACK_URL_KEY.to_string(),
        toml::Value::String(want_url),
    );
    Vec::new()
}

impl McpConfigWriter for CodexTomlWriter {
    fn upsert(
        &self,
        text: &str,
        name: &str,
        def: &McpServerDef,
    ) -> Result<UpsertOutcome, WriterError> {
        let mut root = parse_toml_root(text)?;
        let mut container = match root.get(CODEX_CONTAINER_KEY) {
            Some(toml::Value::Table(existing)) => existing.clone(),
            _ => toml::Table::new(),
        };
        let (server, mut notes) = to_codex_server_object(def)?;
        container.insert(name.to_string(), server);
        root.insert(
            CODEX_CONTAINER_KEY.to_string(),
            toml::Value::Table(container),
        );
        // Gated on the transport, not just on the presence of a port: the two
        // callback keys are GLOBAL and `remove` never takes them back out, so a
        // stdio def carrying a nonsense `callback_port` would permanently
        // mutate a user-wide codex setting on the strength of a field that was
        // itself dropped two lines above.
        let callback_port = match def.transport {
            McpTransport::Stdio => None,
            _ => def.oauth.as_ref().and_then(|o| o.callback_port),
        };
        if let Some(port) = callback_port {
            notes.extend(apply_codex_callback_keys(&mut root, port));
        }
        let text =
            toml::to_string(&toml::Value::Table(root)).map_err(|e| WriterError(e.to_string()))?;
        Ok(UpsertOutcome { text, notes })
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
            to_server: to_claude_server_json,
        }),
        AgentKind::Cursor => Box::new(JsonWriter {
            container_key: "mcpServers",
            to_server: to_cursor_server_json,
        }),
        AgentKind::Copilot => Box::new(JsonWriter {
            container_key: "servers",
            to_server: to_copilot_server_json,
        }),
        AgentKind::Opencode => Box::new(JsonWriter {
            container_key: "mcp",
            to_server: to_opencode_server_json,
        }),
        AgentKind::Codex => Box::new(CodexTomlWriter),
    }
}

/// Whether `agent`'s native config can express transport `t`. Codex supports
/// stdio and http; whether its remote client accepts sse is unverified, so sse
/// stays unsupported rather than being written on a guess.
pub fn supports_transport(agent: AgentKind, t: McpTransport) -> bool {
    if agent == AgentKind::Codex {
        return t != McpTransport::Sse;
    }
    true
}

/// Whether `agent` can express a static OAuth client configuration in its
/// native config. Copilot cannot in the surfaces SkillKeeper writes for, so a
/// preset carrying an oauth block skips it rather than being written without
/// its auth -- a server that looks installed and cannot authenticate is worse
/// than one that was never written.
pub fn supports_oauth(agent: AgentKind) -> bool {
    agent != AgentKind::Copilot
}

/// Inputs needed to resolve an agent's native MCP config destination.
#[derive(Debug, Clone, Default)]
pub struct McpDestinationTarget {
    /// Project root; required (and non-blank) at project scope.
    pub project_path: Option<String>,
    /// User home directory; required (and non-blank) at global scope.
    pub home_dir: Option<String>,
}

/// Resolved native MCP config file location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpDestination {
    pub path: String,
    pub scope: Scope,
}

/// Require a destination input to be present AND non-blank, so a missing value
/// can never resolve to the filesystem root (`""` + `/.claude.json`). Mirrors
/// `require_project_dir` in `skillkeeper-agents`, which rejects a blank project
/// directory for the same reason: `HostEnv::home_dir` reports an unset
/// `HOME`/`USERPROFILE` as an empty string, not as `None`, so every caller
/// passes `Some("")` rather than `None`.
fn require_destination_input<'a>(
    value: Option<&'a String>,
    message: &str,
) -> Result<&'a str, String> {
    match value.map(|v| v.trim()) {
        Some(dir) if !dir.is_empty() => Ok(dir),
        _ => Err(message.to_string()),
    }
}

/// Resolve where `agent` keeps its native MCP config for `scope`. Global
/// resolutions land next to the directory the agent's adapter already uses at
/// global scope, so every SkillKeeper-managed file for that agent stays in one
/// place. Returns an error when the field the scope needs is absent or blank.
pub fn mcp_destination(
    agent: AgentKind,
    scope: Scope,
    target: &McpDestinationTarget,
) -> Result<McpDestination, String> {
    if scope == Scope::Global {
        let home = require_destination_input(
            target.home_dir.as_ref(),
            &format!("{agent:?} global destination requires \"homeDir\""),
        )?;
        let path = match agent {
            AgentKind::Claude => format!("{home}/.claude.json"),
            AgentKind::Codex => format!("{home}/.codex/config.toml"),
            AgentKind::Copilot => format!("{home}/.config/github-copilot/mcp-config.json"),
            AgentKind::Cursor => format!("{home}/.cursor/mcp.json"),
            AgentKind::Opencode => format!("{home}/.config/opencode/opencode.json"),
        };
        return Ok(McpDestination {
            path,
            scope: Scope::Global,
        });
    }
    let project = require_destination_input(
        target.project_path.as_ref(),
        &format!("{agent:?} destination requires \"projectPath\""),
    )?;
    let path = match agent {
        AgentKind::Claude => format!("{project}/.mcp.json"),
        AgentKind::Cursor => format!("{project}/.cursor/mcp.json"),
        AgentKind::Copilot => format!("{project}/.vscode/mcp.json"),
        AgentKind::Opencode => format!("{project}/opencode.json"),
        AgentKind::Codex => format!("{project}/.codex/config.toml"),
    };
    Ok(McpDestination {
        path,
        scope: Scope::Project,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::region::{insert_region, wrap_region, InsertMode, WrapRegionOptions};
    use crate::mcp::hashing::hash_mcp_def;
    use crate::mcp::model::McpOauth;

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
            oauth: None,
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
            oauth: None,
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
            oauth: None,
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
            oauth: None,
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
            let text = writer.upsert("", "github_1", &stdio_def()).unwrap().text;
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
                .unwrap()
                .text;
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
            let http_text = writer
                .upsert("", "remote_http_1", &http_def())
                .unwrap()
                .text;
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

            let sse_text = writer.upsert("", "remote_sse_1", &sse_def()).unwrap().text;
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
            let text = writer
                .upsert(&existing, "github_1", &stdio_def())
                .unwrap()
                .text;
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
            let with_one = writer.upsert("", "github_1", &stdio_def()).unwrap().text;
            let with_two = writer
                .upsert(&with_one, "other_1", &http_def())
                .unwrap()
                .text;

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

    // ---- per-agent oauth shapes ----

    fn oauth_def(client_id: Option<&str>, port: Option<u16>, scopes: Vec<&str>) -> McpServerDef {
        McpServerDef {
            name: "remote".to_string(),
            transport: McpTransport::Http,
            url: Some("https://mcp.example.com/mcp".to_string()),
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: None,
            oauth: Some(McpOauth {
                callback_port: port,
                client_id: client_id.map(str::to_string),
                scopes: scopes.into_iter().map(str::to_string).collect(),
            }),
        }
    }

    #[test]
    fn claude_writes_oauth_with_camel_case_and_space_joined_scopes() {
        let def = oauth_def(Some("example-client"), Some(8432), vec!["read", "write"]);
        let out = writer_for(AgentKind::Claude)
            .upsert("", "remote", &def)
            .expect("upsert");
        let root: Value = serde_json::from_str(&out.text).expect("json");
        let oauth = &root["mcpServers"]["remote"]["oauth"];
        assert_eq!(oauth["clientId"], "example-client");
        assert_eq!(oauth["callbackPort"], 8432);
        assert_eq!(oauth["scopes"], "read write");
        assert!(out.notes.is_empty());
    }

    #[test]
    fn cursor_writes_auth_with_screaming_keys_and_an_array_of_scopes() {
        let def = oauth_def(Some("example-client"), Some(8432), vec!["read", "write"]);
        let out = writer_for(AgentKind::Cursor)
            .upsert("", "remote", &def)
            .expect("upsert");
        let root: Value = serde_json::from_str(&out.text).expect("json");
        let auth = &root["mcpServers"]["remote"]["auth"];
        assert_eq!(auth["CLIENT_ID"], "example-client");
        assert_eq!(auth["scopes"], serde_json::json!(["read", "write"]));
        assert!(auth.get("callbackPort").is_none());
        assert!(
            auth.get("CLIENT_SECRET").is_none(),
            "a secret is never written"
        );
        assert_eq!(
            out.notes,
            vec![UpsertNote::DroppedField {
                field: "callbackPort".to_string()
            }]
        );
    }

    #[test]
    fn the_claude_scope_join_is_lossy_which_is_why_the_stored_form_is_a_list() {
        // The reason `scopes` is canonically a list. `["read write"]` and
        // `["read", "write"]` are DIFFERENT scope sets that claude's
        // space-joined wire format renders identically, so the join cannot be
        // reversed and must never be the stored form.
        let one_scope_with_a_space = oauth_def(None, None, vec!["read write"]);
        let two_scopes = oauth_def(None, None, vec!["read", "write"]);

        let joined = |def: &McpServerDef| -> String {
            let out = writer_for(AgentKind::Claude)
                .upsert("", "remote", def)
                .expect("upsert");
            let root: Value = serde_json::from_str(&out.text).expect("json");
            root["mcpServers"]["remote"]["oauth"]["scopes"]
                .as_str()
                .expect("claude joins scopes into one string")
                .to_string()
        };
        assert_eq!(joined(&one_scope_with_a_space), "read write");
        assert_eq!(
            joined(&one_scope_with_a_space),
            joined(&two_scopes),
            "the join is lossy: splitting it back cannot recover which set it was"
        );

        // And the canonical list is what distinguishes them, so the two are not
        // the same install and an update between them is detectable.
        assert_ne!(
            hash_mcp_def(&one_scope_with_a_space),
            hash_mcp_def(&two_scopes),
            "the list, unlike the joined string, keeps the two sets distinct"
        );
    }

    #[test]
    fn opencode_writes_a_client_id_and_notes_what_it_cannot_take() {
        let def = oauth_def(Some("example-client"), Some(8432), vec!["read"]);
        let out = writer_for(AgentKind::Opencode)
            .upsert("", "remote", &def)
            .expect("upsert");
        let root: Value = serde_json::from_str(&out.text).expect("json");
        assert_eq!(root["mcp"]["remote"]["oauth"]["clientId"], "example-client");
        assert!(out.notes.contains(&UpsertNote::DroppedField {
            field: "callbackPort".to_string()
        }));
        assert!(out.notes.contains(&UpsertNote::DroppedField {
            field: "scopes".to_string()
        }));
    }

    #[test]
    fn codex_writes_client_id_in_a_nested_table_and_scopes_beside_the_url() {
        let def = oauth_def(Some("example-client"), None, vec!["read", "write"]);
        let out = writer_for(AgentKind::Codex)
            .upsert("", "remote", &def)
            .expect("upsert");
        let root: toml::Table = toml::from_str(&out.text).expect("toml");
        let server = root["mcp_servers"]["remote"].as_table().expect("table");
        assert_eq!(server["url"].as_str(), Some("https://mcp.example.com/mcp"));
        assert_eq!(
            server["scopes"].as_array().expect("array").len(),
            2,
            "scopes sit in the server table, not inside oauth"
        );
        let oauth_table = server["oauth"].as_table().expect("nested oauth table");
        assert_eq!(
            oauth_table.keys().collect::<Vec<_>>(),
            vec!["client_id"],
            "codex does not read scopes (or anything else) from the nested oauth \
             table; a stray key there would silently request no scopes"
        );
        assert_eq!(
            server["oauth"]["client_id"].as_str(),
            Some("example-client")
        );
    }

    #[test]
    fn codex_writes_the_callback_pair_when_absent() {
        let def = oauth_def(Some("example-client"), Some(8432), vec![]);
        let out = writer_for(AgentKind::Codex)
            .upsert("", "remote", &def)
            .expect("upsert");
        let root: toml::Table = toml::from_str(&out.text).expect("toml");
        assert_eq!(root["mcp_oauth_callback_port"].as_integer(), Some(8432));
        assert_eq!(
            root["mcp_oauth_callback_url"].as_str(),
            Some("http://localhost:8432/callback"),
            "the url is derived from the port and the pair is always consistent"
        );
        assert!(out.notes.is_empty());
    }

    #[test]
    fn codex_leaves_a_conflicting_callback_port_alone_and_says_so() {
        let existing = "mcp_oauth_callback_port = 9999\n";
        let def = oauth_def(Some("example-client"), Some(8432), vec![]);
        let out = writer_for(AgentKind::Codex)
            .upsert(existing, "remote", &def)
            .expect("upsert");
        let root: toml::Table = toml::from_str(&out.text).expect("toml");
        assert_eq!(
            root["mcp_oauth_callback_port"].as_integer(),
            Some(9999),
            "a global key we did not set is not ours to rewrite"
        );
        assert!(
            root["mcp_servers"]["remote"].is_table(),
            "the server is still written"
        );
        assert_eq!(
            out.notes,
            vec![UpsertNote::CodexCallbackConflict {
                found: "9999".to_string(),
                wanted: 8432
            }]
        );
    }

    #[test]
    fn codex_treats_a_lone_callback_url_as_a_conflict_rather_than_rewriting_it() {
        // The url key with no port key beside it: the pair is read and written
        // as a UNIT, so a url SkillKeeper did not write is not ours to replace
        // just because the port key happens to be missing.
        let existing = "mcp_oauth_callback_url = \"http://localhost:9999/callback\"\n";
        let def = oauth_def(Some("example-client"), Some(8432), vec![]);
        let out = writer_for(AgentKind::Codex)
            .upsert(existing, "remote", &def)
            .expect("upsert");
        let root: toml::Table = toml::from_str(&out.text).expect("toml");
        assert_eq!(
            root[CODEX_CALLBACK_URL_KEY].as_str(),
            Some("http://localhost:9999/callback"),
            "a global key we did not set is not ours to rewrite"
        );
        assert!(
            root.get(CODEX_CALLBACK_PORT_KEY).is_none(),
            "and the pair is not half-written either"
        );
        assert!(
            root["mcp_servers"]["remote"].is_table(),
            "the server is still written"
        );
        assert_eq!(
            out.notes,
            vec![UpsertNote::CodexCallbackConflict {
                found: "\"http://localhost:9999/callback\"".to_string(),
                wanted: 8432
            }]
        );
    }

    #[test]
    fn codex_treats_a_callback_port_written_as_a_string_as_a_conflict() {
        // A plausible hand-edit. `as_integer()` is None for it, which used to
        // read as "no existing value" and silently overwrite the key.
        let existing = "mcp_oauth_callback_port = \"8432\"\n";
        let def = oauth_def(Some("example-client"), Some(8432), vec![]);
        let out = writer_for(AgentKind::Codex)
            .upsert(existing, "remote", &def)
            .expect("upsert");
        let root: toml::Table = toml::from_str(&out.text).expect("toml");
        assert_eq!(
            root[CODEX_CALLBACK_PORT_KEY].as_str(),
            Some("8432"),
            "a global key we did not set is not ours to rewrite, whatever its type"
        );
        assert_eq!(
            out.notes,
            vec![UpsertNote::CodexCallbackConflict {
                // Quoted, so the message cannot read as "already 8432, so it
                // was left alone instead of being set to 8432".
                found: "\"8432\"".to_string(),
                wanted: 8432
            }]
        );
    }

    #[test]
    fn codex_reports_an_out_of_range_callback_port_verbatim_rather_than_clamped() {
        let existing = "mcp_oauth_callback_port = 70000\n";
        let def = oauth_def(None, Some(8432), vec![]);
        let out = writer_for(AgentKind::Codex)
            .upsert(existing, "remote", &def)
            .expect("upsert");
        assert_eq!(
            out.notes,
            vec![UpsertNote::CodexCallbackConflict {
                found: "70000".to_string(),
                wanted: 8432
            }],
            "clamping to 65535 told the user a number that is not in their file"
        );
    }

    #[test]
    fn codex_accepts_the_exact_pair_it_would_have_written() {
        let existing = "mcp_oauth_callback_port = 8432\n\
                        mcp_oauth_callback_url = \"http://localhost:8432/callback\"\n";
        let def = oauth_def(None, Some(8432), vec![]);
        let out = writer_for(AgentKind::Codex)
            .upsert(existing, "remote", &def)
            .expect("upsert");
        assert!(out.notes.is_empty());
    }

    #[test]
    fn codex_removing_a_server_leaves_the_callback_pair_in_place() {
        let def = oauth_def(Some("example-client"), Some(8432), vec![]);
        let written = writer_for(AgentKind::Codex)
            .upsert("", "remote", &def)
            .expect("upsert");
        let after = writer_for(AgentKind::Codex)
            .remove(&written.text, "remote")
            .expect("remove");
        let root: toml::Table = toml::from_str(&after).expect("toml");
        assert_eq!(root["mcp_oauth_callback_port"].as_integer(), Some(8432));
    }

    #[test]
    fn codex_accepts_a_callback_port_that_already_matches() {
        let existing = "mcp_oauth_callback_port = 8432\n";
        let def = oauth_def(None, Some(8432), vec![]);
        let out = writer_for(AgentKind::Codex)
            .upsert(existing, "remote", &def)
            .expect("upsert");
        assert!(out.notes.is_empty());
    }

    #[test]
    fn codex_never_enables_the_experimental_feature_flag_itself() {
        // Turning on an experimental feature flag in a user's config is not a
        // decision SkillKeeper makes silently; the docs tell the user to set it.
        let def = oauth_def(Some("example-client"), Some(8432), vec!["read"]);
        let out = writer_for(AgentKind::Codex)
            .upsert("", "remote", &def)
            .expect("upsert");
        let root: toml::Table = toml::from_str(&out.text).expect("toml");
        assert!(root.get("features").is_none());
        assert!(!out.text.contains("rmcp_client"));
    }

    /// A stdio def carrying an `oauth` block. Nothing upstream of the writers
    /// rejects the combination (`repo lint` only warns, `McpConfig::is_valid`
    /// checks names), so each writer has to handle it -- and used to handle it
    /// five different ways, four of them unreported: claude and cursor wrote an
    /// auth block onto a stdio server object, codex and opencode discarded it
    /// in silence, and copilot alone was skipped and reported. Now every writer
    /// drops it and says so.
    #[test]
    fn no_writer_puts_an_oauth_block_on_a_stdio_server_and_all_of_them_report_the_drop() {
        let mut def = stdio_def();
        def.oauth = Some(McpOauth {
            callback_port: Some(8432),
            client_id: Some("example-client".to_string()),
            scopes: vec!["read".to_string()],
        });
        let expected = vec![UpsertNote::DroppedField {
            field: "oauth".to_string(),
        }];

        for agent in [AgentKind::Claude, AgentKind::Cursor, AgentKind::Opencode] {
            let out = writer_for(agent)
                .upsert("", "local_1", &def)
                .expect("upsert");
            assert!(
                !out.text.contains("example-client"),
                "{agent} wrote an oauth client onto a stdio server"
            );
            assert!(
                !out.text.contains("callbackPort") && !out.text.contains("CLIENT_ID"),
                "{agent} wrote part of an auth block onto a stdio server"
            );
            assert_eq!(out.notes, expected, "{agent} dropped the block in silence");
        }

        let out = writer_for(AgentKind::Codex)
            .upsert("", "local_1", &def)
            .expect("upsert");
        assert!(!out.text.contains("example-client"));
        assert_eq!(out.notes, expected);
        // The two callback keys are GLOBAL and `remove` never takes them back
        // out, so writing them for a def whose oauth block was just dropped
        // would permanently mutate a user-wide setting nothing asked for.
        let root: toml::Table = toml::from_str(&out.text).expect("toml");
        assert!(root.get(CODEX_CALLBACK_PORT_KEY).is_none());
        assert!(root.get(CODEX_CALLBACK_URL_KEY).is_none());
    }

    #[test]
    fn codex_writes_no_callback_keys_when_the_preset_has_no_port() {
        let def = oauth_def(Some("example-client"), None, vec!["read"]);
        let out = writer_for(AgentKind::Codex)
            .upsert("", "remote", &def)
            .expect("upsert");
        let root: toml::Table = toml::from_str(&out.text).expect("toml");
        assert!(root.get(CODEX_CALLBACK_PORT_KEY).is_none());
        assert!(root.get(CODEX_CALLBACK_URL_KEY).is_none());
    }

    #[test]
    fn opencode_maps_stdio_to_local() {
        let writer = writer_for(AgentKind::Opencode);
        let text = writer.upsert("", "github_1", &stdio_def()).unwrap().text;
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
            .unwrap()
            .text;
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
        let http_text = writer
            .upsert("", "remote_http_1", &http_def())
            .unwrap()
            .text;
        let http = parse(&http_text);
        let s = &http["mcp"]["remote_http_1"];
        assert_eq!(s["type"], "remote");
        assert_eq!(s["url"], "https://example.com/mcp");
        assert_eq!(s["headers"]["Authorization"], "Bearer x");
        assert_eq!(s["enabled"], true);

        let sse_text = writer.upsert("", "remote_sse_1", &sse_def()).unwrap().text;
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
        let text = writer
            .upsert(&existing, "github_1", &stdio_def())
            .unwrap()
            .text;
        let parsed = parse(&text);
        assert_eq!(parsed["theme"], "dark");
        assert_eq!(parsed["mcp"]["user_server"]["url"], "https://user.example");
    }

    // ---- coexistence with a delimited hook region (opencode at global scope) ----

    /// A hook region shaped exactly like the one the delimited-text apply path
    /// writes into opencode's `opencode.json` (comment token `#`).
    fn hook_block(id: &str) -> String {
        wrap_region(&WrapRegionOptions {
            comment_token: "#".to_string(),
            comment_close: None,
            delimiter_id: id.to_string(),
            label: "devtools/tool:preflight".to_string(),
            version: Some("1.0.0".to_string()),
            content: "echo preflight".to_string(),
        })
    }

    /// The JSON body of `text`, as the writer itself sees it.
    fn json_body(text: &str) -> String {
        lift_regions(text).0
    }

    #[test]
    fn opencode_upsert_keeps_an_existing_hook_region_verbatim() {
        // Order 1: a global opencode skill with hooks is installed first, then a
        // global opencode MCP server. This used to fail with a raw JSON parse
        // error and could never succeed until the user edited the file by hand.
        let writer = writer_for(AgentKind::Opencode);
        let block = hook_block("a1b2c3d4e5f6");
        let existing = format!("{{\n  \"theme\": \"dark\"\n}}\n{block}\n");

        let text = writer
            .upsert(&existing, "github_1", &stdio_def())
            .unwrap()
            .text;

        assert!(text.contains(&block), "hook region lost: {text}");
        let parsed = parse(&json_body(&text));
        assert_eq!(parsed["theme"], "dark");
        assert_eq!(parsed["mcp"]["github_1"]["type"], "local");
        // The region stays on the side of the JSON it came from.
        assert!(text.trim_end().ends_with(block.lines().last().unwrap()));
    }

    #[test]
    fn opencode_remove_keeps_an_existing_hook_region_verbatim() {
        let writer = writer_for(AgentKind::Opencode);
        let block = hook_block("a1b2c3d4e5f6");
        let installed = writer.upsert("", "github_1", &stdio_def()).unwrap().text;
        let with_two = writer
            .upsert(&installed, "other_1", &http_def())
            .unwrap()
            .text;
        let with_hook = insert_region(&with_two, &block, InsertMode::Append);

        // existing_names must see through the region too: reconcile calls it, and
        // an error there made the instance vanish from the interface.
        let mut names = writer.existing_names(&with_hook).unwrap();
        names.sort();
        assert_eq!(names, vec!["github_1", "other_1"]);

        let removed = writer.remove(&with_hook, "github_1").unwrap();
        assert!(removed.contains(&block), "hook region lost: {removed}");
        let parsed = parse(&json_body(&removed));
        assert!(parsed["mcp"].get("github_1").is_none());
        assert!(parsed["mcp"].get("other_1").is_some());

        // A no-op removal returns the text (region included) unchanged.
        assert_eq!(
            writer.remove(&with_hook, "does_not_exist").unwrap(),
            with_hook
        );
    }

    #[test]
    fn json_writers_read_a_region_only_file_as_an_empty_document() {
        // A file that holds nothing but our region carries no JSON document, so
        // it names no servers rather than erroring.
        let block = hook_block("only1only2");
        let region_only = format!("{block}\n");
        for (agent, container_key) in JSON_AGENTS
            .iter()
            .copied()
            .chain([(AgentKind::Opencode, "mcp")])
        {
            let writer = writer_for(agent);
            assert_eq!(
                writer.existing_names(&region_only).unwrap(),
                Vec::<String>::new()
            );
            assert_eq!(
                writer.remove(&region_only, "anything").unwrap(),
                region_only
            );

            let text = writer
                .upsert(&region_only, "github_1", &stdio_def())
                .unwrap()
                .text;
            assert!(text.contains(&block), "{agent:?} lost the hook region");
            let parsed = parse(&json_body(&text));
            assert!(parsed[container_key].get("github_1").is_some(), "{agent:?}");
        }
    }

    #[test]
    fn json_writers_still_reject_foreign_non_json() {
        // Only our own markers are tolerated. A hand-written JSONC comment, a
        // truncated file, or a half-mangled region must be an error rather than
        // content the writer silently rewrites away.
        let block = hook_block("f1f2f3f4");
        let half_region = block.lines().take(2).collect::<Vec<&str>>().join("\n");
        let cases = [
            "// a hand-written comment\n{\n  \"mcp\": {}\n}\n".to_string(),
            "{\n  \"mcp\": {\n".to_string(),
            format!("{{}}\n{half_region}\n"),
        ];
        let writer = writer_for(AgentKind::Opencode);
        for case in &cases {
            assert!(writer.existing_names(case).is_err(), "names: {case}");
            assert!(
                writer.upsert(case, "github_1", &stdio_def()).is_err(),
                "upsert: {case}"
            );
            assert!(writer.remove(case, "github_1").is_err(), "remove: {case}");
        }
    }

    #[test]
    fn opencode_round_trips_a_hook_region_in_both_orders() {
        let writer = writer_for(AgentKind::Opencode);
        let block = hook_block("0f0f0f0f");

        // Order 1: hook region first (it is the whole file), MCP server second.
        let hook_first = writer
            .upsert(&format!("{block}\n"), "github_1", &stdio_def())
            .unwrap()
            .text;

        // Order 2: MCP server first, then the region appended after it -- what
        // the delimited-text apply path does to an existing file -- then two more
        // MCP writes over the top.
        let mcp_first = insert_region(
            &writer.upsert("", "github_1", &stdio_def()).unwrap().text,
            &block,
            InsertMode::Append,
        );
        let mcp_first = writer
            .upsert(&mcp_first, "other_1", &http_def())
            .unwrap()
            .text;
        let mcp_first = writer.remove(&mcp_first, "other_1").unwrap();

        for text in [&hook_first, &mcp_first] {
            assert!(text.contains(&block), "hook region lost: {text}");
            assert_eq!(parse(&json_body(text))["mcp"]["github_1"]["type"], "local");
            // Idempotent: rewriting the same server changes nothing, so repeated
            // installs cannot accumulate or drift the region.
            assert_eq!(
                &writer.upsert(text, "github_1", &stdio_def()).unwrap().text,
                text
            );
        }
        // Each order keeps the region on the side it was written on.
        assert!(hook_first.starts_with(&block), "{hook_first}");
        assert!(mcp_first.trim_end().ends_with(&block), "{mcp_first}");
    }

    #[test]
    fn codex_round_trips_a_stdio_server() {
        let writer = writer_for(AgentKind::Codex);
        let text = writer.upsert("", "github_1", &stdio_def()).unwrap().text;
        assert!(text.contains("[mcp_servers.github_1]"));
        assert_eq!(writer.existing_names(&text).unwrap(), vec!["github_1"]);
        // Re-upserting the same def yields identical text.
        let again = writer.upsert(&text, "github_1", &stdio_def()).unwrap().text;
        assert_eq!(again, text);
    }

    #[test]
    fn codex_omits_args_env_when_absent() {
        let writer = writer_for(AgentKind::Codex);
        let text = writer
            .upsert("", "bare_1", &stdio_def_no_args_env())
            .unwrap()
            .text;
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
        let text = writer
            .upsert(&existing, "github_1", &stdio_def())
            .unwrap()
            .text;
        assert!(text.contains("[model]"));
        assert!(text.contains("name = \"gpt-5\""));
        assert!(text.contains("[mcp_servers.user_server]"));
        assert!(text.contains("command = \"user-defined\""));
        assert!(text.contains("[mcp_servers.github_1]"));
    }

    #[test]
    fn codex_remove_and_existing_names() {
        let writer = writer_for(AgentKind::Codex);
        let with_one = writer.upsert("", "github_1", &stdio_def()).unwrap().text;
        let with_two = writer
            .upsert(&with_one, "other_1", &stdio_def_no_args_env())
            .unwrap()
            .text;

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

    // A codex-specific http fixture: the shared `http_def()` above is reused by
    // many non-codex tests with its own url/headers, so this stays separate
    // rather than repurposing it.
    fn codex_http_def() -> McpServerDef {
        let mut headers = BTreeMap::new();
        headers.insert("X-Api-Version".to_string(), "2".to_string());
        McpServerDef {
            name: "remote".to_string(),
            transport: McpTransport::Http,
            url: Some("https://mcp.example.com/mcp".to_string()),
            headers: Some(headers),
            command: None,
            args: None,
            env: None,
            rules: None,
            oauth: None,
        }
    }

    #[test]
    fn codex_writes_an_http_server_with_its_url_and_headers() {
        let out = CodexTomlWriter
            .upsert("", "remote", &codex_http_def())
            .expect("upsert");
        let root: toml::Table = toml::from_str(&out.text).expect("valid toml");
        let server = root["mcp_servers"]["remote"]
            .as_table()
            .expect("server table");
        assert_eq!(server["url"].as_str(), Some("https://mcp.example.com/mcp"));
        assert_eq!(server["http_headers"]["X-Api-Version"].as_str(), Some("2"));
        assert!(server.get("command").is_none());
    }

    #[test]
    fn codex_supports_the_http_transport() {
        assert!(supports_transport(AgentKind::Codex, McpTransport::Http));
    }

    #[test]
    fn codex_still_rejects_sse_until_it_is_verified() {
        assert!(!supports_transport(AgentKind::Codex, McpTransport::Sse));
        let mut def = codex_http_def();
        def.transport = McpTransport::Sse;
        assert!(CodexTomlWriter.upsert("", "remote", &def).is_err());
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
            oauth: None,
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
            oauth: None,
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
    fn supports_transport_gates_codex_to_stdio_and_http() {
        assert!(supports_transport(AgentKind::Codex, McpTransport::Stdio));
        assert!(supports_transport(AgentKind::Codex, McpTransport::Http));
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
    fn only_copilot_cannot_express_an_oauth_client() {
        assert!(!supports_oauth(AgentKind::Copilot));
        for agent in [
            AgentKind::Claude,
            AgentKind::Cursor,
            AgentKind::Codex,
            AgentKind::Opencode,
        ] {
            assert!(supports_oauth(agent), "{agent:?} should support oauth");
        }
    }

    #[test]
    fn mcp_destination_resolves_project_scoped_paths() {
        let target = McpDestinationTarget {
            project_path: Some("/proj".to_string()),
            home_dir: Some("/home/user".to_string()),
        };
        assert_eq!(
            mcp_destination(AgentKind::Claude, Scope::Project, &target).unwrap(),
            McpDestination {
                path: "/proj/.mcp.json".to_string(),
                scope: Scope::Project,
            }
        );
        assert_eq!(
            mcp_destination(AgentKind::Cursor, Scope::Project, &target)
                .unwrap()
                .path,
            "/proj/.cursor/mcp.json"
        );
        assert_eq!(
            mcp_destination(AgentKind::Copilot, Scope::Project, &target)
                .unwrap()
                .path,
            "/proj/.vscode/mcp.json"
        );
        assert_eq!(
            mcp_destination(AgentKind::Opencode, Scope::Project, &target)
                .unwrap()
                .path,
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
            mcp_destination(AgentKind::Codex, Scope::Global, &target).unwrap(),
            McpDestination {
                path: "/home/user/.codex/config.toml".to_string(),
                scope: Scope::Global,
            }
        );
    }

    #[test]
    fn mcp_destination_errors_on_missing_target_field() {
        assert!(mcp_destination(
            AgentKind::Claude,
            Scope::Project,
            &McpDestinationTarget::default()
        )
        .is_err());
        assert!(mcp_destination(
            AgentKind::Codex,
            Scope::Project,
            &McpDestinationTarget::default()
        )
        .is_err());
    }

    #[test]
    fn mcp_destination_resolves_global_paths_for_every_agent() {
        let target = McpDestinationTarget {
            project_path: Some("/proj".to_string()),
            home_dir: Some("/home/user".to_string()),
        };
        let cases = [
            (AgentKind::Claude, "/home/user/.claude.json"),
            (AgentKind::Codex, "/home/user/.codex/config.toml"),
            (
                AgentKind::Copilot,
                "/home/user/.config/github-copilot/mcp-config.json",
            ),
            (AgentKind::Cursor, "/home/user/.cursor/mcp.json"),
            (
                AgentKind::Opencode,
                "/home/user/.config/opencode/opencode.json",
            ),
        ];
        for (agent, expected) in cases {
            let dest = mcp_destination(agent, Scope::Global, &target).unwrap();
            assert_eq!(dest.path, expected, "{agent:?}");
            assert_eq!(dest.scope, Scope::Global, "{agent:?}");
        }
    }

    #[test]
    fn mcp_destination_resolves_codex_at_project_scope() {
        let target = McpDestinationTarget {
            project_path: Some("/proj".to_string()),
            home_dir: Some("/home/user".to_string()),
        };
        // Codex reads a project-scoped .codex/config.toml, so a project-scope
        // request resolves under the project rather than falling back to the
        // home directory.
        let dest = mcp_destination(AgentKind::Codex, Scope::Project, &target).unwrap();
        assert_eq!(dest.path, "/proj/.codex/config.toml");
        assert_eq!(dest.scope, Scope::Project);
    }

    #[test]
    fn codex_resolves_a_project_scoped_config() {
        let target = McpDestinationTarget {
            project_path: Some("/work/app".to_string()),
            home_dir: Some("/home/u".to_string()),
        };
        let dest = mcp_destination(AgentKind::Codex, Scope::Project, &target).expect("resolve");
        assert_eq!(dest.path, "/work/app/.codex/config.toml");
        assert_eq!(dest.scope, Scope::Project);
    }

    #[test]
    fn codex_still_resolves_a_global_config() {
        let target = McpDestinationTarget {
            project_path: None,
            home_dir: Some("/home/u".to_string()),
        };
        let dest = mcp_destination(AgentKind::Codex, Scope::Global, &target).expect("resolve");
        assert_eq!(dest.path, "/home/u/.codex/config.toml");
        assert_eq!(dest.scope, Scope::Global);
    }

    #[test]
    fn codex_at_project_scope_rejects_a_blank_project_path() {
        let target = McpDestinationTarget {
            project_path: Some("   ".to_string()),
            home_dir: Some("/home/u".to_string()),
        };
        assert!(mcp_destination(AgentKind::Codex, Scope::Project, &target).is_err());
    }

    #[test]
    fn mcp_destination_global_errors_without_home_dir() {
        let target = McpDestinationTarget {
            project_path: Some("/proj".to_string()),
            home_dir: None,
        };
        let err = mcp_destination(AgentKind::Cursor, Scope::Global, &target).unwrap_err();
        assert!(err.contains("homeDir"), "unexpected message: {err}");
    }

    #[test]
    fn mcp_destination_global_errors_on_a_blank_home_dir() {
        // `HostEnv::home_dir` reports an unset HOME/USERPROFILE as `""`, and
        // every caller passes `Some(that)`. Without this guard a global install
        // resolves to the filesystem root (`/.claude.json`) and its ledger to
        // `/.claude/skills/.skmcp.yml`.
        for blank in ["", "   "] {
            let target = McpDestinationTarget {
                project_path: Some("/proj".to_string()),
                home_dir: Some(blank.to_string()),
            };
            for agent in [
                AgentKind::Claude,
                AgentKind::Codex,
                AgentKind::Copilot,
                AgentKind::Cursor,
                AgentKind::Opencode,
            ] {
                let err = mcp_destination(agent, Scope::Global, &target)
                    .expect_err("a blank home must not resolve to the filesystem root");
                assert!(err.contains("homeDir"), "unexpected message: {err}");
            }
        }
    }

    #[test]
    fn mcp_destination_project_errors_on_a_blank_project_path() {
        // The same class at project scope: an empty project path would make
        // `<proj>/.mcp.json` into `/.mcp.json`.
        let target = McpDestinationTarget {
            project_path: Some(String::new()),
            home_dir: Some("/home/user".to_string()),
        };
        let err = mcp_destination(AgentKind::Claude, Scope::Project, &target)
            .expect_err("a blank project path must not resolve to the filesystem root");
        assert!(err.contains("projectPath"), "unexpected message: {err}");
    }

    #[test]
    fn scope_defaults_to_project() {
        assert_eq!(Scope::default(), Scope::Project);
    }
}
