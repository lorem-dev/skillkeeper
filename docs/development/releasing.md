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

## Desktop UI

The desktop app is a Tauri v2 shell (Rust backend) with a React 19 + Zustand
renderer covering the Repositories, Skills, Projects, and Settings views. All
privileged work (filesystem, Git, config, state) runs in the Rust backend; the
renderer holds only UI state and a mirror of backend data and talks to the
backend through a typed Tauri command/event bridge.
