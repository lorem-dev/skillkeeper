# Projects

See also: [Skills and Hooks](skills-and-hooks.md) (what gets installed into
a project), [Repositories](repositories.md) (where installed skills come
from), and [MCP Servers](mcp.md) (MCP installs use the same per-project
targets).

## Overview

A project is a tracked folder on disk - nothing more. Its record is
`{ id, path, name, addedAt }`. Adding a project only stores that record;
SkillKeeper never writes anything into the folder just because it was added.
Removing a project only drops the record; the folder and every file in it
are left untouched.

Projects give the desktop app a `project` scope for skill and MCP installs -
an install "for project P, agent A" writes into a directory inside P (see
the per-agent skills-root table in
[Skills and Hooks](skills-and-hooks.md#per-agent-skills-hooks-and-guidance)),
as opposed to `global` scope, which writes into the user's home directory
and is not tied to any project.

## Adding, editing, and removing projects

Adding a project checks for a duplicate path first (the same folder cannot be
tracked twice) and then, immediately after recording it, runs both skill and
MCP reconciliation against it - so a folder that already contains
SkillKeeper-managed skills or MCP ledgers (for example, cloned from a
teammate's Git history) is adopted right away instead of waiting for the
next app-wide reconcile.

Editing a project can change its folder path and/or its display name; both
are optional per edit (an empty value keeps the current one). Editing does
not itself trigger reconciliation.

Removing a project drops its record only. Nothing on disk is touched, and
its previously recorded skill and MCP installs simply become inert - they
still exist as real files on disk, still work, and reappear if the same
folder is re-added and reconciled again.

## Per-project agent selection

A project has no single fixed "agent list" of its own. Instead, each install
independently targets `(agent, scope: 'project', projectId)`, so a project
can have skills installed for some agents and not others, and different
skills within the same project can be installed for different agent sets.
The desktop app's project view seeds its agent picker from whichever agents
are already installed for that project (`installedAgentsByProject`), so
picking up where you left off does not require re-selecting agents you
already used.

This is distinct from **agent detection**: `detectProjectAgents` scans a
handful of marker files/directories in the project folder (`CLAUDE.md` or
`.claude` for Claude, `AGENTS.md` or `.codex` for Codex, `.cursor` or
`.cursorrules` for Cursor, `.github/copilot-instructions.md` for Copilot,
`.opencode` or `opencode.json` for OpenCode) to guess which agents have ever
been used in that folder at all - a heuristic used only for the project
card's "N agents" badge, independent of which agents actually have
SkillKeeper-managed skills installed.

## Project info (card badges)

`describeProject` computes, for one project:

- **skill count** - the number of distinct skills installed across every
  agent for that project. A skill's identity for this count is
  `(sourceRepoId, group, name)`, so a skill installed for three agents still
  counts once.
- **from-repos count** - of those, how many trace back to a repository that
  is *currently* tracked (excludes unmanaged skills and skills whose source
  repository was removed).
- **agent count** - the number of agents `detectProjectAgents` found markers
  for, as described above.
- **icon** - see "Project icon" below.

## Project icon

A project can supply its own icon, resolved from a short, fixed list of
candidate files relative to the project root, in order: `icon.png`,
`icon.svg`, `.idea/icon.png`, `.idea/icon.svg`. The first candidate that
exists and passes a safety check is returned as a data URL; otherwise the
card falls back to a generated placeholder (a tile colored from a hash of
the project's name, showing its first letter).

The safety check is defence-in-depth (the renderer also only ever displays
the result through an `<img>`, which does not execute scripts or fetch
external resources from an SVG):

- Files over 1 MB are rejected outright (also guards against decompression
  bombs).
- A `.png` candidate must start with the real PNG file signature - a
  declared `.png` whose content is something else is rejected.
- A `.svg` candidate is rejected if it contains a `<script>` tag, an
  `on*=` event-handler attribute, `<foreignObject>`, a `javascript:` URL, a
  `<!DOCTYPE` or `<!ENTITY>` declaration, or an absolute/protocol-relative
  `http(s)` reference in `href`/`src` (blocking both active content and
  remote fetches at render time).

## Folder-missing handling

Because a project is just a path, that path can stop existing - the folder
gets deleted, moved, or is on a drive that is not currently mounted.
`projectExists` is the ground-truth check; the desktop app polls it for
every tracked project on startup and on a configurable interval
(`projects.checkIntervalMinutes` in `config.yaml`, 1 minute by default, 1
minute to 23 hours), and also on demand right before an action that needs
the folder (`ensureProjectAvailable`), surfacing a notification if it is
gone. The project card shows a distinct missing-folder indicator and, while
missing, offers only a remove action (edit is not useful when there is
nothing to point it at).

Reconciliation treats a missing folder as **untouched, not empty**:

- Skill reconciliation (see
  [Skills and Hooks](skills-and-hooks.md#reconciliation)) explicitly checks
  whether each tracked project's folder exists before scanning it; when it
  does not, every install manifest already recorded for that project is
  carried forward unchanged rather than scanned (and, since nothing was
  found, potentially pruned).
- MCP reconciliation has no separate central record to protect in the first
  place - the installed-MCP list is recomputed each time by reading each
  project's own `.skmcp.yml`/`.skmcp.params.yml` ledger files directly
  (there is no equivalent of the skills' persisted `InstallManifest` list).
  A missing folder simply means those ledger files cannot be read for this
  pass, so that project contributes nothing to the surviving list this time -
  nothing on disk is deleted, and the ledger is picked up again as soon as
  the folder is back.

Either way, a temporarily unreachable project (an unmounted drive, a folder
mid-move) never loses its recorded skill installs, and never has its MCP
ledger files touched.

## Reconciliation

Reconciliation is what keeps the desktop app's view of "what is installed"
honest against the filesystem. It runs at three points:

1. On app load (`loadAll`), alongside loading config, repositories, and the
   available-skill catalog.
2. After a repository sync finishes (a sync can add, remove, or change the
   skills a project's installs should be compared against).
3. After a project is added (so a folder that already has skills or MCP
   ledgers is adopted immediately, as described above).

Skill reconciliation is described in detail in
[Skills and Hooks](skills-and-hooks.md#reconciliation): it rebuilds each
project's install manifests from what is actually in each agent's skills
directory, matching skills to tracked repositories by their (normalized)
source remote, and preserving projects whose folder is currently
unreachable. MCP reconciliation prunes ledger entries whose native server
entry has disappeared from the agent's own config file, mirroring the same
"never destroy what you cannot currently verify" posture; see
[MCP Servers](mcp.md) for the ledger format it reads.

## Opening a project

A project can be opened in the OS's own file manager, or in any editor the
desktop app detects installed on the machine (offered as a list; the last
choice is remembered). Before opening, the app re-confirms the folder still
exists, so a stale card cannot silently open nothing.
