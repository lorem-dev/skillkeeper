# Getting Started

## Prerequisites

- `git` on your PATH. SkillKeeper invokes the system `git` binary directly and
  relies on your existing ssh-agent, SSH config, and Git LFS installation.
- `git-lfs` if any repository you add uses Git LFS (SkillKeeper reports a clear
  error when LFS is required but absent).
- To build from source: a Rust toolchain (the pinned stable is installed
  automatically by rustup from `rust-toolchain.toml` on first `cargo` build).
  Node.js 22.13+ and pnpm 11 are only needed to build the desktop app's
  renderer, not the CLI.

## Installation

SkillKeeper ships two front ends over the same core:

- **Desktop app** -- a platform bundle (dmg/`.app`, deb/AppImage, nsis/msi)
  published with every
  [release](https://github.com/lorem-dev/skillkeeper/releases/latest). Download
  it and run the installer.
- **CLI** (`skillkeeper`) -- a standalone binary. Install it with the one-line
  script below (recommended), or build it from source.

### CLI: install script

The script detects your platform, downloads the matching `skillkeeper-cli`
archive from the latest release, unpacks it, installs the binary, and adds it to
your PATH. It uses only tools already on your system (nothing to install first).

macOS and Linux:

```
curl -fsSL https://raw.githubusercontent.com/lorem-dev/skillkeeper/main/scripts/install.sh | sh
```

Windows (PowerShell):

```
irm https://raw.githubusercontent.com/lorem-dev/skillkeeper/main/scripts/install.ps1 | iex
```

Override the install directory with `SKILLKEEPER_INSTALL_DIR`, or pin a specific
release with `SKILLKEEPER_VERSION` (for example `v0.1.1`).

### CLI: build from source

The `skillkeeper` CLI is a Rust binary in this workspace. Build it with cargo:

```
cargo build --release -p skillkeeper-cli
```

The binary is written to `target/release/skillkeeper`. Or run it directly during
development:

```
cargo run -p skillkeeper-cli -- --version
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

Install a skill into the current project. Without `--agent` it installs for
every agent enabled in your config; pass `--agent` to target just one:

```
skillkeeper skill install <id>
skillkeeper skill install <id> --agent claude
```

`<id>` may be a full `group/name` (or bare `name`), or any unique prefix of one:
`skillkeeper skill install ab` resolves to `abba` when it is the only skill whose
id starts with `ab` (Docker-container-id style). The same shorthand works for
every command that takes a skill id.

Install globally (machine-wide, not tied to a project):

```
skillkeeper skill install <id> --global
```

By default hooks are **not** installed. To install hooks alongside the skill
body you must opt in explicitly (see [Skills and Hooks](usage/skills-and-hooks.md)
for what hooks are and why they require a separate flag):

```
skillkeeper skill install <id> --allow-hooks
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
application-data directory. See [Configuration](usage/configuration.md) for all
options. Open the file in your editor:

```
skillkeeper config edit
```

Print the config file path:

```
skillkeeper config path
```
