#Requires -Version 5.1
<#
  SkillKeeper CLI installer for Windows.

  One-line install (nothing to download or set up first -- uses the
  Invoke-WebRequest and Expand-Archive built into PowerShell 5.1+):

    irm https://raw.githubusercontent.com/lorem-dev/skillkeeper/main/scripts/install.ps1 | iex

  Environment overrides:
    $env:SKILLKEEPER_VERSION      release tag to install (default: latest)
    $env:SKILLKEEPER_INSTALL_DIR  install directory
                                  (default: %LOCALAPPDATA%\SkillKeeper\bin)

  macOS / Linux users: use scripts/install.sh instead.
#>
$ErrorActionPreference = 'Stop'

$repo = 'lorem-dev/skillkeeper'
$bin = 'skillkeeper.exe'
$installDir = if ($env:SKILLKEEPER_INSTALL_DIR) {
  $env:SKILLKEEPER_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA 'SkillKeeper\bin'
}
$version = if ($env:SKILLKEEPER_VERSION) { $env:SKILLKEEPER_VERSION } else { 'latest' }

# Map the processor architecture to the Rust target triple used in the release
# asset names (skillkeeper-cli-<target>.zip).
switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { $target = 'x86_64-pc-windows-msvc' }
  'ARM64' { throw 'No prebuilt CLI for Windows arm64 yet; build from source: cargo install --path crates/skillkeeper-cli' }
  default { throw "Unsupported Windows architecture: $($env:PROCESSOR_ARCHITECTURE)" }
}

$asset = "skillkeeper-cli-$target.zip"
# `releases/latest/download/<asset>` always redirects to the newest release, so
# no API call or extra tooling is needed.
$url = if ($version -eq 'latest') {
  "https://github.com/$repo/releases/latest/download/$asset"
} else {
  "https://github.com/$repo/releases/download/$version/$asset"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("skillkeeper-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Write-Host "Downloading $asset ..."
  $zip = Join-Path $tmp $asset
  # UseBasicParsing keeps this working on Windows PowerShell without IE engine.
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

  Write-Host 'Extracting ...'
  Expand-Archive -Path $zip -DestinationPath $tmp -Force

  $src = Join-Path $tmp $bin
  if (-not (Test-Path $src)) { throw "archive did not contain $bin" }

  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Copy-Item $src (Join-Path $installDir $bin) -Force
  Write-Host "Installed skillkeeper to $installDir\$bin"

  # Add the install dir to the user PATH if it is not already present.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @()
  if (-not [string]::IsNullOrEmpty($userPath)) { $parts = $userPath -split ';' }
  if ($parts -notcontains $installDir) {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $installDir } else { "$userPath;$installDir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    $env:Path = "$env:Path;$installDir"
    Write-Host "Added $installDir to your user PATH -- restart your terminal to pick it up."
  }

  Write-Host 'Done.'
  & (Join-Path $installDir $bin) version
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
