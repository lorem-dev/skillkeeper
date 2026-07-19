# Repositories

See also: [Skills and Hooks](skills-and-hooks.md) (what a repository
provides), [Projects](projects.md) (where a repository's skills get
installed), and [MCP Servers](mcp.md) (a repository can also declare MCP
presets).

## Overview

A repository is any Git remote that contains one or more skills (and,
optionally, MCP server presets - see [MCP Servers](mcp.md)). SkillKeeper
clones it locally, resolves the skills it contains, and tracks it for
updates.

Repository record fields: `id`, `name`, `url`, `kind` (`github`, `bitbucket`,
or `generic` - detected from the URL), `transport` (`ssh` or `https` -
likewise detected), `lfs` (whether Git LFS is required), `localPath`,
`lastFetched`, and an optional `branch` - a user-chosen branch to track
instead of the clone's default.

## Adding and managing repositories

CLI:

```
skillkeeper repo add <url> <local-path> [--name <name>] [--lfs]
skillkeeper repo remove <id>
skillkeeper repo list
skillkeeper repo update [id] [--all]
```

`repo add` clones immediately and requires an explicit local path. The
desktop app splits this in two: adding a repository first records it (so its
card can appear right away) at an app-managed path under its own
repositories directory, then clones it as a second step; a repository whose
clone has not finished, or failed, still has a record and can be retried.
Either front end rejects an add whose URL (or, for the CLI, local path) is
already tracked.

`repo update` (CLI) or "sync" (desktop) refreshes a repository from its
remote; see "Update operations" below for how the two differ.

## Branch tracking

A repository can track a specific branch instead of the clone's default.
Setting or changing the tracked branch force-checks-out that branch in the
clone (discarding any local edits); from then on, every sync first
force-switches to the tracked branch, then force-pulls, so the clone always
ends up on that branch even if something else changed it out from under
SkillKeeper. Leaving the branch unset just means "whatever the remote's
default branch is."

## SSH transport and private repositories

SkillKeeper supports SSH transport for private GitHub and Bitbucket
repositories. Key material and passphrases are handled by the user's
ssh-agent; SkillKeeper never reads private keys. In the desktop app, a
repository's clone and sync run inside the app's own embedded terminal
session rather than silently in the background - so if the ssh-agent needs a
passphrase, the prompt surfaces there, and the app can open the terminal
automatically when input is needed. A "run ssh-add" action is available from
the same terminal to load a key into the agent. Update checks are partly
interactive: the background "check for updates" runs its **fetch** through
the same terminal-backed Git as a pull (visible, ssh-capable, and it can
prompt for an SSH passphrase); only the two `rev-parse` comparisons that
follow the fetch run through the silent Git invocation.

Example SSH URL:

```
skillkeeper repo add git@github.com:example/private-skills.git ./private-skills
```

Make sure your ssh-agent has the relevant key loaded before running this
command; the CLI has no embedded terminal, so an interactive passphrase
prompt there depends entirely on your own shell's ssh-agent integration.

## Git LFS

If a repository declares Git LFS usage, SkillKeeper runs `git lfs` steps
during clone and sync. If the `git-lfs` client is absent, SkillKeeper reports
a clear, actionable error rather than silently producing an incomplete
checkout.

## How Git is invoked

SkillKeeper invokes the system `git` binary as a subprocess with argument
arrays only - no shell string interpolation. This design:

- Reuses the user's existing SSH config, ssh-agent, and Git LFS setup.
- Keeps credential handling out of the application.
- Prevents shell injection.
- Reduces the dependency and attack surface compared to a Node Git library.

Supported operations: `clone`, `fetch`, `pull` (fast-forward only),
`forcePull` (fetch, then `reset --hard @{upstream}` plus `clean -fd`),
`checkout <branch>` (force-switch, discarding local edits), `lfsPull`,
`setRemoteUrl`, `revParse`, `currentBranch`, and `listBranches`.

## Update detection

SkillKeeper uses two levels of update detection, matching repositories and
skills separately:

**Repository level** (`repoHasUpdate`): fetch, then compare the local `HEAD`
to the tracked upstream ref (`@{upstream}`). If they differ, the repository
"can be updated." Read-only: a fetch alone never modifies the working tree.

**Skill level** (`skillHasUpdate`): compare the content hash of a resolved
skill's files in the working tree against the content hash recorded in its
`InstallManifest` (falling back to recomputing it from the manifest's file
hashes when no hash was recorded). A skill "can be updated" when the source
content differs from what is installed - a changed, added, or removed file.

This distinction matters: a repository may have new commits without any of
the skills you have installed changing, or a skill's files may change
without the tracked ref moving (for example after a force-push that lands at
the same ref).

## Update operations

The CLI and the desktop app expose different-shaped update operations over
the same core primitives:

- **CLI `repo update`** runs a plain fast-forward-only `git pull` on one
  repository or every tracked repository (`--all`); it never touches
  individual skills or their installs.
- **CLI `skill update <id>`** re-resolves one installed skill from its
  source repository and reinstalls it (optionally limited to `--agent`),
  independent of any repository update.
- **Desktop "sync"** on a repository card is the stronger operation: it
  force-switches to the tracked branch (if set), then force-pulls - fetch
  plus a hard reset to the upstream ref plus a clean of untracked files - so
  an app-managed clone always ends up byte-identical to the remote and never
  hits a merge conflict. It never modifies any already-installed skill by
  itself; it only makes new/changed skill content visible for the next
  install or update action. A repository's card also carries a background
  "check for updates" (`repoHasUpdate`) that fetches and compares refs
  without pulling, so the update indicator can appear well before the user
  chooses to sync.
- **Desktop project-mode skill updates** are chosen per project, driven by
  which installed skills are stale relative to their source repository; the
  desktop app applies them the same way it applies fresh installs (see
  [Projects](projects.md)).

## Skill availability

`listAvailableSkills` resolves the skills in every cloned repository's
working tree (the same resolution schemes described in
[Skills and Hooks](skills-and-hooks.md#skill-resolution-schemes)) for the
Skills page's browsing tree. A repository whose clone is missing, or whose
working tree fails to resolve (for example a malformed
`skillkeeper.repo.yaml`), is skipped for that listing; the others still
appear.

## Removing a repository

Removing a repository only drops its tracked record and best-effort deletes
its local clone directory. Skills already installed from it are **not**
uninstalled - they keep working, and the next reconciliation pass (see
[Skills and Hooks](skills-and-hooks.md#reconciliation)) remembers their last
known repository id rather than treating them as freshly unmanaged. They
simply stop being able to show an "update available" badge, since there is
no longer a tracked repository to compare their content hash against.

## Update modes

By default, SkillKeeper checks for updates on demand only. The `updates`
section of `config.yaml` controls this behavior. See
[Configuration](configuration.md) for details.
