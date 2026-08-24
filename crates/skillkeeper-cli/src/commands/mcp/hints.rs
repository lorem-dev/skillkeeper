//! Terminal-rendering helpers for the `mcp` command group: the strings and
//! hint lines the four commands print.

use skillkeeper_core::mcp::markup::{
    parse_description, truncate_spans, DescriptionSpan, DESCRIPTION_BUDGET,
};
use skillkeeper_core::mcp::{McpServerDef, McpTransport, UpsertNote};
use skillkeeper_core::models::AgentKind;

/// A transport as its wire string.
pub(super) fn transport_str(t: McpTransport) -> &'static str {
    match t {
        McpTransport::Stdio => "stdio",
        McpTransport::Http => "http",
        McpTransport::Sse => "sse",
    }
}

/// Author-supplied text with its control characters removed, for anything on
/// its way to a terminal.
///
/// A `mcp.yml` comes out of a cloned repository, so every string in it is
/// untrusted text: `\r` alone lets its author overwrite the line SkillKeeper
/// just printed, and an escape sequence can colour or reposition the reader's
/// terminal. This was applied to a description's prose, link text and URL and
/// not to a server's `name`, which `mcp list` and the ambiguous-preset error
/// print from the same file -- so the rule that had a stated reason to live at
/// one boundary was in fact enforced on part of it.
pub(super) fn printable(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).collect()
}

/// Render description spans for a terminal: a link becomes its text followed by
/// its URL in parentheses.
///
/// Control characters are dropped from everything printed -- prose, a link's
/// visible text, and its URL. A description comes out of a cloned repository's
/// `mcp.yml`, so it is untrusted text on its way to a terminal: an escape
/// sequence in it would otherwise colour, clear or reposition the reader's
/// terminal, and `\r` alone is enough to overwrite the line SkillKeeper just
/// printed with something the repository author chose. The rule lives here, at
/// the single boundary where any of this reaches a terminal, rather than at
/// each parse site -- `is_allowed_url` refuses a URL with control characters
/// too, but that guards what may become a live link in the desktop app and
/// cannot cover the prose around it.
pub(super) fn render_spans_for_terminal(spans: &[DescriptionSpan]) -> String {
    fn push_printable(out: &mut String, text: &str) {
        out.push_str(&printable(text));
    }
    let mut out = String::new();
    for span in spans {
        match span {
            DescriptionSpan::Text { text } => push_printable(&mut out, text),
            DescriptionSpan::Link { text, url } => {
                push_printable(&mut out, text);
                out.push_str(" (");
                push_printable(&mut out, url);
                out.push(')');
            }
        }
    }
    out
}

/// One indented line describing a parameter, for the two places a value is
/// asked for or refused: its `description` rendered for a terminal, then its
/// accepted option values. `None` when the parameter has neither, so a
/// parameter with no authoring metadata prints nothing extra.
///
/// Both halves exist because a CLI user has no select to look at: without the
/// accepted set they must guess wrong once to learn it, and without the
/// description they never see the prose the author wrote for exactly this
/// moment.
pub(super) fn parameter_hint(def: &McpServerDef, name: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(description) = parameter_description(def, name) {
        parts.push(description);
    }
    if let Some(accepted) = accepted_option_values(def, name) {
        parts.push(format!("Accepted: {accepted}."));
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!("  {name}: {}", parts.join(" ")))
}

/// A parameter's `description`, parsed and truncated by the one shared markup
/// implementation and rendered for a terminal. `None` when the parameter has
/// no entry, no description, or an empty one.
pub(super) fn parameter_description(def: &McpServerDef, name: &str) -> Option<String> {
    let description = def.parameters.get(name)?.description.as_deref()?;
    let spans = truncate_spans(parse_description(description), DESCRIPTION_BUDGET);
    let rendered = render_spans_for_terminal(&spans);
    if rendered.is_empty() {
        return None;
    }
    Some(rendered)
}

/// A parameter's accepted option values, comma-separated in document order.
/// `None` when the parameter has no entry or no options, i.e. accepts anything.
pub(super) fn accepted_option_values(def: &McpServerDef, name: &str) -> Option<String> {
    let parameter = def.parameters.get(name)?;
    if parameter.options.is_empty() {
        return None;
    }
    Some(
        parameter
            .options
            .iter()
            .map(|o| o.value.as_str())
            .collect::<Vec<_>>()
            .join(", "),
    )
}

/// One line for a writer note, shaped like the `Skipped ...` lines beside it:
/// what the agent could not do, and what happened instead. Printed to stdout
/// with the install it belongs to -- the install succeeded, so this is not an
/// error, but a dropped auth field must not be silent.
pub(super) fn note_line(agent: AgentKind, note: &UpsertNote) -> String {
    match note {
        UpsertNote::DroppedField { field } => {
            format!("Note {agent}: cannot express \"{field}\"; it was not written.")
        }
        UpsertNote::CodexCallbackConflict { found, wanted } => format!(
            "Note {agent}: oauth callback port is already {found}; left alone (this server asked for {wanted})."
        ),
        UpsertNote::OptionSubstituted { parameter, value } => format!(
            "Note {agent}: \"{parameter}\" no longer offers its stored value; using \"{value}\" instead."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A server's `name` is repository-authored too, and `mcp list` prints it
    /// from the same file the descriptions come from. `\r` plus an erase-line
    /// sequence lets its author overwrite the line SkillKeeper just wrote, so
    /// the whole listing can be made to say something else. The strip covered
    /// descriptions and not this.
    #[test]
    fn a_preset_name_reaches_the_terminal_without_its_control_characters() {
        let hostile = "safe\r\u{1b}[2KFAKE: everything is fine";
        let cleaned = printable(hostile);
        assert!(
            !cleaned.chars().any(char::is_control),
            "no control character may survive: {cleaned:?}"
        );
        assert_eq!(cleaned, "safe[2KFAKE: everything is fine");
    }

    /// `mcp.yml` is repository-authored text on its way to a terminal. The
    /// URL is already refused at parse time, but prose and a link's visible
    /// text are printed verbatim, so the strip has to sit at the rendering
    /// boundary to cover all three. The URL span here could not come from
    /// `parse_description` today -- the point is that this function does not
    /// depend on that being true.
    #[test]
    fn rendering_for_a_terminal_drops_control_characters_from_prose_link_text_and_url() {
        let spans = vec![
            DescriptionSpan::Text {
                text: "red \u{1b}[31mALERT\u{1b}[0m ".to_string(),
            },
            DescriptionSpan::Link {
                text: "do\u{1b}[2Kcs".to_string(),
                url: "https://mcp.example.com/\rmcp".to_string(),
            },
        ];
        let out = render_spans_for_terminal(&spans);
        assert!(
            !out.chars().any(char::is_control),
            "no control character may survive: {out:?}"
        );
        // What is left is inert text, printed as the characters it is: the
        // sequence is broken by the missing ESC, not hidden.
        assert_eq!(
            out,
            "red [31mALERT[0m do[2Kcs (https://mcp.example.com/mcp)"
        );
    }
}
