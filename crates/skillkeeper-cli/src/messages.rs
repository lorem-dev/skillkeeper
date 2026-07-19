//! English message strings for the Rust CLI.
//!
//! The TypeScript CLI resolves user-facing text through the shared i18n catalog
//! (`@skillkeeper/i18n`) plus a small CLI-only map (`packages/cli/src/messages.ts`).
//!
//! i18n decision: the Rust CLI is English-only by decision. Front-end
//! localization (German, Russian, ...) lives in the desktop app; the CLI is an
//! automation/scripting surface whose output is parsed by tooling, so a single
//! stable language is preferred over locale-dependent strings. The handful of
//! strings the ported commands need are inlined here as ASCII English, mirroring
//! the English catalog values.

/// Banner shown when one or more config sections are invalid. Mirrors the
/// English `config.invalidBanner` catalog value.
pub const CONFIG_INVALID_BANNER: &str = "Configuration has invalid sections. Defaults are in use. Run \"skillkeeper config validate\" for details.";

/// Ported from the CLI-only `cli.project.required` key in `messages.ts`.
pub const PROJECT_REQUIRED: &str = "A project-scope operation needs a project directory. Pass --project <path>, run from inside a project, or use --global.";

/// Shown when a hook install is attempted without explicit consent. Mirrors the
/// English `hooks.requireConsent` catalog value.
pub const HOOKS_REQUIRE_CONSENT: &str = "Hook installation requires explicit consent (--allow-hooks). Skill body installed; hooks skipped.";
