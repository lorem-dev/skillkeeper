# SkillKeeper

SkillKeeper is a Rust + pnpm monorepo that installs and manages "skills"
(and their "hooks") for AI coding agents -- Claude, Codex, Copilot, Cursor, and
OpenCode. It ships a clap-based CLI and a Tauri v2 + React desktop app over a
shared Rust domain core (`skillkeeper-core`). The repository is a Cargo
workspace of four crates (`skillkeeper-core`, `skillkeeper-config`,
`skillkeeper-agents`, `skillkeeper-cli`) plus the desktop app's Rust backend
(`apps/desktop/src-tauri`), alongside a pnpm workspace whose only remaining
TypeScript package is `packages/i18n` (the desktop renderer lives in
`apps/desktop/src/renderer`). The renderer's domain types are generated from the
Rust crates via ts-rs. Target platforms: Linux, macOS, Windows. All source and
documentation are ASCII-only; the only non-ASCII text lives in the localization
catalogs under `locales/` (the gettext `.po` sources for all supported
languages).
The desktop `shared/ui` kit ships a Storybook for viewing components in
isolation (`pnpm --filter @skillkeeper/desktop run storybook`); see AGENTS.md.

---

**Must read:**

- [AGENTS.md](./AGENTS.md) -- architecture, layout, gates, conventions,
  CodeGraph usage, local skills.
- [CONTRIBUTING.md](./CONTRIBUTING.md) -- commit rules, dependency license
  policy, GPG signing.
- [apps/desktop/docs/architecture.md](./apps/desktop/docs/architecture.md) --
  frontend architecture (must read before touching renderer code).

<!-- CODEGRAPH_START -->
## CodeGraph

This project has a CodeGraph MCP server (`codegraph_*` tools) configured. CodeGraph is a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

### When to prefer codegraph over native search

Use codegraph for **structural** questions — what calls what, what would break, where is X defined, what is X's signature. Use native grep/read only for **literal text** queries (string contents, comments, log messages) or after you already have a specific file open.

| Question | Tool |
|---|---|
| "Where is X defined?" / "Find symbol named X" | `codegraph_search` |
| "What calls function Y?" | `codegraph_callers` |
| "What does Y call?" | `codegraph_callees` |
| "What would break if I changed Z?" | `codegraph_impact` |
| "Show me Y's signature / source / docstring" | `codegraph_node` |
| "Give me focused context for a task/area" | `codegraph_context` |
| "Survey an unfamiliar module/topic" | `codegraph_explore` |
| "What files exist under path/" | `codegraph_files` |
| "Is the index healthy?" | `codegraph_status` |

### Rules of thumb

- **Trust codegraph results.** They come from a full AST parse. Do NOT re-verify them with grep — that's slower, less accurate, and wastes context.
- **Don't grep first** when looking up a symbol by name. `codegraph_search` is faster and returns kind + location + signature in one call.
- **Don't chain `codegraph_search` + `codegraph_node`** when you just want context — `codegraph_context` is one call.
- **`codegraph_explore` is the heavy hitter** for unfamiliar areas — it returns full source from all relevant files in one call, but is token-heavy. If your harness supports parallel subagents (e.g., Claude Code's Task tool), spawn one for explore-class questions to keep main session context clean.
- **Index lag**: the file watcher debounces ~500ms behind writes; don't re-query immediately after editing a file in the same turn.

### If `.codegraph/` doesn't exist

The MCP server returns "not initialized." Ask the user: *"I notice this project doesn't have CodeGraph initialized. Want me to run `codegraph init -i` to build the index?"*
<!-- CODEGRAPH_END -->
