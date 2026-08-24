//! `mcp:description-spans` (new; no Electron precedent).

use skillkeeper_core::mcp::markup::{
    parse_description, truncate_spans, DescriptionSpan, DESCRIPTION_BUDGET,
};

/// Parse and truncate a batch of raw MCP descriptions into spans, in the SAME
/// order as `descriptions`. Origin-agnostic: the renderer reads repo-discovered
/// presets from `AvailableMcp` and manual presets straight out of `config.yaml`
/// in its own store, so it hands both kinds of raw strings through this one
/// command rather than parsing either in TypeScript. One parser and one
/// 128-character budget, shared by every description surface -- so there is
/// exactly one way to ask, and no surface can show more than the others.
pub(super) fn description_spans(descriptions: &[String]) -> Vec<Vec<DescriptionSpan>> {
    descriptions
        .iter()
        .map(|d| truncate_spans(parse_description(d), DESCRIPTION_BUDGET))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- description_spans ----

    #[test]
    fn description_spans_preserve_input_order() {
        // Each input parses to a distinguishable text span; a reordering (e.g.
        // reversing the output) would silently mislabel every description once
        // the renderer zips this against its own parameter list.
        let inputs = vec![
            "first".to_string(),
            "second".to_string(),
            "third".to_string(),
        ];
        let out = description_spans(&inputs);
        assert_eq!(
            out,
            vec![
                vec![DescriptionSpan::Text {
                    text: "first".to_string()
                }],
                vec![DescriptionSpan::Text {
                    text: "second".to_string()
                }],
                vec![DescriptionSpan::Text {
                    text: "third".to_string()
                }],
            ]
        );
    }

    #[test]
    fn an_empty_input_list_returns_an_empty_list() {
        assert!(description_spans(&[]).is_empty());
    }

    #[test]
    fn an_empty_string_returns_an_empty_span_list_not_an_error() {
        let out = description_spans(&["".to_string()]);
        assert_eq!(out, vec![Vec::<DescriptionSpan>::new()]);
    }

    #[test]
    fn every_description_is_truncated_to_the_same_budget() {
        // The full string must never reach the renderer -- this is the one
        // place the 128-character budget is enforced, so a description longer
        // than it must come back cut (visible length is the budget plus the
        // 3-character ellipsis truncate_spans appends), exactly as the CLI's own
        // render path does.
        let long = "x".repeat(DESCRIPTION_BUDGET + 50);
        let out = description_spans(&[long]);
        assert_eq!(out.len(), 1);
        assert_eq!(
            skillkeeper_core::mcp::visible_len(&out[0]),
            DESCRIPTION_BUDGET + 3
        );
    }
}
