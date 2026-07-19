# Agents

## Supported agents

SkillKeeper supports five agents in v1: Claude, Codex, Copilot, Cursor, and
OpenCode. Agents are extensible via an adapter registry; a new agent is added by
building an `AgentAdapter` and registering it under its `AgentKind`.

## Adapter model

Each agent is an `AgentAdapter` (a value type in the `skillkeeper-agents`
crate): a struct holding the agent's per-path logic, built either by the
`make_adapter` factory from an `AdapterSpec` or, for Claude, hand-written. Every
filesystem-backed method takes the `FsPort`/`HostEnv` ports explicitly and
returns a `PortResult`:

```rust
pub struct AgentAdapter {
    pub kind: AgentKind,
    pub hook_support: Option<HookCapability>,
    // ...per-agent closures, invoked through the methods below.
}

impl AgentAdapter {
    pub fn is_available(&self, fs: &dyn FsPort, env: &dyn HostEnv) -> PortResult<bool>;
    pub fn destination_root(&self, target: &AgentTarget, env: &dyn HostEnv) -> PortResult<String>;
    pub fn guidance_file(&self, fs: &dyn FsPort, target: &AgentTarget, env: &dyn HostEnv) -> PortResult<String>;
    pub fn discover_installed(&self, fs: &dyn FsPort, target: &AgentTarget, env: &dyn HostEnv) -> PortResult<Vec<DiscoveredSkill>>;
}
```

`destination_root` returns the directory where the agent expects to find skills
for a given target (project-scoped or global). `discover_installed` returns
skills present in that location that SkillKeeper did not install (external
skills). `hook_support` is `None` for agents that do not accept hooks.

`HookCapability` declares the agent's hook strategy (`delimited-text`,
`json-merge`, or `file`), a `resolve_target_file` closure that returns the
config file to edit, and (for `delimited-text`) the comment token(s). The
install engine uses this to drive hook installs for every agent without knowing
the agent's concrete path logic.

The `AdapterRegistry` is the only place that enumerates concrete agents; each is
registered by its `AgentKind`. New agents are added by supplying a new
`AdapterSpec`; no existing code needs to change.

## Agent scopes

Every install targets an `AgentTarget`, which is a `(agent, scope)` pair:

- `project` scope - skill files are installed into a directory inside the
  tracked project. The install is bound to that project directory.
- `global` scope - skill files are installed machine-wide, not tied to any
  single project.

## Claude

Claude is the reference adapter and supports **both skills and hooks**.

**Skills:**
- Project scope: `<project>/.claude/skills/<name>/`
- Global scope: `~/.claude/skills/<name>/`

**Hooks:**
- Strategy: `json-merge`
- Target file: `<project>/.claude/settings.json` (project scope), or
  `.claude/settings.local.json` (project-local), or `~/.claude/settings.json`
  (global scope).
- Each installed hook entry is merged under the `hooks` key in the appropriate
  `settings.json` and tagged with a `_skillkeeper` ownership marker carrying
  the skill and hook identity plus a `markerId`. This lets verify detect drift
  and uninstall remove exactly the owned entry without touching user-managed
  hook entries.

**External discovery:** Skills already present under the Claude skills
locations that SkillKeeper did not install are shown as external skills and
may be removed.

## Codex, Copilot, Cursor, OpenCode

These four adapters are complete implementations of the `AgentAdapter`
interface with their own path resolution and hook support logic isolated to
`destinationRoot`, `discoverInstalled`, and `hookSupport`. Each carries its
own focused tests.

Where an agent's exact on-disk layout needs confirmation during development,
the adapter is structured so only its path-resolution and `hookSupport`
members change - no consumers need updating.

## Per-skill management surface

For each installed skill, SkillKeeper exposes (in both the CLI and the desktop
app):

- Name, version (if any), description (if any).
- Source repository information (if installed from a repository).
- The set of agents the skill is installed for.
- "Open skill folder" action.
- "Open in IDE" action (default editor configurable; VS Code when present).
- "Update to latest" action (per skill, across all targets).
- Per-agent install/uninstall management.
