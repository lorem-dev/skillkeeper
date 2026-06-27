# Security

## Principles

SkillKeeper is designed around a small set of security principles:

1. Skills are file-delivery tools, not code runners. SkillKeeper never
   executes skill or repository code during install, resolve, verify, or
   update. It copies files, sets the executable bit, and edits clearly
   delimited config regions. Running a skill is the agent's job.

2. Hook installation is always an explicit, separate consent. Hooks modify
   agent configuration; this is privileged and requires the user to opt in
   each time with `--allow-hooks` (CLI) or a dedicated consent step (desktop
   app). Without explicit consent the skill body installs and hooks are
   skipped with a clear notice.

3. Git runs as a subprocess with no shell interpolation. SkillKeeper invokes
   the system `git` binary with argument arrays only (`child_process.execFile`
   with an array, never a shell string). SkillKeeper never reads private keys
   or passphrases; these remain in the user's ssh-agent.

4. State writes are atomic. The application state store is written by first
   writing to a temp file and then renaming it, preventing partial writes from
   corrupting the state.

5. Hashes guard against silent drift. Every installed file and hook edit
   region is recorded with a SHA-256 hash. `verify` detects any modification
   and reports it explicitly.

6. The desktop renderer is sandboxed. The renderer process has
   `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
   All privileged work crosses IPC to the main process over a narrow, typed
   `window.skillkeeper` bridge exposed by the preload script. The main process
   re-validates every IPC request.

7. No dynamic code evaluation, no opaque downloads-and-runs. The codebase
   avoids patterns a platform malware scanner would flag.

## Hook ownership markers

For delimited-text hooks, SkillKeeper inserts comment delimiters that carry
the skill and hook identity:

```
# >>> skillkeeper:hook group/name:hookName v1.0.0 >>>
... content ...
# <<< skillkeeper:hook group/name:hookName <<<
```

For json-merge hooks (such as Claude `settings.json`), each managed entry
carries a `_skillkeeper` ownership marker. These markers make SkillKeeper's
managed regions visible in plain text and prevent accidental edits from going
undetected by `verify`.

Skill or hook content that itself contains these tokens is encapsulated on
install so it cannot be mistaken for a managed region. Encapsulation is
reversed on read for display.

## SSH and credentials

SkillKeeper delegates all SSH key and passphrase handling to the user's
ssh-agent. It never stores, reads, or transmits credentials.

To use private SSH repositories, load your key into the ssh-agent before
running SkillKeeper:

```
ssh-add ~/.ssh/your-key
```

## Hook-consent policy

The `security.hookConsent` setting in `config.yaml` controls the hook-consent
policy. The default and recommended value is `always-ask`, which requires
explicit confirmation for every hook install or update regardless of the
source repository.

See [Configuration](configuration.md) for details.

## Vulnerability scanning

SkillKeeper v1 does not perform vulnerability scanning of skill content. The
architecture includes a seam for adding this capability in a future version.

## Reporting security issues

Report security issues to the maintainers privately before opening a public
issue. See `CONTRIBUTING.md` in the repository for contact information.
