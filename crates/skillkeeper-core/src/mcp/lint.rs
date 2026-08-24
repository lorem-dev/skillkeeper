//! Static analysis of one MCP server definition: its `oauth` block, its
//! `description`, and its `parameters` map.
//!
//! Every check here is a [`Severity::Warning`], never an error: a repository
//! you merely CONSUME must still resolve and install when one preset carries
//! a bad auth block or a rough description, the same reasoning that keeps a
//! skill dependency fault (`SK001`) from taking down an unrelated skill's
//! install. The desktop preset editor is an authoring surface and does reject
//! some of the same input outright, refusing to save -- that asymmetry is
//! intended, not a gap to close here. The CLI has no MCP authoring command at
//! all (`mcp` is list/install/remove/update, and `McpConfig::is_valid` checks
//! only that a manual preset's id and name are non-empty), so there is
//! nothing there to reject. What catches an `oauth` block on a `stdio` preset
//! on the way to disk is the writers: every one of them drops the block and
//! returns an `UpsertNote::DroppedField`, so it is never written and never
//! silent.
//!
//! | code    | severity | condition                                                          |
//! |---------|----------|----------------------------------------------------------------------|
//! | `SK015` | warning  | An `oauth` block is present on a `stdio` transport.                 |
//! | `SK016` | warning  | `oauth.clientId` is present but blank.                              |
//! | `SK017` | warning  | `oauth.callbackPort` is present and `0`.                            |
//! | `SK018` | warning  | A description (the server's or a parameter's) exceeds `DESCRIPTION_BUDGET` visible characters and will be truncated. |
//! | `SK019` | warning  | A `parameters` entry names something no `{placeholder}` uses.      |
//! | `SK021` | warning  | A description (the server's or a parameter's) holds `[text](...)` that did not parse as a link and will show literally. |
//! | `SK022` | warning  | Two options of one parameter share the same `value`.               |
//!
//! `SK020` is deliberately unassigned. It would have flagged an empty
//! `options:` list, but all three ways of writing one (`options:` bare,
//! `options: {}`, `options: []`) deserialize to the same empty `Vec` as the
//! key being absent entirely -- see `de_options` in
//! [`crate::mcp::model`], which accepts the bare form precisely so that half
//! a key cannot drop the whole file. So the fault cannot be told apart from
//! "no options at all" once the YAML has been parsed: there is nothing left
//! in the model to lint.
//!
//! Nothing else reports it either, and nothing can: an update-time note used
//! to, but the same indistinguishability made it fire on every parameter that
//! merely carried a `description`, so it was removed (see
//! [`crate::mcp::params::migrate_option_values`]). An author who writes an
//! empty `options:` gets a select with nothing to select in it and no warning
//! anywhere. Telling the two apart needs a model that can hold "authored, and
//! empty" -- an `Option<Vec<_>>` rather than a `Vec<_>` -- which is a design
//! decision, not a lint.

use std::collections::HashSet;

use crate::mcp::model::{McpServerDef, McpTransport};
use crate::skills::lint::{Diagnostic, Severity};

/// Lint one MCP server definition: its `oauth` block, its `description`, and
/// its `parameters` map. Pure: no I/O, and no knowledge of which file the
/// definition came from -- the caller
/// ([`crate::skills::lint::lint_repository`]) fills in `file` once it knows
/// which `mcp.yml`/`mcp.yaml` this preset was read from.
///
/// The checks are independent, so a preset that fails more than one comes
/// back with more than one diagnostic. Order is fixed regardless of which
/// fields happen to be wrong: stdio-misuse, then blank client id, then zero
/// port (the same order those three codes were assigned in), then an
/// over-long description, then an unused parameter entry, then a duplicate
/// option value, then a malformed link -- the last two checks each look at
/// the server's own description and every parameter's description, server
/// first, in `parameters`' key order.
#[must_use]
pub fn lint_mcp_preset(def: &McpServerDef) -> Vec<Diagnostic> {
    let mut out = Vec::new();

    if let Some(oauth) = &def.oauth {
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
    }

    for (owner, description) in all_descriptions(def) {
        let spans = crate::mcp::markup::parse_description(description);
        if crate::mcp::markup::visible_len(&spans) > crate::mcp::markup::DESCRIPTION_BUDGET {
            out.push(Diagnostic {
                code: "SK018",
                severity: Severity::Warning,
                path: None,
                file: None,
                message: format!(
                    "MCP preset \"{}\" has {} longer than {} visible characters; it will be truncated.",
                    def.name,
                    owner.describe(),
                    crate::mcp::markup::DESCRIPTION_BUDGET
                ),
            });
        }
    }

    let used = crate::mcp::params::parse_params(def);
    for name in def.parameters.keys() {
        if !used.iter().any(|u| u == name) {
            out.push(Diagnostic {
                code: "SK019",
                severity: Severity::Warning,
                path: None,
                file: None,
                message: format!(
                    "MCP preset \"{}\" describes a parameter \"{name}\" that no placeholder uses.",
                    def.name
                ),
            });
        }
    }

    for (name, param) in &def.parameters {
        let mut seen: HashSet<&str> = HashSet::new();
        for option in &param.options {
            if !seen.insert(option.value.as_str()) {
                out.push(Diagnostic {
                    code: "SK022",
                    severity: Severity::Warning,
                    path: None,
                    file: None,
                    message: format!(
                        "MCP preset \"{}\" parameter \"{name}\" has more than one option with the value \"{}\".",
                        def.name, option.value
                    ),
                });
            }
        }
    }

    for (owner, description) in all_descriptions(def) {
        if looks_like_a_link_but_is_not(description) {
            out.push(Diagnostic {
                code: "SK021",
                severity: Severity::Warning,
                path: None,
                file: None,
                message: format!(
                    "MCP preset \"{}\" has {} containing link-like text that is not an http or https link; it will be shown literally.",
                    def.name,
                    owner.describe()
                ),
            });
        }
    }

    out
}

/// Which description a `SK018`/`SK021` diagnostic is about. An author with
/// five described parameters cannot act on a warning that names none of them,
/// so the message says which one it read.
enum DescriptionOwner<'a> {
    /// The server's own `description`.
    Server,
    /// One `parameters` entry's `description`, by parameter name.
    Parameter(&'a str),
}

impl DescriptionOwner<'_> {
    /// The message fragment naming this description, e.g. `a description` or
    /// `a description for parameter "region"`.
    fn describe(&self) -> String {
        match self {
            Self::Server => "a description".to_string(),
            Self::Parameter(name) => format!("a description for parameter \"{name}\""),
        }
    }
}

/// Every description the `SK018` and `SK021` checks in [`lint_mcp_preset`]
/// apply to, each paired with what owns it: the server's own, then each
/// parameter's, in `parameters`' key order (a `BTreeMap`, so alphabetical by
/// parameter name).
fn all_descriptions(def: &McpServerDef) -> impl Iterator<Item = (DescriptionOwner<'_>, &String)> {
    std::iter::once(def.description.as_ref())
        .flatten()
        .map(|d| (DescriptionOwner::Server, d))
        .chain(def.parameters.iter().filter_map(|(name, param)| {
            param
                .description
                .as_ref()
                .map(|d| (DescriptionOwner::Parameter(name.as_str()), d))
        }))
}

/// True when a description contains a `[...](...)` shape that
/// [`crate::mcp::markup::parse_description`] refused, so the reader will see
/// it literally.
///
/// Judged per SPAN, not over the whole list: a description holding one valid
/// link and one malformed one produces a `Link` span, so requiring every span
/// to be text let the malformed one through unreported. A surviving `](` in
/// any text span is a construct the parser declined.
fn looks_like_a_link_but_is_not(text: &str) -> bool {
    if !text.contains("](") {
        return false;
    }
    crate::mcp::markup::parse_description(text)
        .iter()
        .any(|s| match s {
            crate::mcp::markup::DescriptionSpan::Text { text } => text.contains("]("),
            crate::mcp::markup::DescriptionSpan::Link { .. } => false,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::model::{McpOauth, McpOption, McpParameter};
    use std::collections::BTreeMap;

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
            description: None,
            parameters: BTreeMap::new(),
        }
    }

    /// A minimal http-transport definition with no oauth, no description, and
    /// no parameters, for the description/parameter tests to build on with
    /// struct-update syntax.
    fn http_def() -> McpServerDef {
        McpServerDef {
            name: "remote".to_string(),
            transport: McpTransport::Http,
            url: Some("https://mcp.example.com/mcp".to_string()),
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: None,
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
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
            description: None,
            parameters: BTreeMap::new(),
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

    #[test]
    fn an_over_long_description_warns_that_it_will_be_truncated() {
        let def = McpServerDef {
            description: Some("x".repeat(129)),
            ..http_def()
        };
        let d = lint_mcp_preset(&def);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].code, "SK018");
        assert_eq!(d[0].severity, Severity::Warning);
    }

    #[test]
    fn a_long_url_does_not_count_toward_the_budget() {
        let long = format!("[ok](https://mcp.example.com/{})", "p".repeat(400));
        let def = McpServerDef {
            description: Some(long),
            ..http_def()
        };
        assert!(
            lint_mcp_preset(&def).is_empty(),
            "only visible characters count"
        );
    }

    #[test]
    fn an_over_long_parameter_description_also_warns() {
        let mut parameters = BTreeMap::new();
        parameters.insert(
            "token".to_string(),
            McpParameter {
                description: Some("y".repeat(129)),
                options: Vec::new(),
            },
        );
        let def = McpServerDef {
            url: Some("https://mcp.example.com/{token}".to_string()),
            parameters,
            ..http_def()
        };
        let codes: Vec<&str> = lint_mcp_preset(&def).iter().map(|d| d.code).collect();
        assert_eq!(codes, vec!["SK018"]);
    }

    #[test]
    fn a_parameters_entry_for_an_unused_name_warns() {
        let mut parameters = BTreeMap::new();
        parameters.insert("typo".to_string(), McpParameter::default());
        // http_def()'s url carries no placeholders, so nothing uses "typo".
        let def = McpServerDef {
            parameters,
            ..http_def()
        };
        let d = lint_mcp_preset(&def);
        assert_eq!(d.iter().map(|x| x.code).collect::<Vec<_>>(), vec!["SK019"]);
    }

    #[test]
    fn an_entry_matching_a_real_placeholder_does_not_warn() {
        let mut parameters = BTreeMap::new();
        parameters.insert("token".to_string(), McpParameter::default());
        let def = McpServerDef {
            url: Some("https://mcp.example.com/{token}".to_string()),
            parameters,
            ..http_def()
        };
        assert!(lint_mcp_preset(&def).is_empty());
    }

    #[test]
    fn an_empty_option_set_is_deliberately_not_linted() {
        let mut parameters = BTreeMap::new();
        parameters.insert(
            "token".to_string(),
            McpParameter {
                description: None,
                options: Vec::new(),
            },
        );
        let def = McpServerDef {
            url: Some("https://mcp.example.com/{token}".to_string()),
            parameters,
            ..http_def()
        };
        // Every way of writing an empty `options:` -- bare, `{}`, `[]` --
        // deserializes to an empty Vec, indistinguishable from the key being
        // absent, so the lint cannot tell them apart -- and neither can
        // anything downstream, which is why it is not reported at all -- see
        // the module header's note on SK020.
        assert!(lint_mcp_preset(&def).is_empty());
    }

    #[test]
    fn a_malformed_link_warns_that_it_will_show_literally() {
        let def = McpServerDef {
            description: Some("see [docs](javascript:alert(1))".to_string()),
            ..http_def()
        };
        let d = lint_mcp_preset(&def);
        assert_eq!(d.iter().map(|x| x.code).collect::<Vec<_>>(), vec!["SK021"]);
    }

    #[test]
    fn a_malformed_link_in_a_parameter_description_also_warns() {
        let mut parameters = BTreeMap::new();
        parameters.insert(
            "token".to_string(),
            McpParameter {
                description: Some("see [docs](javascript:alert(1))".to_string()),
                options: Vec::new(),
            },
        );
        let def = McpServerDef {
            url: Some("https://mcp.example.com/{token}".to_string()),
            parameters,
            ..http_def()
        };
        let codes: Vec<&str> = lint_mcp_preset(&def).iter().map(|d| d.code).collect();
        assert_eq!(codes, vec!["SK021"]);
    }

    /// One valid link beside a malformed one. Judging the span LIST ("every
    /// span is text") let this through: the valid link produces a `Link` span,
    /// so the malformed one beside it was never reported.
    #[test]
    fn a_malformed_link_beside_a_valid_one_still_warns() {
        let def = McpServerDef {
            description: Some(
                "see [ok](https://example.com/a) and [bad](javascript:alert(1))".to_string(),
            ),
            ..http_def()
        };
        let codes: Vec<&str> = lint_mcp_preset(&def).iter().map(|d| d.code).collect();
        assert_eq!(codes, vec!["SK021"]);
    }

    #[test]
    fn a_description_that_is_all_valid_links_warns_about_nothing() {
        let def = McpServerDef {
            description: Some(
                "see [a](https://example.com/a) and [b](https://example.com/b)".to_string(),
            ),
            ..http_def()
        };
        assert!(lint_mcp_preset(&def).is_empty());
    }

    /// An author with several described parameters has to be able to tell
    /// which description a warning is about.
    #[test]
    fn sk018_and_sk021_name_the_description_they_read() {
        let mut parameters = BTreeMap::new();
        parameters.insert(
            "region".to_string(),
            McpParameter {
                description: Some(format!("{} [bad](mailto:x@example.com)", "y".repeat(129))),
                options: Vec::new(),
            },
        );
        let def = McpServerDef {
            url: Some("https://mcp.example.com/{region}".to_string()),
            description: Some(format!("{} [bad](mailto:x@example.com)", "x".repeat(129))),
            parameters,
            ..http_def()
        };
        let named: Vec<(&str, bool)> = lint_mcp_preset(&def)
            .iter()
            .map(|d| (d.code, d.message.contains("parameter \"region\"")))
            .collect();
        // SK018 server, SK018 parameter, SK021 server, SK021 parameter -- the
        // fixed order the module header documents.
        assert_eq!(
            named,
            vec![
                ("SK018", false),
                ("SK018", true),
                ("SK021", false),
                ("SK021", true)
            ],
            "each diagnostic must say whose description it read"
        );
    }

    #[test]
    fn duplicate_option_values_within_one_parameter_warn() {
        let mut parameters = BTreeMap::new();
        parameters.insert(
            "scope".to_string(),
            McpParameter {
                description: None,
                options: vec![
                    McpOption {
                        label: "Read".to_string(),
                        value: "read".to_string(),
                    },
                    McpOption {
                        label: "Also read".to_string(),
                        value: "read".to_string(),
                    },
                ],
            },
        );
        let def = McpServerDef {
            url: Some("https://mcp.example.com/{scope}".to_string()),
            parameters,
            ..http_def()
        };
        let codes: Vec<&str> = lint_mcp_preset(&def).iter().map(|d| d.code).collect();
        assert_eq!(codes, vec!["SK022"]);
    }

    #[test]
    fn distinct_option_values_do_not_warn() {
        let mut parameters = BTreeMap::new();
        parameters.insert(
            "scope".to_string(),
            McpParameter {
                description: None,
                options: vec![
                    McpOption {
                        label: "Read".to_string(),
                        value: "read".to_string(),
                    },
                    McpOption {
                        label: "Write".to_string(),
                        value: "write".to_string(),
                    },
                ],
            },
        );
        let def = McpServerDef {
            url: Some("https://mcp.example.com/{scope}".to_string()),
            parameters,
            ..http_def()
        };
        assert!(lint_mcp_preset(&def).is_empty());
    }
}
