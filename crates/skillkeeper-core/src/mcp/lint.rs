//! Static analysis of one MCP server definition's `oauth` block.
//!
//! Three independent checks, each a [`Severity::Warning`], never an error: a
//! repository you merely CONSUME must still resolve and install when one
//! preset carries a bad auth block, the same reasoning that keeps a skill
//! dependency fault (`SK001`) from taking down an unrelated skill's install.
//! The desktop preset editor is an authoring surface and does reject the same
//! input outright, refusing to save -- that asymmetry is intended, not a gap to
//! close here. The CLI has no MCP authoring command at all (`mcp` is
//! list/install/remove/update, and `McpConfig::is_valid` checks only that a
//! manual preset's id and name are non-empty), so there is nothing there to
//! reject. What catches an `oauth` block on a `stdio` preset on the way to disk
//! is the writers: every one of them drops the block and returns an
//! `UpsertNote::DroppedField`, so it is never written and never silent.
//!
//! | code    | severity | condition                                          |
//! |---------|----------|-----------------------------------------------------|
//! | `SK015` | warning  | An `oauth` block is present on a `stdio` transport.  |
//! | `SK016` | warning  | `oauth.clientId` is present but blank.               |
//! | `SK017` | warning  | `oauth.callbackPort` is present and `0`.              |

use crate::mcp::model::{McpServerDef, McpTransport};
use crate::skills::lint::{Diagnostic, Severity};

/// Lint one MCP server definition's `oauth` block. Pure: no I/O, and no
/// knowledge of which file the definition came from -- the caller
/// ([`crate::skills::lint::lint_repository`]) fills in `file` once it knows
/// which `mcp.yml`/`mcp.yaml` this preset was read from.
///
/// The three checks are independent, so a preset that fails more than one
/// comes back with more than one diagnostic. Order is fixed regardless of
/// which fields happen to be wrong: stdio-misuse, then blank client id, then
/// zero port -- the same order the codes were assigned in, so a sorted or
/// unsorted caller sees the same sequence.
#[must_use]
pub fn lint_mcp_preset(def: &McpServerDef) -> Vec<Diagnostic> {
    let mut out = Vec::new();

    let Some(oauth) = &def.oauth else {
        return out;
    };

    if def.transport == McpTransport::Stdio {
        out.push(Diagnostic {
            code: "SK015",
            severity: Severity::Warning,
            path: None,
            file: None,
            message: format!(
                "MCP preset \"{}\" declares an oauth block on a stdio transport; oauth applies only to http and sse.",
                def.name
            ),
        });
    }

    if oauth
        .client_id
        .as_deref()
        .is_some_and(|id| id.trim().is_empty())
    {
        out.push(Diagnostic {
            code: "SK016",
            severity: Severity::Warning,
            path: None,
            file: None,
            message: format!(
                "MCP preset \"{}\" has an oauth.clientId that is blank.",
                def.name
            ),
        });
    }

    if oauth.callback_port == Some(0) {
        out.push(Diagnostic {
            code: "SK017",
            severity: Severity::Warning,
            path: None,
            file: None,
            message: format!(
                "MCP preset \"{}\" has an oauth.callbackPort of 0, which is not a usable port.",
                def.name
            ),
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::model::McpOauth;

    fn stdio_preset_with_oauth() -> McpServerDef {
        McpServerDef {
            name: "local".to_string(),
            transport: McpTransport::Stdio,
            url: None,
            headers: None,
            command: Some("cmd".to_string()),
            args: None,
            env: None,
            rules: None,
            oauth: Some(McpOauth {
                callback_port: None,
                client_id: None,
                scopes: Vec::new(),
            }),
        }
    }

    fn http_preset_with(client_id: Option<&str>, callback_port: Option<u16>) -> McpServerDef {
        McpServerDef {
            name: "remote".to_string(),
            transport: McpTransport::Http,
            url: Some("https://example.com/mcp".to_string()),
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: None,
            oauth: Some(McpOauth {
                callback_port,
                client_id: client_id.map(str::to_string),
                scopes: Vec::new(),
            }),
        }
    }

    #[test]
    fn an_oauth_block_on_a_stdio_preset_warns_without_failing_resolution() {
        let diags = lint_mcp_preset(&stdio_preset_with_oauth());
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].severity, Severity::Warning);
        assert!(diags[0].message.contains("stdio"));
    }

    #[test]
    fn a_blank_client_id_and_a_zero_port_each_warn() {
        let diags = lint_mcp_preset(&http_preset_with(Some("   "), Some(0)));
        assert_eq!(diags.len(), 2);
        assert!(diags.iter().all(|d| d.severity == Severity::Warning));
    }

    #[test]
    fn a_clean_oauth_block_produces_nothing() {
        let diags = lint_mcp_preset(&http_preset_with(Some("client-1"), Some(8432)));
        assert!(diags.is_empty());
    }

    #[test]
    fn an_absent_client_id_and_port_produce_nothing() {
        // The stdio/oauth check is orthogonal to the field-level checks:
        // an http preset with an oauth block that leaves both fields unset
        // (agent registers dynamically, chooses its own port) is not a fault.
        let diags = lint_mcp_preset(&http_preset_with(None, None));
        assert!(diags.is_empty());
    }

    #[test]
    fn no_oauth_block_produces_nothing_regardless_of_transport() {
        let mut def = stdio_preset_with_oauth();
        def.oauth = None;
        assert!(lint_mcp_preset(&def).is_empty());
    }

    #[test]
    fn all_three_faults_at_once_report_in_a_fixed_order() {
        let mut def = stdio_preset_with_oauth();
        def.oauth = Some(McpOauth {
            callback_port: Some(0),
            client_id: Some(" ".to_string()),
            scopes: Vec::new(),
        });
        let codes: Vec<&str> = lint_mcp_preset(&def).iter().map(|d| d.code).collect();
        assert_eq!(codes, vec!["SK015", "SK016", "SK017"]);
    }
}
