# Getting Started

## Prerequisites

- `git` on your PATH. SkillKeeper invokes the system `git` binary directly and
  relies on your existing ssh-agent, SSH config, and Git LFS installation.
- `git-lfs` if any repository you add uses Git LFS (SkillKeeper reports a clear
  error when LFS is required but absent).
- To build from source: a Rust toolchain (the pinned stable is installed
  automatically by rustup from `rust-toolchain.toml` on first `cargo` build).
  Node.js 24+ and pnpm 11 are only needed to build the desktop app's
  renderer, not the CLI.

## System requirements

| Platform | Requirement |
|---|---|
| Linux, CLI | Any distribution. Two builds ship: glibc (needs glibc 2.35 or newer) and static musl (needs no system libc). The install script picks one. |
| Linux, desktop app | glibc 2.35 or newer, plus WebKitGTK 4.1 and libsoup 3. No static build: the app links that stack from the distribution. |
| macOS | 11 or newer, Intel or Apple Silicon. |
| Windows | 10 or newer, x64 or arm64. |

The glibc floor is where the release binaries are linked, not a policy choice;
check yours with `ldd --version`. Building from source links against the glibc
the host already has, so its floor is the Rust toolchain's own, far lower. For a
host below the floor, see [Troubleshooting](troubleshooting.md).

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

On Linux it also reads the host's glibc and takes the static musl build when
that is below 2.35 or absent, as on Alpine. Both builds are the same CLI;
override the choice with `SKILLKEEPER_LIBC=gnu` or `SKILLKEEPER_LIBC=musl`.

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

## Updating

The desktop app checks for a new release on startup and once a day. When one
is available, a badge appears in the status bar; for a major or minor
version it also opens a dialog on its own (a patch update stays badge-only).
The dialog shows the release notes and an "Update now" button that downloads
the release in the background. Once the download is verified, a second
dialog's "Install now" quits the app and installs it: on macOS by mounting
the dmg and replacing the running app bundle; on Linux by replacing the
running AppImage in place, or handing a deb to the system installer; on
Windows by launching the downloaded installer.

A check can also be started by hand, which ignores the once-a-day interval:
from the Application updates section at the end of Settings, from the About
window, or from Check for Updates in the macOS Help menu (which opens Settings
at that section). Every check, scheduled or manual, appears in the task list
with its result, so a check that found nothing is distinguishable from one that
never ran.

If macOS refuses to replace the installed app, the dialog says so and shows the
`xattr` command that clears the block, with a button to copy it.

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

To try it against a real repository, add the
[skillkeeper-test-repo](https://github.com/lorem-dev/skillkeeper-test-repo)
fixture, which contains nine resolvable skills, hooks, and MCP presets:

```
skillkeeper repo add git@github.com:lorem-dev/skillkeeper-test-repo.git
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
every agent detected in the project directory (by its marker files, the same
detection the desktop app uses); pass `--agent` to target just one:

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

Run an on-demand update check across every tracked repository:

```
skillkeeper check
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
