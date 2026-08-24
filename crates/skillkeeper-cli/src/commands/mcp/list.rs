//! `mcp list`.

use std::io::Write;

use skillkeeper_core::mcp::markup::{parse_description, truncate_spans, DESCRIPTION_BUDGET};

use crate::error::CliError;

use super::hints::{printable, render_spans_for_terminal, transport_str};
use super::presets::{list_presets, preset_label};
use super::McpCtx;

/// `mcp list`.
pub fn list(ctx: &McpCtx, out: &mut dyn Write, err: &mut dyn Write) -> Result<i32, CliError> {
    let presets = list_presets(ctx, err);
    if presets.is_empty() {
        writeln!(out, "No MCP presets available.")?;
        return Ok(0);
    }
    for p in &presets {
        let source = if p.origin == "manual" {
            format!("manual:{}", p.local_id.as_deref().unwrap_or(""))
        } else {
            p.remote
                .clone()
                .unwrap_or_else(|| "(unknown remote)".to_string())
        };
        writeln!(
            out,
            "{}  origin={}  type={}  source={source}",
            printable(&preset_label(p)),
            p.origin,
            transport_str(p.def.transport),
        )?;
        if let Some(description) = &p.def.description {
            let spans = truncate_spans(parse_description(description), DESCRIPTION_BUDGET);
            writeln!(out, "    {}", render_spans_for_terminal(&spans))?;
        }
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mcp::testutil::{seed_state, seeded_fs, TestApp, STATE_PATH};
    use skillkeeper_core::models::AppState;
    use skillkeeper_core::state::state::save_state;
    use skillkeeper_core::testing::MemFs;

    /// Runs the real `list` over a single repo preset whose description is
    /// `description`, and captures the outcome.
    fn run_list_with_description(description: &str) -> (i32, String, String) {
        let text = format!(
            "version: 1\nservers:\n  - name: github\n    type: stdio\n    command: npx\n    description: \"{description}\"\n"
        );
        let fs = MemFs::new().with_file("/repos/r1/mcp.yml", &text);
        let app = TestApp::new(fs);
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = list(&app.ctx(), &mut out, &mut err).unwrap();
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    #[test]
    fn list_prints_a_truncated_description_with_links_as_text_and_url() {
        // Exercised through the real `list`, so the wiring is covered, not just
        // the helper.
        let (code, out, _err) =
            run_list_with_description("See [docs](https://mcp.example.com/mcp).");
        assert_eq!(code, 0);
        assert!(
            out.contains("See docs (https://mcp.example.com/mcp)."),
            "got {out}"
        );
    }

    #[test]
    fn list_never_prints_a_control_character_a_repository_authored() {
        // `\e` and `\r` are YAML escapes, so the file itself stays printable
        // while the parsed description holds real ESC and CR bytes -- the shape
        // that let a cloned repository clear the line SkillKeeper just printed
        // and write its own text over it.
        let (code, out, _err) =
            run_list_with_description("a\\e[2K\\rSkillKeeper: everything is fine");
        assert_eq!(code, 0);
        assert!(
            !out.contains('\u{1b}'),
            "an escape byte reached the terminal: {out:?}"
        );
        assert!(
            !out.contains('\r'),
            "a carriage return reached the terminal: {out:?}"
        );
        assert!(
            out.contains("SkillKeeper: everything is fine"),
            "the rest of the text is still printed: {out}"
        );
    }

    #[test]
    fn list_truncates_an_over_long_description() {
        // Longer than DESCRIPTION_BUDGET: the full string must never reach the
        // terminal, and the cut must be marked.
        let long = "x".repeat(DESCRIPTION_BUDGET + 50);
        let (code, out, _err) = run_list_with_description(&long);
        assert_eq!(code, 0);
        assert!(
            !out.contains(&long),
            "the untruncated description must not appear: {out}"
        );
        assert!(
            out.contains("..."),
            "expected an ellipsis marking the cut: {out}"
        );
    }

    #[test]
    fn list_reports_repo_presets_and_empty() {
        let app = TestApp::new(MemFs::new());
        save_state(&app.fs, STATE_PATH, &AppState::empty()).unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        list(&app.ctx(), &mut out, &mut err).unwrap();
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("No MCP presets available."));

        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        list(&app.ctx(), &mut out, &mut err).unwrap();
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("github  origin=repo  type=stdio"));
        assert!(out.contains("git@github.com:acme/mcps.git"));
    }

    #[test]
    fn lists_a_preset_from_a_nested_group_directory() {
        // A skill three group levels down with an mcp.yml beside it: the preset
        // must be discovered and labelled by its full group path.
        let fs = seeded_fs()
            .with_file("/repos/r1/a/b/c/deep/SKILL.md", "---\nname: deep\n---\n# deep\n")
            .with_file(
                "/repos/r1/a/b/c/mcp.yml",
                "version: 1\nservers:\n  - name: deep-registry\n    type: stdio\n    command: npx\n",
            );
        let app = TestApp::new(fs);
        seed_state(&app.fs);

        let mut out = Vec::new();
        let mut err = Vec::new();
        list(&app.ctx(), &mut out, &mut err).unwrap();
        let out = String::from_utf8(out).unwrap();

        assert!(
            out.contains("a/b/c/deep-registry"),
            "expected a nested preset label, got:\n{out}"
        );
    }
}
