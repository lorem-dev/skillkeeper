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
has a zod schema and a default value. On load:

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

Language, theme (placeholder for future use), and default editor command.

```yaml
general:
  language: en          # en | de | ru
  theme: default        # placeholder; not functional in v1
  editor: code          # default editor command for "open in IDE"
```

Default: language `en`, editor `code`.

### updates

Controls when SkillKeeper checks for updates.

```yaml
updates:
  mode: manual          # manual | on-startup | scheduled
  intervalHours: 24     # used when mode is "scheduled"
  checkOnStartup: false # extra check on app/CLI start regardless of mode
```

Default: `mode: manual`, `intervalHours: 24`, `checkOnStartup: false`.

- `manual` - updates are only checked when you run `skillkeeper check`.
- `on-startup` - a check runs each time the CLI or desktop app starts.
- `scheduled` - a check runs every `intervalHours` hours in the background
  (desktop app only).

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

Hook-consent policy. `always-ask` is the default and recommended setting.

```yaml
security:
  hookConsent: always-ask   # always-ask | per-repository | per-skill
```

`always-ask` means every hook install or update prompts for explicit
confirmation, regardless of the source repository. Changing this to a less
strict policy is possible but not recommended.

### notifications

Enable or disable system notifications (desktop app).

```yaml
notifications:
  enabled: true
```

Default: `true`.

## Example config.yaml

```yaml
general:
  language: en
  editor: code

updates:
  mode: manual
  intervalHours: 24
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
  hookConsent: always-ask

notifications:
  enabled: true
```
