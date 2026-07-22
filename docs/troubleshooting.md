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

The desktop bundle (dmg/`.app`, deb/AppImage, nsis/msi) ships the GUI only. It
does not place a `skillkeeper` command on your PATH, and the CLI is not
published as a downloadable binary -- it is built from the workspace with cargo.
This applies to every platform, macOS included.

Build the binary:

```shell
cargo build --release -p skillkeeper-cli
# result: target/release/skillkeeper
```

Or install it onto your cargo bin path so `skillkeeper` is available everywhere:

```shell
cargo install --path crates/skillkeeper-cli
```

`cargo install` writes to `~/.cargo/bin`; make sure that directory is on your
PATH. See the [CLI Reference](usage/cli.md) for the available commands, or
verify the install with `skillkeeper version`.
