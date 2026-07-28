# Configuration

## config.yaml

SkillKeeper stores user settings in `config.yaml` inside the OS
application-data directory. Print the path:

```
skillkeeper config path
```

Open the file in your configured editor:

```
skillkeeper config edit
```

Validate the current config (exit non-zero if any section is invalid):

```
skillkeeper config validate
```

## Sectioned validation with default fallback

`config.yaml` is divided into independently-validated sections. Each section
has a schema and a default value. On load:

1. Every section is validated separately.
2. An invalid section is replaced in memory by its default.
3. The raw file is left untouched.
4. The failure is surfaced: a startup warning in the CLI, or an
   invalid-configuration indicator and system notification in the desktop app.

This means a typo in one section does not break the rest of your configuration.
Both front ends expose a per-section validity indicator and can open `config.yaml`
in your editor.

## Sections

### general

Display language, theme, animation speed, and the editor command used by
"open in editor".

```yaml
general:
  language: en          # see the list below
  theme: system         # system | light | dark
  animations: normal    # fast | normal | off
  defaultEditor: code   # editor command; omitted means the platform default
```

Default: language `en`, theme `system`, animations `normal`, no
`defaultEditor`. For the list of languages see
[Localization](localization.md).

### updates

Controls when SkillKeeper checks for skill and repository updates.

```yaml
updates:
  mode: on-startup      # manual | on-startup | scheduled
  intervalMinutes: 720  # used when mode is "scheduled"; 1 minute .. 23 hours
  checkOnStartup: false # for "scheduled" mode: also check at startup
```

Default: `mode: on-startup`, `intervalMinutes: 720` (12 hours),
`checkOnStartup: false`.

- `manual` - updates are only checked when you ask for them.
- `on-startup` - a check runs each time the CLI or desktop app starts.
- `scheduled` - a check runs every `intervalMinutes` minutes in the background
  (desktop app only), plus one at startup when `checkOnStartup` is true.

### agents

Enabled agent kinds and per-agent overrides.

```yaml
agents:
  enabled:
    - claude
    - codex
    - copilot
    - cursor
    - opencode
```

Default: all five agents enabled.

### executables

Glob patterns for files that should have the executable bit (`+x`) set after
install, in addition to files declared executable in the skill manifest.

```yaml
executables:
  globs:
    - "**/*.sh"
    - "**/run"
```

Default: empty list (only manifest-declared executables are marked `+x`).

### security

Hook-consent policy.

```yaml
security:
  hookConsentPolicy: always-ask   # always-ask
```

`always-ask` means every hook install or update prompts for explicit
confirmation, regardless of the source repository. It is currently the only
policy: hooks run code on your machine, so consent is never implicit.

### notifications

Enable or disable system notifications (desktop app).

```yaml
notifications:
  enabled: true
```

Default: `true`.

### repositories

```yaml
repositories:
  gitPath: git                            # git executable to run
  sshKeyPath: /home/you/.ssh/id_ed25519   # optional private key for SSH remotes
```

Default: `gitPath: git`, no `sshKeyPath` (the system ssh setup decides). The
passphrase is never stored in the config; see
[Using a dedicated SSH key](repositories.md).

### projects

```yaml
projects:
  checkIntervalMinutes: 1   # how often tracked folders are re-checked; 1 minute .. 23 hours
```

Default: `checkIntervalMinutes: 1`.

### mcp

```yaml
mcp:
  servers: []   # manually-defined presets; format in MCP servers
```

Default: empty list. See [MCP servers](mcp.md).

## Example config.yaml

```yaml
general:
  language: en
  theme: system
  animations: normal
  defaultEditor: code

updates:
  mode: on-startup
  intervalMinutes: 720
  checkOnStartup: false

agents:
  enabled:
    - claude
    - codex
    - copilot
    - cursor
    - opencode

executables:
  globs: []

security:
  hookConsentPolicy: always-ask

notifications:
  enabled: true

repositories:
  gitPath: git

projects:
  checkIntervalMinutes: 1

mcp:
  servers: []
```
