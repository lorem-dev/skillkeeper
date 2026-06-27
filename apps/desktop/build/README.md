# build/ - electron-builder resources

This directory contains the electron-builder resources for packaging SkillKeeper.

## Icons

`icon.svg` is the source icon. Platform-specific binary formats are generated
from it and tracked via Git LFS (see `.gitattributes` at the repo root):

- `icon.png` (256x256) -- Linux AppImage / deb
- `icon.icns` -- macOS dmg
- `icon.ico` -- Windows nsis / appx

Generation command (requires Inkscape or rsvg-convert):

    rsvg-convert -w 256 -h 256 build/icon.svg -o build/icon.png
    # macOS: png2icns build/icon.icns build/icon.png
    # Windows: convert build/icon.png build/icon.ico

## Windows Store

`appx/` will hold the Windows Store package metadata (AppxManifest.xml) and
Visual Assets. Provisioned as part of the release pipeline.

## electron-builder config

The `build` field in `package.json` contains the electron-builder configuration.
