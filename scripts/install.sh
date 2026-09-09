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
#   SKILLKEEPER_LIBC         Linux libc flavour: auto (default), gnu, or musl
#
# Windows users: use scripts/install.ps1 instead.
set -eu

REPO="lorem-dev/skillkeeper"
BIN="skillkeeper"
INSTALL_DIR="${SKILLKEEPER_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${SKILLKEEPER_VERSION:-latest}"
LIBC="${SKILLKEEPER_LIBC:-auto}"

# Lowest glibc the *-linux-gnu CLI can run on. It is the glibc of the runner
# image that links it in the release workflow (ubuntu-22.04 -> glibc 2.35):
# glibc versions its symbols, and a newer glibc runs older binaries but not the
# reverse, so a binary linked on 2.35 dies on an older host with
# "libc.so.6: version `GLIBC_2.34' not found" before it reaches main(). Hosts
# below the floor get the statically linked musl build instead, which has no
# libc dependency at all.
#
# Bump these together with the runner image in .github/workflows/release.yml
# and the requirements in docs/; the `check-glibc-floor` skill verifies that
# the three agree.
MIN_GLIBC_MAJOR=2
MIN_GLIBC_MINOR=35

# Initialized before anything reads them. POSIX sh has no `local`, so without
# this an inherited environment variable named `libc` or `cpu` would reach the
# Linux-only logic below -- on macOS that drove the Linux fallback branch and
# then died on an unset `cpu`.
cpu=""
libc=""

err() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

warn() {
  printf 'warning: %s\n' "$1" >&2
}

# Validated here rather than where it is used: `linux_libc` runs inside a
# command substitution, and an `err` there would exit only that subshell,
# leaving the caller to carry on with an empty answer.
case "$LIBC" in
  auto | gnu | musl) ;;
  *) err "SKILLKEEPER_LIBC must be auto, gnu or musl (got: $LIBC)" ;;
esac

# Echo the host's glibc as "major.minor", or nothing at all when this is not
# glibc (a musl distro such as Alpine, where the musl build is the only
# option anyway).
glibc_version() {
  v=""
  if command -v getconf >/dev/null 2>&1; then
    # A glibc-only variable: musl's getconf does not define it, so an empty
    # answer here is itself informative. The redirect wraps the whole pipeline,
    # not just getconf, so a host without awk cannot print at the user either.
    v="$({ getconf GNU_LIBC_VERSION | awk '{ print $NF }'; } 2>/dev/null)"
  fi
  if [ -z "$v" ] && command -v ldd >/dev/null 2>&1; then
    # Read from the whole output, not from line 1: on Debian and Ubuntu `ldd`
    # is a bash script, and a host with an unconfigured locale makes bash print
    # a setlocale warning ahead of it, which would hide both the musl marker
    # and the version. musl's ldd says "musl libc" and carries no glibc
    # version, so matching it anywhere leaves `v` empty -- the right answer.
    #
    # Every glibc ldd puts the version last on its `ldd (...) X.Y` line
    # ("ldd (Ubuntu GLIBC 2.31-0ubuntu9.9) 2.31" -> 2.31), so take that field
    # rather than the first version-shaped text on the line.
    out="$(ldd --version 2>&1 || true)"
    case "$out" in
      *musl*) : ;;
      *) v="$(printf '%s\n' "$out" | awk '/^ldd /{ print $NF; exit }')" ;;
    esac
  fi

  # Everything below compares with `-ge`, which must never be handed a
  # surprise: accept only a dotted number, and keep just the first two parts.
  case "$v" in
    *.*) ;;
    *) return 0 ;;
  esac
  major="${v%%.*}"
  minor="${v#*.}"
  minor="${minor%%.*}"
  # Each part separately -- concatenating them would let an empty component
  # ("2." -> major=2, minor="") pass and reach `test`, which answers with
  # "Illegal number" on the user's terminal. Five digits or more is likewise
  # not a glibc version and would overflow the comparison.
  for part in "$major" "$minor"; do
    case "$part" in
      '' | *[!0-9]* | ?????*) return 0 ;;
    esac
  done
  printf '%s.%s' "$major" "$minor"
}

# Echo "gnu" or "musl" for this Linux host.
linux_libc() {
  if [ "$LIBC" != "auto" ]; then
    printf '%s' "$LIBC"
    return 0
  fi

  v="$(glibc_version)"
  if [ -z "$v" ]; then
    printf 'musl'
    return 0
  fi
  major="${v%%.*}"
  minor="${v#*.}"
  if [ "$major" -gt "$MIN_GLIBC_MAJOR" ] ||
    { [ "$major" -eq "$MIN_GLIBC_MAJOR" ] && [ "$minor" -ge "$MIN_GLIBC_MINOR" ]; }; then
    printf 'gnu'
  else
    printf 'musl'
  fi
}

# The `releases/latest/download/<asset>` path always redirects to the newest
# release, so a plain download needs no API call or extra tooling.
asset_url() {
  if [ "$VERSION" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download/%s' "$REPO" "$1"
  else
    printf 'https://github.com/%s/releases/download/%s/%s' "$REPO" "$VERSION" "$1"
  fi
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
      x86_64 | amd64) cpu="x86_64" ;;
      aarch64 | arm64) cpu="aarch64" ;;
      *) err "no prebuilt CLI for Linux $arch (build from source: cargo install --path crates/skillkeeper-cli)" ;;
    esac
    # Two Linux builds ship per architecture; pick by the host's own glibc.
    libc="$(linux_libc)"
    target="${cpu}-unknown-linux-${libc}"
    ;;
  *)
    err "unsupported OS: $os (on Windows use scripts/install.ps1)"
    ;;
esac

asset="skillkeeper-cli-${target}.tar.gz"
url="$(asset_url "$asset")"

# Use whichever downloader is already installed. `http_error` reports whether a
# failure was the server answering "no such asset" as opposed to the request
# never getting there -- the fallback below must not treat a flaky network as
# proof that an asset does not exist.
if command -v curl >/dev/null 2>&1; then
  download() { curl -fsSL "$1" -o "$2"; }
  # With -f, curl exits 22 on an HTTP error response. Every other code is
  # transport (6 DNS, 7 connect, 28 timeout, ...).
  http_error() { [ "$1" = 22 ]; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -qO "$2" "$1"; }
  # wget exits 8 when the server issued an error response, 4 on a network
  # failure.
  http_error() { [ "$1" = 8 ]; }
else
  err "need curl or wget on PATH to download the release"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

printf 'Downloading %s ...\n' "$asset"
# `|| rc=$?` rather than `if ! download`: `!` would make the status inside the
# branch 0, and the branch needs the real code to tell 404 from a dead network.
rc=0
download "$url" "$tmp/$asset" || rc=$?
if [ "$rc" -ne 0 ]; then
  # Releases cut before the musl builds existed carry only the gnu archive, and
  # SKILLKEEPER_VERSION can still pin one. Fall back to it rather than failing
  # outright -- but say plainly that it may not start here, so a GLIBC error a
  # moment later is not a mystery. Only on a genuine HTTP error, and never when
  # the flavour was named explicitly: that choice deserves a hard failure.
  if [ "$libc" = "musl" ] && [ "$LIBC" = "auto" ] && http_error "$rc"; then
    # "could not be fetched", not "is not in this release": the codes checked
    # above cover every HTTP error, so this is usually a missing asset on an
    # older release but can also be a 5xx or a rate limit.
    warn "$asset could not be fetched; falling back to the glibc build"
    warn "it needs glibc ${MIN_GLIBC_MAJOR}.${MIN_GLIBC_MINOR} or newer and may not run on this host"
    asset="skillkeeper-cli-${cpu}-unknown-linux-gnu.tar.gz"
    url="$(asset_url "$asset")"
    # The gnu archive is what is being installed from here on, so the smoke run
    # at the end must give the GLIBC hint. Without this it stayed "musl" and
    # suppressed the hint in the one case it exists for.
    libc="gnu"
    printf 'Downloading %s ...\n' "$asset"
    download "$url" "$tmp/$asset" || err "download failed: $url"
  else
    err "download failed: $url"
  fi
fi

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
# A binary that cannot start says so here, in the shape of a linker error that
# reads like a corrupt download. Name the actual remedy instead of leaving the
# reader with "GLIBC_2.34 not found".
if ! "$INSTALL_DIR/$BIN" version; then
  printf '\n'
  warn "the binary was installed but did not run (see the output above)"
  if [ "$libc" = "gnu" ]; then
    warn "if that mentions GLIBC, this host is older than glibc ${MIN_GLIBC_MAJOR}.${MIN_GLIBC_MINOR};"
    warn "reinstall the statically linked build with SKILLKEEPER_LIBC=musl set"
  fi
  # Exit non-zero: a binary that cannot start is a failed install, and
  # `curl ... | sh && next-step` must not proceed as though it worked.
  exit 1
fi
