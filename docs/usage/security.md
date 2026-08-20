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
   the system `git` binary with argument arrays only (never a shell string).
   Credentials stay outside the application: with no key chosen in Settings,
   keys and passphrases remain in the user's ssh-agent. A chosen key is read to
   verify its passphrase, which is then held in memory for that run of the
   desktop app only (see "SSH and credentials" below).

4. State writes are atomic. The application state store is written by first
   writing to a temp file and then renaming it, preventing partial writes from
   corrupting the state.

5. Hashes guard against silent drift. Every installed file and hook edit
   region is recorded with a SHA-256 hash. `verify` detects any modification
   and reports it explicitly.

6. The desktop renderer is unprivileged. The renderer is a web UI with no
   direct host access; it cannot touch the filesystem, Git, or config on its
   own. All privileged work goes through the Rust Tauri backend over a narrow,
   typed command/event bridge (`services/bridge/client.ts`, using Tauri
   `invoke()` and `listen()`). The backend is the authority for the filesystem,
   Git, config, and state, and re-validates every request.

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

By default SkillKeeper delegates all SSH key and passphrase handling to the
user's ssh-agent, and never reads, stores, or transmits credentials. To use
private SSH repositories that way, load your key into the ssh-agent before
running SkillKeeper:

```
ssh-add ~/.ssh/your-key
```

The desktop app can instead be pointed at one private key
(`repositories.sshKeyPath`). Then it does read that file, to verify the
passphrase you type and to decrypt the key in memory; the passphrase is held for
that run of the app only, never written to the config, to the state store, or to
any log, and never transmitted. Only the path is persisted. `ssh` receives the
passphrase over a local socket private to the user's account, authorised by a
token minted per git invocation and revoked when that invocation ends. See
[Using a dedicated SSH key](repositories.md#using-a-dedicated-ssh-key).

A PuTTY-format key is handled differently, and holds less: the app decrypts it
in memory, hands the result to your ssh-agent, and discards the passphrase
immediately. Nothing is kept for the rest of the session, because nothing needs
it -- `ssh` gets the key from the agent. Only the path is persisted, as for any
other key.

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
