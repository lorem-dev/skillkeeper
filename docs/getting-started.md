# Getting Started

## Prerequisites

- Node.js 22.13 or later.
- pnpm 11 (the package manager used by this project).
- `git` on your PATH. SkillKeeper invokes the system `git` binary directly and
  relies on your existing ssh-agent, SSH config, and Git LFS installation.
- `git-lfs` if any repository you add uses Git LFS (SkillKeeper reports a clear
  error when LFS is required but absent).

## Installation

Install the CLI globally from the package registry:

```
npm install -g skillkeeper
```

Or install via pnpm:

```
pnpm add -g skillkeeper
```

Verify the installation:

```
skillkeeper --version
```

## Add a skill repository

A skill repository is any Git remote that contains one or more skills. Add one
with:

```
skillkeeper repo add <url>
```

Example with an SSH remote:

```
skillkeeper repo add git@github.com:example/my-skills.git
```

SkillKeeper clones the repository locally and resolves the skills it contains.
List the repositories you have added:

```
skillkeeper repo list
```

## Browse available skills

List the skills resolved from all added repositories:

```
skillkeeper skill list
```

Show details for a specific skill (version, description, source):

```
skillkeeper skill info <id>
```

## Install a skill

Install a skill for a specific agent into the current project:

```
skillkeeper skill install <id> --agent claude
```

Install globally (machine-wide, not tied to a project):

```
skillkeeper skill install <id> --agent claude --global
```

By default hooks are **not** installed. To install hooks alongside the skill
body you must opt in explicitly (see [Skills and Hooks](skills-and-hooks.md)
for what hooks are and why they require a separate flag):

```
skillkeeper skill install <id> --agent claude --allow-hooks
```

## Track a project

SkillKeeper can scope skill installs to a named project directory. Register
the current directory as a tracked project:

```
skillkeeper project add .
```

List tracked projects:

```
skillkeeper project list
```

## Check for updates

Run an on-demand update check across all repositories:

```
skillkeeper check
```

To check a specific repository:

```
skillkeeper check <repo-id>
```

## Verify and repair an installation

Check whether all files of an installed skill still match their recorded
hashes:

```
skillkeeper skill verify <id>
```

Restore any files that have drifted or been deleted:

```
skillkeeper skill repair <id>
```

## Configuration

SkillKeeper stores its configuration in `config.yaml` inside your OS
application-data directory. See [Configuration](configuration.md) for all
options. Open the file in your editor:

```
skillkeeper config edit
```

Print the config file path:

```
skillkeeper config path
```
