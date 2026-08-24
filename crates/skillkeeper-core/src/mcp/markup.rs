//! Parsing and truncation for MCP `description` text.
//!
//! A description accepts exactly one markup form: `[text](http://...)` or
//! `[text](https://...)`. Everything else -- other schemes, relative URLs,
//! unbalanced brackets, an empty text or an empty URL -- stays literal text.
//! Failing to a literal is the safe direction: an unrecognized construct is
//! shown as the author typed it and can never become a live link.
//!
//! Nothing here produces HTML. The renderer maps these spans to React nodes,
//! which escape their text children by construction, so a description holding
//! `<script>` renders as those characters with no sanitizer in the path.

use serde::{Deserialize, Serialize};

/// One piece of a parsed description.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS, schemars::JsonSchema))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/"
    )
)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DescriptionSpan {
    /// Literal text, shown as-is.
    ///
    /// A STRUCT variant, not `Text(String)`: serde's internally-tagged
    /// representation cannot serialize a newtype variant wrapping a plain
    /// string, so `Text(String)` fails to compile under `#[serde(tag = ...)]`.
    /// It also gives the generated TypeScript a clean discriminated union.
    Text { text: String },
    /// A link. `text` is what the reader sees; `url` is always http or https.
    Link { text: String, url: String },
}

/// The visible length of a span list: a link contributes its text, never its
/// URL. This is the unit the 128-character budget is measured in.
#[must_use]
pub fn visible_len(spans: &[DescriptionSpan]) -> usize {
    spans
        .iter()
        .map(|s| match s {
            DescriptionSpan::Text { text } => text.chars().count(),
            DescriptionSpan::Link { text, .. } => text.chars().count(),
        })
        .sum()
}

/// True when `url` is one this project is willing to render as a live link.
///
/// The length floor is measured against the scheme that actually matched, not
/// against the longer of the two: `https://` is one character longer than
/// `http://`, so a shared floor rejected `http://a` -- a legal one-character
/// host -- and dropped the link to literal text.
///
/// Control characters are refused alongside whitespace. The CLI prints a
/// link's URL verbatim (`render_spans_for_terminal` in the CLI's `mcp`
/// command), so an author-supplied URL carrying an escape sequence would
/// otherwise reach a terminal as one.
fn is_allowed_url(url: &str) -> bool {
    let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    else {
        return false;
    };
    !rest.is_empty()
        && !url.contains('(')
        && !url.chars().any(char::is_whitespace)
        && !url.chars().any(char::is_control)
}

/// Parse `text` into spans. Never fails: anything unrecognized is literal.
#[must_use]
pub fn parse_description(text: &str) -> Vec<DescriptionSpan> {
    let mut out: Vec<DescriptionSpan> = Vec::new();
    let mut literal = String::new();
    let bytes = text.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] != b'[' {
            let ch_len = text[i..].chars().next().map_or(1, char::len_utf8);
            literal.push_str(&text[i..i + ch_len]);
            i += ch_len;
            continue;
        }
        // A candidate `[text](url)` must have `]` immediately followed by `(`
        // and a closing `)`, with a non-empty text and an allowed URL. Any
        // failure falls through and keeps the `[` as literal.
        let Some(close_bracket) = text[i..].find(']').map(|n| i + n) else {
            literal.push('[');
            i += 1;
            continue;
        };
        if text.as_bytes().get(close_bracket + 1) != Some(&b'(') {
            literal.push('[');
            i += 1;
            continue;
        }
        let Some(close_paren) = text[close_bracket + 2..]
            .find(')')
            .map(|n| close_bracket + 2 + n)
        else {
            literal.push('[');
            i += 1;
            continue;
        };
        let label = &text[i + 1..close_bracket];
        if label.contains('[') {
            // A label may not itself contain `[`: the bracket that opened this
            // candidate is not the one that matches this `]`, so the whole
            // `[...]` run is unresolved from the outer bracket's perspective.
            // Consuming it whole as literal (rather than falling back one
            // character and letting the scan retry from the inner `[`) keeps
            // the construct failing as a unit instead of surfacing the inner
            // `[label](url)` as a link the author did not write on its own.
            literal.push_str(&text[i..=close_bracket]);
            i = close_bracket + 1;
            continue;
        }
        let url = &text[close_bracket + 2..close_paren];
        if label.trim().is_empty() || !is_allowed_url(url) {
            literal.push('[');
            i += 1;
            continue;
        }
        if !literal.is_empty() {
            out.push(DescriptionSpan::Text {
                text: std::mem::take(&mut literal),
            });
        }
        out.push(DescriptionSpan::Link {
            text: label.to_string(),
            url: url.to_string(),
        });
        i = close_paren + 1;
    }

    if !literal.is_empty() {
        out.push(DescriptionSpan::Text { text: literal });
    }
    out
}

/// The visible-character budget for any description. Hard, not advisory.
pub const DESCRIPTION_BUDGET: usize = 128;

/// The marker appended when truncation actually removed something.
const ELLIPSIS: &str = "...";

/// Truncate `spans` to `budget` VISIBLE characters, appending an ellipsis only
/// when something was removed.
///
/// When the budget runs out inside a link's text, the text is cut and the link
/// is KEPT, pointing at the same URL. Dropping a link that does not fit whole
/// can swallow the only link a description has.
#[must_use]
pub fn truncate_spans(spans: Vec<DescriptionSpan>, budget: usize) -> Vec<DescriptionSpan> {
    if visible_len(&spans) <= budget {
        return spans;
    }
    let mut out: Vec<DescriptionSpan> = Vec::new();
    let mut used = 0usize;

    for span in spans {
        let remaining = budget - used;
        if remaining == 0 {
            break;
        }
        match span {
            DescriptionSpan::Text { text: t } => {
                let len = t.chars().count();
                if len <= remaining {
                    used += len;
                    out.push(DescriptionSpan::Text { text: t });
                } else {
                    let cut: String = t.chars().take(remaining).collect();
                    out.push(DescriptionSpan::Text {
                        text: format!("{cut}{ELLIPSIS}"),
                    });
                    return out;
                }
            }
            DescriptionSpan::Link { text, url } => {
                let len = text.chars().count();
                if len <= remaining {
                    used += len;
                    out.push(DescriptionSpan::Link { text, url });
                } else {
                    let cut: String = text.chars().take(remaining).collect();
                    out.push(DescriptionSpan::Link {
                        text: format!("{cut}{ELLIPSIS}"),
                        url,
                    });
                    return out;
                }
            }
        }
    }

    // The budget was consumed exactly at a span boundary and content remained.
    out.push(DescriptionSpan::Text {
        text: ELLIPSIS.to_string(),
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> DescriptionSpan {
        DescriptionSpan::Text {
            text: s.to_string(),
        }
    }
    fn link(t: &str, u: &str) -> DescriptionSpan {
        DescriptionSpan::Link {
            text: t.to_string(),
            url: u.to_string(),
        }
    }

    #[test]
    fn plain_text_is_one_span() {
        assert_eq!(parse_description("just words"), vec![text("just words")]);
    }

    #[test]
    fn a_link_splits_the_text_around_it() {
        assert_eq!(
            parse_description("see [the docs](https://example.com/d) now"),
            vec![
                text("see "),
                link("the docs", "https://example.com/d"),
                text(" now")
            ]
        );
    }

    #[test]
    fn http_and_https_are_both_accepted() {
        assert_eq!(
            parse_description("[a](http://example.com)"),
            vec![link("a", "http://example.com")]
        );
        assert_eq!(
            parse_description("[b](https://example.com)"),
            vec![link("b", "https://example.com")]
        );
    }

    /// `http://` is one character shorter than `https://`. Measuring both
    /// against the longer scheme refused a legal single-character host and
    /// silently downgraded the link to literal text.
    #[test]
    fn a_one_character_http_host_is_still_a_link() {
        assert_eq!(
            parse_description("[a](http://a)"),
            vec![link("a", "http://a")]
        );
    }

    #[test]
    fn every_other_shape_stays_literal_text() {
        // Each of these must survive as its own characters, never as a link.
        for input in [
            "[a](javascript:alert(1))",
            "[a](mailto:x@example.com)",
            "[a](file:///etc/passwd)",
            "[a](//example.com)",
            "[a](/relative/path)",
            "[a](ftp://example.com)",
            "[](https://example.com)",
            "[a]()",
            "[a](https://example.com",
            "a](https://example.com)",
            "[a] (https://example.com)",
            "[[a](https://example.com)",
            "[a](https:// )",
            "[ ](https://example.com)",
            // A scheme and nothing else. The length floor is measured against
            // the scheme that matched, so both of these must fail on their
            // own terms rather than one of them passing.
            "[a](http://)",
            "[a](https://)",
            // An ANSI escape in the URL. The CLI prints a link's URL
            // verbatim, so a control character reaching a span would reach a
            // terminal as an escape sequence.
            "[a](https://example.com/\u{1b}[31m)",
            // Distinct from the javascript:/mailto:/etc. rows above, which
            // already fail on scheme alone: this one has an allowed scheme
            // and only fails because the URL itself contains `(`.
            "[a](https://example.com/foo(bar))",
        ] {
            assert_eq!(
                parse_description(input),
                vec![text(input)],
                "input was treated as markup: {input}"
            );
        }
    }

    #[test]
    fn html_is_not_special_and_survives_verbatim() {
        // No escaping here: escaping is the renderer's job and it gets it from
        // React's text nodes. The parser must not mangle these characters.
        let input = "<script>alert(1)</script> & <b>bold</b>";
        assert_eq!(parse_description(input), vec![text(input)]);

        // The literal-copy path above never touches link formation. Pin HTML
        // surviving inside a link's own text too, so escaping is never
        // introduced there either.
        assert_eq!(
            parse_description("[<b>x</b>](https://example.com)"),
            vec![link("<b>x</b>", "https://example.com")]
        );
    }

    #[test]
    fn visible_len_counts_link_text_but_never_its_url() {
        let spans = parse_description("ab [cd](https://example.com/very/long/path) ef");
        // "ab " + "cd" + " ef" == 3 + 2 + 3
        assert_eq!(visible_len(&spans), 8);
    }

    #[test]
    fn adjacent_links_do_not_merge_or_swallow_the_gap() {
        assert_eq!(
            parse_description("[a](https://example.com/a)[b](https://example.com/b)"),
            vec![
                link("a", "https://example.com/a"),
                link("b", "https://example.com/b")
            ]
        );
    }

    #[test]
    fn a_link_glued_to_following_text_still_forms_a_link() {
        // A link immediately followed by more text with no separating space
        // is normal and common; it must not be silently dropped in favor of
        // treating the whole thing as literal.
        assert_eq!(
            parse_description("see [docs](https://example.com/d)and more"),
            vec![
                text("see "),
                link("docs", "https://example.com/d"),
                text("and more")
            ]
        );
    }

    #[test]
    fn a_url_with_a_stray_closing_paren_resolves_the_way_markdown_does() {
        // The closing `)` of the link is the FIRST one after the opening
        // `(`, exactly as CommonMark resolves this shape: a link to
        // `https://example.com/foo`, followed by the literal text `bar)`.
        // This was considered as a possible defect (a truncated, "wrong
        // target" URL) and deliberately left alone: the URL is intact and
        // unambiguous, and the trailing `)` is just more prose.
        assert_eq!(
            parse_description("[a](https://example.com/foo)bar)"),
            vec![link("a", "https://example.com/foo"), text("bar)")]
        );
    }

    #[test]
    fn a_description_within_budget_is_untouched_and_gains_no_ellipsis() {
        let spans = parse_description("short enough");
        assert_eq!(truncate_spans(spans.clone(), 128), spans);
    }

    #[test]
    fn exactly_at_the_budget_gains_no_ellipsis() {
        let s = "x".repeat(128);
        let spans = parse_description(&s);
        let out = truncate_spans(spans.clone(), 128);
        assert_eq!(
            out, spans,
            "nothing was removed, so nothing should be marked"
        );
    }

    #[test]
    fn one_over_the_budget_is_cut_and_marked() {
        let spans = parse_description(&"x".repeat(129));
        let out = truncate_spans(spans, 128);
        assert_eq!(
            visible_len(&out),
            128 + 3,
            "the ellipsis is the only addition"
        );
        match out.last().expect("a span") {
            DescriptionSpan::Text { text } => assert!(text.ends_with("..."), "got {text}"),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn a_cut_inside_a_links_text_keeps_the_link_and_shortens_its_text() {
        // 6 visible before the link, then a 10-character link text.
        let spans = parse_description("abcdef [0123456789](https://example.com/x) tail");
        let out = truncate_spans(spans, 9);
        assert_eq!(
            out,
            vec![
                DescriptionSpan::Text {
                    text: "abcdef ".to_string()
                },
                DescriptionSpan::Link {
                    text: "01...".to_string(),
                    url: "https://example.com/x".to_string()
                },
            ],
            "the link must survive with a shortened text"
        );
    }

    #[test]
    fn a_cut_one_character_into_a_link_keeps_the_link_and_marks_it() {
        // Budget 5 against "abc " (4) leaves 1, so the cut lands INSIDE the
        // link rather than at its boundary -- the boundary-exact case is the
        // test below, which is the only one that reaches the post-loop
        // ellipsis.
        let spans = parse_description("abc [de](https://example.com/x) fgh");
        let out = truncate_spans(spans, 5);
        assert_eq!(
            out,
            vec![
                DescriptionSpan::Text {
                    text: "abc ".to_string()
                },
                DescriptionSpan::Link {
                    text: "d...".to_string(),
                    url: "https://example.com/x".to_string()
                },
            ]
        );
    }

    /// The one input that exhausts the budget EXACTLY at a span boundary with
    /// content still to come, so truncation leaves the loop instead of
    /// returning from inside it and the trailing ellipsis is its own span.
    /// Deleting that post-loop push passes every other test in this file.
    #[test]
    fn a_cut_exactly_at_a_link_boundary_drops_nothing_and_marks_the_remainder() {
        // "abc " (4) + link text "de" (2) == 6, the whole budget, with " fgh"
        // left over.
        let spans = parse_description("abc [de](https://example.com/x) fgh");
        let out = truncate_spans(spans, 6);
        assert_eq!(
            out,
            vec![
                DescriptionSpan::Text {
                    text: "abc ".to_string()
                },
                DescriptionSpan::Link {
                    text: "de".to_string(),
                    url: "https://example.com/x".to_string()
                },
                DescriptionSpan::Text {
                    text: "...".to_string()
                },
            ],
            "the link survives whole and the dropped remainder is still marked"
        );
    }

    /// The boundary case's twin: the budget is consumed exactly at a span
    /// boundary and NOTHING remains, so no ellipsis may appear. Without this,
    /// a fix for the case above could mark a description that lost nothing.
    #[test]
    fn a_cut_exactly_at_the_end_marks_nothing() {
        let spans = parse_description("abc [de](https://example.com/x)");
        assert_eq!(
            truncate_spans(spans.clone(), 6),
            spans,
            "nothing was removed, so nothing may be marked"
        );
    }

    #[test]
    fn the_url_never_counts_toward_the_budget() {
        // A 4-character visible description behind a very long URL fits in 4.
        let spans = parse_description(
            "[abcd](https://example.com/an/extremely/long/path/that/is/irrelevant)",
        );
        assert_eq!(truncate_spans(spans.clone(), 4), spans);
    }

    #[test]
    fn the_budget_constant_is_the_specified_one() {
        assert_eq!(DESCRIPTION_BUDGET, 128);
    }

    #[test]
    fn multi_byte_characters_count_as_one_and_are_never_sliced_in_half() {
        // Each "e" here is actually "e with acute" (2 bytes in UTF-8), so a
        // byte-based cut would land mid-character. 5 characters, budget 3.
        let s = "\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}";
        let spans = parse_description(s);
        let out = truncate_spans(spans, 3);
        assert_eq!(
            visible_len(&out),
            3 + 3,
            "3 visible chars kept, plus the ellipsis"
        );
        match out.last().expect("a span") {
            DescriptionSpan::Text { text } => {
                assert!(text.starts_with("\u{e9}\u{e9}\u{e9}"), "got {text}");
                assert!(text.ends_with("..."), "got {text}");
            }
            other => panic!("expected text, got {other:?}"),
        }
    }
}
