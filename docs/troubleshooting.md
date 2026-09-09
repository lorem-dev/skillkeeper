# Troubleshooting

Fixes for common problems. If your issue is not covered here, open an issue on
the [project tracker](https://github.com/lorem-dev/skillkeeper/issues).

## Installation

### macOS: "SkillKeeper.app is damaged and can't be opened"

macOS Gatekeeper shows this when it cannot verify the app's signature and the
download carries the `com.apple.quarantine` attribute a browser attaches. The
file is not actually corrupt: the current macOS bundles are not yet signed with
an Apple Developer ID or notarized, so a quarantined copy is rejected outright.

Remove the quarantine attribute, then open the app normally (adjust the path if
the app is not in `/Applications`):

```shell
xattr -dr com.apple.quarantine /Applications/SkillKeeper.app
```

You can confirm the attribute was the cause with:

```shell
xattr -l /Applications/SkillKeeper.app | grep quarantine
```

On Apple Silicon, if the app still will not open after clearing quarantine (an
unsigned binary needs at least an ad-hoc signature), re-sign it locally and
clear quarantine again:

```shell
codesign --force --deep --sign - /Applications/SkillKeeper.app
xattr -dr com.apple.quarantine /Applications/SkillKeeper.app
```

### The `skillkeeper` CLI is missing after installing the desktop app

The desktop bundle (dmg/`.app`, deb/AppImage, nsis/msi) ships the GUI only -- it
does not place a `skillkeeper` command on your PATH. The CLI is installed
separately. This applies to every platform, macOS included.

Use the install script -- it detects your platform, downloads the matching CLI
archive from the latest release, and adds the binary to your PATH.

macOS / Linux:

```shell
curl -fsSL https://raw.githubusercontent.com/lorem-dev/skillkeeper/main/scripts/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/lorem-dev/skillkeeper/main/scripts/install.ps1 | iex
```

Or build it from the workspace with cargo:

```shell
cargo install --path crates/skillkeeper-cli   # installs to ~/.cargo/bin
# or: cargo build --release -p skillkeeper-cli (binary at target/release/skillkeeper)
```

Make sure the install directory is on your PATH, then verify with
`skillkeeper version`. See the [CLI Reference](usage/cli.md) for the available
commands.

### Linux: "version `GLIBC_2.34' not found" when running skillkeeper

```
/home/you/.local/bin/skillkeeper: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34' not found (required by /home/you/.local/bin/skillkeeper)
```

The install worked and the binary is on disk; it cannot start. The glibc build
of the CLI is linked against glibc 2.35, and a newer glibc runs older binaries
but not the reverse, so it needs 2.35 or newer. Nothing is corrupt and
reinstalling changes nothing.

Use the statically linked musl build instead, which carries its own libc:

```shell
curl -fsSL https://raw.githubusercontent.com/lorem-dev/skillkeeper/main/scripts/install.sh | SKILLKEEPER_LIBC=musl sh
```

Current releases pick that build automatically, so the variable is only there to
override a wrong guess. A release older than the musl archives has no musl build
to install at all; there, build from source
(`cargo install --path crates/skillkeeper-cli`), which links against the glibc
you already have.

Upgrading glibc in place is not the fix: the distribution release pins the
version and every binary on the system links it, so the supported route is a
full distribution upgrade using that distribution's own tool (Ubuntu 20.04 to
22.04 or later, Debian 11 to 12; note that even RHEL 9 ships 2.34, below the
floor). Installing glibc from a third-party repository or building it into
`/usr` is a known way to leave userspace unusable and needing a rescue
environment. On a host you cannot upgrade, use the musl build.

The desktop app has the same floor and no musl build, because it links the
distribution's WebKitGTK.

## Skills

### An orange `!` marker on an installed skill

The skill declares a dependency that is not installed for that agent. The skill
itself is untouched: it is still installed and its files are intact. The marker
is a statement about what is on disk, not a queued change, which is why it
outranks any pending add or remove on the same row.

Click the marker to queue the missing dependencies for install, then Save to
apply. Where only some of the missing references can be installed, the marker
stays orange afterwards -- part of it was repaired, part of it cannot be.

The marker is not always clickable. When none of the skill's missing
dependencies exists in any repository there is nothing to install, so the badge
drops to its non-interactive form and the tooltip explains the state without
offering a repair. Fix that at the source: the reference is wrong, or the skill
it names is not published. Run
[`repo lint`](usage/cli.md#repo-lint) against the repository to see which it is.
