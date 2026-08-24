//! `mcp remove`.

use std::io::Write;

use skillkeeper_core::mcp::{parse_skmcp, remove_mcp_instance, RemoveMcpArgs};
use skillkeeper_core::models::Scope;

use crate::error::CliError;

use super::args::agent_kind;
use super::target::resolve_mcp_target;
use super::McpCtx;

/// `mcp remove <instanceName>`.
pub fn remove(
    ctx: &McpCtx,
    instance_name: &str,
    agent: &str,
    project: Option<&str>,
    global: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let Some(agent) = agent_kind(agent).filter(|a| ctx.registry.has(*a)) else {
        writeln!(err, "Unknown agent: {agent}")?;
        return Ok(1);
    };
    let scope = if global {
        Scope::Global
    } else {
        Scope::Project
    };
    let project_path = if global {
        ""
    } else {
        project.unwrap_or(ctx.cwd)
    };
    let target = resolve_mcp_target(ctx, agent, scope, project_path, project_path)?;

    if !ctx.fs.exists(&target.ledger_path)? {
        writeln!(err, "No MCP ledger found for {agent}.")?;
        return Ok(1);
    }
    let ledger = parse_skmcp(&ctx.fs.read_file(&target.ledger_path)?);
    let present = ledger
        .as_ref()
        .is_some_and(|l| l.servers.iter().any(|s| s.name == instance_name));
    if !present {
        writeln!(err, "MCP instance not found: {instance_name}")?;
        return Ok(1);
    }

    remove_mcp_instance(
        ctx.fs,
        &RemoveMcpArgs {
            agent,
            native_path: target.native_path,
            ledger_path: target.ledger_path,
            params_path: target.params_path,
            guidance_files: target.guidance_files,
            instance_name: instance_name.to_string(),
        },
    )
    .map_err(|e| CliError(e.to_string()))?;
    writeln!(out, "Removed: {instance_name} ({agent})")?;
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mcp::install::install;
    use crate::commands::mcp::testutil::{seed_state, seeded_fs, TestApp, PROJECT};
    use skillkeeper_core::ports::FsPort;

    #[test]
    fn remove_deletes_an_installed_instance() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["claude".to_string()],
            &["token=abc".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = remove(
            &app.ctx(),
            "github_1",
            "claude",
            Some(PROJECT),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Removed: github_1 (claude)"));
        let native = app.fs.read_file("/proj/.mcp.json").unwrap();
        assert!(!native.contains("github_1"));
    }

    #[test]
    fn remove_reports_missing_instance() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["claude".to_string()],
            &["token=abc".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = remove(
            &app.ctx(),
            "github_9",
            "claude",
            Some(PROJECT),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("MCP instance not found: github_9"));
    }
}
