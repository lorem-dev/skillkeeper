#!/bin/sh
# Regenerate the PPK test fixtures in this directory using puttygen.
#
# Usage: ./regenerate.sh (from any directory -- paths resolve relative to
# this script's own location).
#
# Requires puttygen (the PuTTY key generator) on PATH, e.g.
# `brew install putty` on macOS, or the `putty-tools` package on
# Debian/Ubuntu. Tested against puttygen 0.84.
#
# Rewrites every *.ppk and *.openssh fixture in this directory in place.
# Later tasks' tests pin expected values to the currently committed
# fixtures, so after confirming this script still works, restore them
# with (from the repository root):
#   git checkout -- apps/desktop/src-tauri/src/app/ppk/testdata
set -e

script_dir=$(cd "$(dirname "$0")" && pwd)
cd "$script_dir"

if ! command -v puttygen >/dev/null 2>&1; then
    echo "regenerate.sh: puttygen not found on PATH" >&2
    exit 1
fi

passfile=$(mktemp)
emptyfile=$(mktemp)
cleanup() {
    rm -f "$passfile" "$emptyfile"
}
trap cleanup EXIT INT TERM

printf 'skillkeeper-test' > "$passfile"
: > "$emptyfile"

# name type bits version enc|plain
gen() {
    name=$1 type=$2 bits=$3 ver=$4 enc=$5

    if [ "$enc" = "enc" ]; then
        pf=$passfile
    else
        pf=$emptyfile
    fi

    # puttygen 0.84 prompts interactively for a passphrase unless
    # --new-passphrase is given, even when the key ends up unencrypted --
    # it does not default to "no passphrase" when the flag is simply
    # omitted. So every invocation passes it; the empty file yields
    # "Encryption: none" in the written key. Redirecting stdin from
    # /dev/null turns any other unexpected prompt into a hard failure
    # instead of a silent hang.
    if [ -n "$bits" ]; then
        puttygen -t "$type" -b "$bits" -C "skillkeeper-test" \
            --ppk-param version="$ver" --new-passphrase "$pf" \
            -o "$name.ppk" < /dev/null
    else
        puttygen -t "$type" -C "skillkeeper-test" \
            --ppk-param version="$ver" --new-passphrase "$pf" \
            -o "$name.ppk" < /dev/null
    fi

    if [ "$enc" = "enc" ]; then
        puttygen "$name.ppk" -O private-openssh-new \
            --old-passphrase "$passfile" -o "$name.openssh" < /dev/null
    else
        puttygen "$name.ppk" -O private-openssh-new \
            -o "$name.openssh" < /dev/null
    fi
}

gen ed25519-v3-enc   ed25519 ""   3 enc
gen ed25519-v3-plain ed25519 ""   3 plain
gen ed25519-v2-enc   ed25519 ""   2 enc
gen ed25519-v2-plain ed25519 ""   2 plain
gen rsa-v3-enc       rsa     2048 3 enc
gen rsa-v2-enc       rsa     2048 2 enc
gen ecdsa-v3-enc     ecdsa   256  3 enc
gen ecdsa-v3-plain   ecdsa   256  3 plain
gen ecdsa-v3-p384    ecdsa   384  3 enc
gen ecdsa-v3-p521    ecdsa   521  3 enc

# DSA is a rejection fixture only: puttygen does generate it (with a
# "keys shorter than 2048 bits are probably not secure" warning), but no
# test needs an OpenSSH form of it, so that sibling is removed again.
gen dsa-v2-plain     dsa     1024 2 plain
rm -f dsa-v2-plain.openssh

# Same reasoning, encrypted: this one exists only so a test can tell "refused
# before decrypting" apart from "the passphrase happened to be wrong" -- a
# plain DSA key can't distinguish the two, since there is nothing to decrypt.
gen dsa-v2-enc       dsa     1024 2 enc
rm -f dsa-v2-enc.openssh

echo "Regenerated fixtures in $script_dir"
ls -1 -- *.ppk *.openssh
