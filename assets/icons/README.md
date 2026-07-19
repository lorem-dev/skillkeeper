# App icons

Single source of truth for the SkillKeeper desktop icons.

- `icon.icon/` -- Apple Icon Composer design project (edit here).
- `icon-default.png` / `icon-dark.png` -- full-bleed 1024x1024 exports (light / dark).

Regenerate every derived binary into `apps/desktop/src-tauri/icons/`:

    pnpm run icons        # node scripts/gen-icons.mjs

The script insets each source into the macOS icon grid (824x824 body in a 1024
canvas) so the dock icon is sized like its neighbours, runs `tauri icon` for the
platform set (icns/ico/pngs/Store tiles), writes `icon-{light,dark}-256.png` for
the runtime theme swap, and rasterizes the macOS menu glyph templates. The
outputs under `src-tauri/icons/` are committed (Rust `include_bytes!` +
`tauri.conf.json` need them at build time); re-run the script when a source changes.
