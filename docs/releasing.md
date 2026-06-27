# Releasing

## Release pipeline

Releases are driven by GitHub Actions. The pipeline runs on a version tag
(`v*`) and proceeds in this order:

1. Lint (`pnpm lint`)
2. Typecheck (`pnpm typecheck`)
3. Test with coverage gate (`pnpm test:cov`) - build fails below 90% lines and
   branches.
4. Build all packages (`pnpm build`).
5. Package per platform (matrix build).
6. Publish artifacts.

## Per-platform packaging

Packaging uses [electron-builder](https://www.electron.build/).

| Platform | Artifact(s)                                          |
|----------|------------------------------------------------------|
| Linux    | AppImage, deb                                        |
| macOS    | dmg (signed and notarized; keys provided as CI secrets) |
| Windows  | nsis installer + MSIX/appx for the Microsoft Store   |

Application icons and Windows Store metadata (including Store-required
metadata fields and application icons) live under
`apps/desktop/build/`.

## MSIX and the Microsoft Store

The Windows build produces both an nsis installer (traditional setup.exe style)
and an MSIX package for distribution through the Microsoft Store. The MSIX
artifact is uploaded as a release artifact and can be submitted to the Store
via Partner Center.

Store metadata and application icons are maintained under
`apps/desktop/build/` and must be kept up to date before each Store
submission.

## Branching and release flow

```
feature/* -> develop -> main (Merge Request)
```

1. All feature work lands in `develop` via feature branch Merge Requests.
2. When ready to release, open a Merge Request from `develop` to `main`.
3. A release commit on `main` prepares the version (bump `package.json`,
   update `CHANGES.md` development bullets to a versioned heading).
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
notarization credentials are provided as encrypted CI secrets. Notarization
uses the Apple Notary Service (stapling is done post-notarization).

Locally, you can build an unsigned dmg for testing:

```
pnpm --filter @skillkeeper/desktop build:mac-unsigned
```

(The exact local build script is defined in `apps/desktop/package.json`.)

## Desktop UI status

v1 delivers the Electron shell, IPC bridge, Zustand store, and navigation
skeleton with placeholder views (Repositories, Skills, Projects, Settings).
Detailed screen designs, interactions, and visual language are specified in a
follow-up document. No business logic lives in the renderer.
