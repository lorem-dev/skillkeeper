# Repositories

## Overview

A repository is any Git remote that contains one or more skills. SkillKeeper
clones it locally, resolves the skills it contains, and tracks it for updates.

Repository record fields: `id`, `name`, `url`, `kind` (github, bitbucket, or
generic), `transport` (ssh or https), `lfs` (whether Git LFS is required),
`localPath`, and `lastFetched`.

## Adding and managing repositories

```
skillkeeper repo add <url>
skillkeeper repo remove <id>
skillkeeper repo list
skillkeeper repo update [--all | <id>]
```

`repo add` clones the repository using the system `git` binary and resolves
skills. `repo update` fetches from the remote and reports which repositories
and skills can be updated; it does not modify any installed skills automatically.

## SSH transport and private repositories

SkillKeeper supports SSH transport for private GitHub and Bitbucket
repositories. Key material and passphrases are handled by the user's
ssh-agent. SkillKeeper never reads private keys.

Example SSH URL:

```
skillkeeper repo add git@github.com:example/private-skills.git
```

Make sure your ssh-agent has the relevant key loaded before running this
command. SkillKeeper does not prompt for passphrases.

## Git LFS

If a repository declares Git LFS usage, SkillKeeper runs `git lfs` steps
during clone and fetch. If the `git-lfs` client is absent, SkillKeeper reports
a clear, actionable error rather than silently producing an incomplete checkout.

A preflight check reports whether `git` and (when needed) `git lfs` are
installed before any network operation.

## How Git is invoked

SkillKeeper invokes the system `git` binary via `child_process.execFile` with
argument arrays only - no shell string interpolation. This design:

- Reuses the user's existing SSH config, ssh-agent, and Git LFS setup.
- Keeps credential handling out of the application.
- Prevents shell injection.
- Reduces the dependency and attack surface compared to a Node Git library.

Supported operations: `clone` (with `--filter` friendliness), `fetch`,
`pull --ff-only`, and rev parsing.

## Update detection

SkillKeeper uses two levels of update detection, matching repositories and
skills separately:

**Repository level:** fetch and compare the tracked remote ref to the local
ref. If they differ, the repository "can be updated."

**Skill level:** compare the hash of each resolved skill's files in the working
tree against the installed `InstallManifest`. A skill "can be updated" when its
source content hash differs from what is installed.

This distinction matters: a repository may have new commits without any of the
skills you have installed changing, or a skill's files may have changed without
the overall repository ref moving (for example after a force-push that lands at
the same ref).

## Update operations

Update operations are selective:

- Updating one skill updates only that skill across every agent target where it
  is installed.
- Updating a repository can update all of its skills or a chosen subset.
- Repository fetch checks are read-only and do not modify any installs.

```
skillkeeper skill update <id>
skillkeeper repo update <id>
skillkeeper repo update --all
```

## Update modes

By default, SkillKeeper checks for updates on demand only. The `updates`
section of `config.yaml` controls this behavior. See
[Configuration](configuration.md) for details.
