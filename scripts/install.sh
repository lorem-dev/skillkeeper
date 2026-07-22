#!/bin/sh
# SkillKeeper CLI installer for macOS and Linux.
#
# One-line install (nothing to download or set up first -- uses the curl/wget
# and tar already present on the system):
#
#   curl -fsSL https://raw.githubusercontent.com/lorem-dev/skillkeeper/main/scripts/install.sh | sh
#
# Environment overrides:
#   SKILLKEEPER_VERSION      release tag to install (default: latest)
#   SKILLKEEPER_INSTALL_DIR  install directory (default: $HOME/.local/bin)
#
# Windows users: use scripts/install.ps1 instead.
set -eu

REPO="lorem-dev/skillkeeper"
BIN="skillkeeper"
INSTALL_DIR="${SKILLKEEPER_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${SKILLKEEPER_VERSION:-latest}"

err() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

# Detect OS + architecture and map them to the Rust target triple used in the
# release asset names (skillkeeper-cli-<target>.tar.gz).
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin)
    case "$arch" in
      arm64 | aarch64) target="aarch64-apple-darwin" ;;
      x86_64) target="x86_64-apple-darwin" ;;
      *) err "unsupported macOS architecture: $arch" ;;
    esac
    ;;
  Linux)
    case "$arch" in
      x86_64 | amd64) target="x86_64-unknown-linux-gnu" ;;
      *) err "no prebuilt CLI for Linux $arch (build from source: cargo install --path crates/skillkeeper-cli)" ;;
    esac
    ;;
  *)
    err "unsupported OS: $os (on Windows use scripts/install.ps1)"
    ;;
esac

asset="skillkeeper-cli-${target}.tar.gz"

# The `releases/latest/download/<asset>` path always redirects to the newest
# release, so a plain download needs no API call or extra tooling.
if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

# Use whichever downloader is already installed.
if command -v curl >/dev/null 2>&1; then
  download() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -qO "$2" "$1"; }
else
  err "need curl or wget on PATH to download the release"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

printf 'Downloading %s ...\n' "$asset"
download "$url" "$tmp/$asset" || err "download failed: $url"

printf 'Extracting ...\n'
tar -xzf "$tmp/$asset" -C "$tmp" || err "failed to extract $asset"
[ -f "$tmp/$BIN" ] || err "archive did not contain the '$BIN' binary"

mkdir -p "$INSTALL_DIR"
if command -v install >/dev/null 2>&1; then
  install -m 0755 "$tmp/$BIN" "$INSTALL_DIR/$BIN"
else
  cp "$tmp/$BIN" "$INSTALL_DIR/$BIN"
  chmod 0755 "$INSTALL_DIR/$BIN"
fi
printf 'Installed %s to %s\n' "$BIN" "$INSTALL_DIR/$BIN"

# Put INSTALL_DIR on PATH by appending to the first shell profile that exists
# (only when it is not already there).
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*)
    : # already on PATH
    ;;
  *)
    added=""
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      if [ -f "$rc" ]; then
        if ! grep -qsF "$INSTALL_DIR" "$rc"; then
          printf '\n# Added by the SkillKeeper CLI installer\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$rc"
          printf 'Added %s to PATH in %s -- restart your shell to pick it up.\n' "$INSTALL_DIR" "$rc"
        fi
        added="yes"
        break
      fi
    done
    if [ -z "$added" ]; then
      printf 'Add %s to your PATH to run "%s" from anywhere.\n' "$INSTALL_DIR" "$BIN"
    fi
    ;;
esac

printf 'Done. '
"$INSTALL_DIR/$BIN" version || true
