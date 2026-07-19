# Releasing

## Release pipeline

Releases are driven by GitHub Actions (`.github/workflows/release.yml`). The
pipeline runs on a version tag (`v*`) and proceeds in this order:

1. Verify the tag matches every version (`scripts/check-version.mjs` checks the
   `package.json` files, `tauri.conf.json`, and the Cargo workspace version).
2. Build and package the desktop app per platform in a build matrix, using
   `tauri build` via `tauri-action`. Artifacts are signed where the relevant
   signing secrets are configured.
3. Publish a GitHub release with notes generated from `CHANGES.md`
   (`scripts/release-notes.mjs`) and every built artifact attached.

Continuous checks run separately on every push and pull request via
`.github/workflows/ci.yml`: the TypeScript side runs `pnpm lint`,
`pnpm typecheck`, and coverage-gated tests, and the Rust side runs
`cargo fmt --check`, `cargo clippy`, and `cargo test`. See
[Development](development.md) for the local gate commands.

## Per-platform packaging

Packaging is done by the Tauri bundler (`tauri build`). The bundle targets are
declared in `apps/desktop/src-tauri/tauri.conf.json` and are: `app`, `dmg`,
`deb`, `appimage`, `nsis`, `msi`.

| Platform | Artifact(s)                                             |
|----------|--------------------------------------------------------|
| Linux    | AppImage, deb                                           |
| macOS    | dmg + .app (signed and notarized when credentials are provided as CI secrets) |
| Windows  | nsis installer + msi (Authenticode-signed when a certificate secret is set) |

Application icons are generated from the sources in `assets/icons/`
(`icon-default.png` / `icon-dark.png` plus the renderer glyph SVGs) by
`scripts/gen-icons.mjs` (`pnpm run icons`), which writes the platform icon set
into `apps/desktop/src-tauri/icons/`. That directory is git-ignored; the desktop
crate's `build.rs` regenerates it when missing, and CI regenerates it before the
build.

## Windows MSIX (best-effort)

In addition to the nsis and msi bundles, the release workflow packages the
built executable into an MSIX with the Windows SDK `MakeAppx` tool, for optional
distribution through the Microsoft Store. This step is best-effort
(`continue-on-error`): it is skipped when the executable or `MakeAppx` is
unavailable and never fails the release. The MSIX is uploaded alongside the
other artifacts and is unsigned (the Store signs it on ingest).

## Branching and release flow

```
feature/* -> develop -> main (Merge Request)
```

1. All feature work lands in `develop` via feature branch Merge Requests.
2. When ready to release, open a Merge Request from `develop` to `main`.
3. A release commit on `main` prepares the version (bump the version in every
   `package.json`, `tauri.conf.json`, and the Cargo workspace so they all
   match; update `CHANGES.md` development bullets to a versioned heading). The
   release pipeline verifies these agree with the tag.
4. Tag the release commit: `git tag v1.0.0`.
5. Push the tag to trigger the release pipeline.

Direct commits to `main` are allowed only until the first release. After v1,
all changes enter `main` only via Merge Request.

## CHANGES.md

`CHANGES.md` is a per-version list of short bullet points grouped into:

- Breaking Changes
- Features
- Fixes

New work lands under a top `Development` heading during development. At
release, those bullets are moved under the new version heading. Each bullet is
short; large items link to documentation rather than describing details inline.

## macOS signing and notarization

macOS dmg builds are signed and notarized in CI. Signing certificates and
notarization credentials are provided as encrypted CI secrets. Notarization is
performed through the platform notary service (the ticket is stapled after
notarization).

Locally, you can produce unsigned installers for testing by running the desktop
build without any signing secrets:

```
pnpm --filter @skillkeeper/desktop build
```

(This runs `tauri build`; with no signing credentials configured it emits
unsigned artifacts.)

## Release integrity: checksums and GPG signature

Every release ships two extra assets next to the installers:

- `checksums.txt` -- SHA-256 of every attached artifact (one line per file).
- `checksums.txt.asc` -- a detached, armored GPG signature over
  `checksums.txt`, produced in the `publish` job of
  `.github/workflows/release.yml`.

The signing key is a dedicated release key (`Lorem Dev Release
<contact@lorem.dev>`), separate from any maintainer's personal
commit-signing key. Its private half and passphrase live in the CI secrets
`SKILLKEEPER_RELEASE_GPG_KEY` and `SKILLKEEPER_RELEASE_GPG_PASSPHRASE`; the
public half is committed at
[`.github/release-key.asc`](https://github.com/lorem-dev/skillkeeper/blob/main/.github/release-key.asc).
See [CONTRIBUTING.md](../../CONTRIBUTING.md) for how the key is bootstrapped
and rotated.

Signing is gated on the `SKILLKEEPER_RELEASE_GPG_KEY` secret: when it is
absent the workflow still publishes `checksums.txt` but skips the signature
and prints a warning, so a release stays green-able before the key is
configured (the same way the macOS and Windows code-signing steps degrade to
unsigned artifacts).

| Field       | Value                                                |
|-------------|------------------------------------------------------|
| Owner       | `Lorem Dev Release <contact@lorem.dev>`              |
| Algorithm   | ed25519 (signing) + cv25519 (encryption subkey)      |
| Fingerprint | `CFE6 485E 2351 9A25 A475  B900 AD0F 7A29 E439 8670` |

## Verifying a release

```sh
# 1. Import the public key and confirm the fingerprint matches the table above.
curl -fsSL https://raw.githubusercontent.com/lorem-dev/skillkeeper/main/.github/release-key.asc \
  | gpg --import
gpg --list-keys --fingerprint contact@lorem.dev

# 2. Download the checksum file, its signature, and the artifact you want.
TAG=v1.0.0
BASE="https://github.com/lorem-dev/skillkeeper/releases/download/${TAG}"
curl -fsSLO "${BASE}/checksums.txt"
curl -fsSLO "${BASE}/checksums.txt.asc"
# ...and one artifact, e.g. the Linux AppImage:
curl -fsSLO "${BASE}/SkillKeeper_1.0.0_amd64.AppImage"

# 3. Verify the signature over the checksum file.
gpg --verify checksums.txt.asc checksums.txt

# 4. Verify the artifact against the now-trusted checksum file.
sha256sum -c checksums.txt --ignore-missing
# macOS: shasum -a 256 -c checksums.txt --ignore-missing
```

A successful run prints
`Good signature from "Lorem Dev Release <contact@lorem.dev>"` followed by
`<artifact>: OK`. Any other outcome means the file should be discarded and
re-downloaded.

## Desktop UI

The desktop app is a Tauri v2 shell (Rust backend) with a React 19 + Zustand
renderer covering the Repositories, Skills, Projects, and Settings views. All
privileged work (filesystem, Git, config, state) runs in the Rust backend; the
renderer holds only UI state and a mirror of backend data and talks to the
backend through a typed Tauri command/event bridge.
