# Agents

## Supported agents

SkillKeeper supports five agents in v1: Claude, Codex, Copilot, Cursor, and
OpenCode. Agents are extensible via a module registry; new agents are added as
new modules implementing `AgentAdapter` and registering themselves.

## Adapter model

Each agent is implemented as an `AgentAdapter`:

```ts
interface AgentAdapter {
  readonly kind: AgentKind;
  isAvailable(env: HostEnv): Promise<boolean>;
  destinationRoot(target: AgentTarget, env: HostEnv): Promise<string>;
  discoverInstalled(target: AgentTarget, env: HostEnv): Promise<DiscoveredSkill[]>;
  hookSupport?: HookCapability;
}
```

`destinationRoot` returns the directory where the agent expects to find
skills for a given target (project-scoped or global). `discoverInstalled`
returns skills present in that location that SkillKeeper did not install
(external skills). `hookSupport` is absent for agents that do not accept hooks.

`HookCapability` declares the agent's hook strategy (`delimited-text`,
`json-merge`, or `file`), a `resolveTargetFile` function that returns the
config file to edit, and (for `delimited-text`) the comment token. The install
engine uses this to drive hook installs for every agent without knowing the
agent's concrete type.

The registry is the only place that enumerates concrete agents. Adapters are
registered by `AgentKind` string. New agents are added as new modules; no
existing code needs to change.

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
