//! `skillkeeper version` -- print the binary name and version.
//!
//! Prints the same string as the `-V` / `-v` / `--version` flags (which clap
//! handles during parsing), so the subcommand and the flags agree.

use std::io::Write;

use crate::error::CliError;

/// Write `skillkeeper <version>` to `out`. Always succeeds with exit code 0.
pub fn run(out: &mut dyn Write) -> Result<i32, CliError> {
    writeln!(out, "skillkeeper {}", env!("CARGO_PKG_VERSION"))?;
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prints_name_and_version() {
        let mut out = Vec::new();
        let code = run(&mut out).unwrap();
        assert_eq!(code, 0);
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text, format!("skillkeeper {}\n", env!("CARGO_PKG_VERSION")));
    }
}
