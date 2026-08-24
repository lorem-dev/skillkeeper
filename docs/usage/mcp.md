# MCP Servers

See also: [Skills and Hooks](skills-and-hooks.md) (the guidance mechanism
MCP `rules` reuses), [Repositories](repositories.md) (a repository can
declare MCP presets alongside skills), and [Projects](projects.md) (MCP
installs use the same per-project targets as skills).

## Overview

An MCP (Model Context Protocol) server is an external tool/context provider
an agent can call into. SkillKeeper manages MCP server **presets** and
installs them into a project's agents, alongside skills.

A preset comes from one of two origins:

- **Manual** - defined by the user in SkillKeeper's own configuration
  (`config.yaml`, section `mcp`). Editable at any time; editing a preset can
  later update every install made from it.
- **Repo** - declared in a repository's `mcp.yml`/`mcp.yaml` file. Read-only:
  it can only change by editing the file in the repository and syncing.
  Updated implicitly whenever the repository is fetched.

Installing a preset renders it into the native MCP configuration format of
one or more agents (Claude, Cursor, Copilot, OpenCode, Codex), tracks the
install in a small ledger, and - if the preset carries `rules` - writes
guidance into the agent's guidance file the same way skill guidance is
written.

## The `mcp.yml` / `mcp.yaml` format

A repository may declare MCP server presets in an `mcp.yml` (or `mcp.yaml`)
file:

- at the repository root - these presets have no group, and
- inside any ancestor directory of a resolved skill - the directory's path
  relative to the repository root becomes the preset's group (a repository
  holding `a/b/c/skill` is read at the root plus `a`, `a/b`, and `a/b/c`, so
  an `mcp.yml` at `a/b/c` yields presets grouped `a/b/c`).

Each `mcp.yml`/`mcp.yaml` is independent: a nested file does not inherit
presets from a shallower one, and a shallower file is never overridden by a
deeper one. A directory only counts when it leads to a skill that actually
resolves, so a stray `mcp.yml` in a subtree with no resolved skill
contributes nothing.

If a directory has both `mcp.yml` and `mcp.yaml`, `mcp.yml` is read and
`mcp.yaml` is ignored entirely, even if `mcp.yml` fails to parse (this is a
precedence rule, not a fallback). A file that fails to parse is skipped with
a warning; it never fails the rest of the sync.

That warning is visible: it appears in the app's notifications log, named
against the repository it came from, and on the CLI's standard error whenever
it lists or installs MCP presets. The same goes for a file that exists but
cannot be read at all. A skipped file is the one case where presets are
missing for a reason nothing else shows, so it is never dropped silently.

Schema:

```yaml
version: 1
servers:
  - name: <string>            # required
    type: stdio | http | sse  # required
    url: <string>             # required for http/sse
    headers:                  # optional, http/sse
      <header-name>: <value>
    command: <string>         # required for stdio
    args: [<string>, ...]     # optional, stdio
    env:                      # optional, stdio
      <VAR_NAME>: <value>
    oauth:                    # optional, http/sse
      clientId: <string>
      callbackPort: <number>
      scopes: [<string>, ...]
    description: <string>     # optional, shown wherever this preset is listed
    parameters:               # optional, keyed by parameter name
      <param-name>:
        description: <string> # optional, prose; see "Descriptions" below
        options:              # optional, value-to-label map; order matters
          <value>: <label>
    rules: <string>           # optional guidance body
```

`stdio` requires `command`; `http` and `sse` require `url`. A server missing
the field its transport needs fails validation for the whole file.

### Editor support

Every release publishes a JSON Schema for this format. Point an editor at it
with a `yaml-language-server` comment on the first line and you get
completion, hover documentation, and validation as you type - including the
quoting rule above, which the schema reports as a type error on the value:

```yaml
# yaml-language-server: $schema=https://github.com/lorem-dev/skillkeeper/releases/latest/download/mcp.schema.json
```

`releases/latest/download` resolves to the newest final release, so the line
needs no maintenance; pre-release builds are not served by it. Field names,
types, and descriptions are generated from the same Rust types the parser
uses, and CI fails if the committed schema drifts from them. The schema is
deliberately stricter in one place: it flags an unquoted `{param}`, which the
parser tolerates with a warning.

### Example: repository root

```yaml
# yaml-language-server: $schema=https://github.com/lorem-dev/skillkeeper/releases/latest/download/mcp.schema.json
# mcp.yml at the repository root
version: 1
servers:
  - name: docs-http
    type: http
    url: "https://{host}/mcp"
    headers:
      Authorization: "Bearer {token}"
    rules: |
      Prefer the docs-http MCP for {host} lookups.
      Cite the source path for every answer.
  - name: local-fs
    type: stdio
    command: npx
    args: ["-y", "@acme/fs", "--root", "{root}"]
    env:
      FS_TOKEN: "{token}"
```

### Example: inside a skill group

```yaml
# yaml-language-server: $schema=https://github.com/lorem-dev/skillkeeper/releases/latest/download/mcp.schema.json
# tooling/mcp.yml - group "tooling"
version: 1
servers:
  - name: tooling-sse
    type: sse
    url: "https://{host}/tooling/sse"
    headers:
      X-Api-Key: "{api_key}"
```

Both files exist for real in the
[skillkeeper-test-repo](https://github.com/lorem-dev/skillkeeper-test-repo)
fixture repository:
[`mcp.yml`](https://github.com/lorem-dev/skillkeeper-test-repo/blob/main/mcp.yml)
declares seven ungrouped presets covering all three transports, with and
without parameters, headers, `rules`, and `oauth`;
[`tooling/mcp.yml`](https://github.com/lorem-dev/skillkeeper-test-repo/blob/main/tooling/mcp.yml)
declares one preset in the `tooling` group.

## Parameters

A server definition may reference `{name}` placeholders in `url`, header
values, `command`, `args`, `env` values, `rules`, `oauth.clientId`, and each
entry of `oauth.scopes`. Parameters are **not** declared anywhere - they are
discovered by scanning every one of those fields for `{[A-Za-z0-9_]+}` and
collecting the distinct names. The same name used in more than one field is
still a single parameter. `oauth.callbackPort` is numeric and is not scanned.

Placeholder syntax is validated separately: an unclosed `{`, an empty `{}`,
or a name containing a character outside `[A-Za-z0-9_]` is rejected, with
the offending position reported.

At install time, every parameter is presented for a value (plain text; no
typed or secret fields exist yet). The rendering step substitutes each
`{name}` with its value across all of the fields listed above, including
`rules`. Rendering fails if any referenced parameter has no value.

Example: the `docs-http` server above has two parameters, `host` and
`token` (`host` appears in both `url` and `rules`; it still counts once).

### Quote a value that starts with a placeholder

```yaml
headers:
  X-Token: "{personal_token}"   # quoted, a string
  Authorization: Bearer {token} # fine unquoted: `{` is not the first character
```

In YAML a leading `{` opens a flow mapping, so an unquoted `{personal_token}`
is read as the map `{personal_token: null}` rather than as text. SkillKeeper
recovers the intended string and reads the file anyway, but it reports a
warning naming the line, because the same spelling means something else to
every other YAML tool. Quoting silences it.

## Descriptions and parameter metadata

A server, and each of its parameters, may carry a `description`: a short line
of prose shown wherever the preset (or its parameter prompt) is listed. A
parameter may also carry `options`, restricting it to a fixed set of values
and giving each one a label.

```yaml
version: 1
servers:
  - name: docs-remote
    type: http
    url: "https://mcp.example.com/mcp"
    description: "Docs search over the [team wiki](https://mcp.example.com/wiki)."
    parameters:
      region:
        description: "Which regional endpoint to query."
        options:
          us: United States
          eu: Europe
      token:
        description: "A personal access token."
```

`parameters` is **additive metadata, not a declaration**: the set of
parameters still comes from scanning every string field for `{name}`
placeholders, exactly as described above. A placeholder with no `parameters`
entry behaves exactly as it always has, and an existing `mcp.yml` with no
`parameters` block does not change meaning. An entry in `parameters` naming
something no placeholder uses is never an error - it is a lint warning
(`SK019`), and nothing else changes. See
[CLI Reference](cli.md#repo-lint) for the full table of lint codes.

### Description markup

A description is prose, not a template: it is deliberately **not** scanned
for `{param}` placeholders, so writing `{name}` inside one renders as those
literal characters and never becomes an input field.

Exactly one markup form is recognized: `[text](http://...)` or
`[text](https://...)`. Everything else stays literal text, including every
other URL scheme, a protocol-relative or relative URL, a URL containing `(`
or whitespace, an empty or whitespace-only label, and unbalanced brackets. A
link immediately followed by more text is still a link. Falling back to
literal text on anything unrecognized is deliberate: a construct SkillKeeper
does not recognize can never turn into a live link. A description containing
link-like text that failed to parse is a lint warning (`SK021`), never an
error.

### Truncation

A description is truncated to 128 VISIBLE characters, hard. A link's URL
never counts toward that budget - only its visible text does. An ellipsis is
appended only when something was actually removed. When the budget runs out
in the middle of a link's text, the text is cut and the link is **kept**,
still pointing at the same URL, rather than dropped entirely - dropping it
could swallow the only link a description has. There is deliberately no way
to read the truncated remainder. A description longer than the budget is a
lint warning (`SK018`).

### Options: validation and migration

`options` is written as a mapping of value to label, and its **order
matters**: it decides which option is chosen when a stored value disappears
(see below), so reordering the mapping is treated as a change to the server,
the same as changing any other field. A list of `{value, label}` entries is
accepted as well, and is the form the value is written back as.

An unfinished `options` is never a parse failure. A bare `options:`, an empty
`{}` and an empty `[]` all mean "no options", and a value written with no
label yet gets a blank one - a half-written key must not take down every
other server declared in the same file.

Nothing warns about an empty one, though, and nothing can: all of those forms
parse to exactly what a parameter with no `options` key at all parses to, so
neither the linter nor an update can tell "the author wrote an empty list"
from "the author wrote no list". A parameter with an empty `options` therefore
offers a select with nothing to select in it, and no message anywhere says so.
Either fill the list in or drop the key.

A parameter's value must be one of its `options`. This is enforced on both
surfaces: the CLI (`mcp install`, `mcp update`) rejects a value that is not
one of the options and prints the parameter's description alongside the
accepted values, and the desktop app's install, update and save forms only
let you pick one of them. Two options sharing the same value is a lint
warning (`SK022`).

Updating an installed instance can leave a stored value that the new
definition's `options` no longer offers (an author removed or renamed a
choice):

- If the parameter still has options, the stored value is replaced by the
  **first** option, and the substitution is reported. Rewriting a value you
  chose is never silent.
- If the parameter has no options left, the stored value is left untouched -
  clearing it could break a working install - and nothing is reported, for
  the reason above: an empty list reads exactly like a parameter that only
  carries a `description`, so a message here would fire on every described
  parameter of every update.

### The desktop preset editor does not author this

Described parameters and option lists exist only in a hand-written
`mcp.yml`. The desktop's preset editor - used for the user's own manual
presets - gained a `description` field on the server and nothing else. It
creates neither a `parameters` map nor an `options` list; giving one of a
manual preset's parameters a description or a restricted set of options is
not possible from the interface.

## Install, update, and remove

### Install

Installing a preset for one agent:

1. Renders the parameter values into the definition.
2. Allocates an instance name: the server's `name`, snake_cased, with a
   `_<n>` suffix. Installing the same preset again produces a new instance
   (`github_1`, then `github_2`, and so on). If a name is already taken by a
   server SkillKeeper does not own, the counter skips it - an existing,
   unmanaged entry in the native config is never overwritten.
3. Writes the rendered definition into the agent's native MCP config file.
4. If the definition carries `rules`, renders and writes them into the
   agent's guidance file as a marked block (see "Rules" below).
5. Records the instance in `.skmcp.yml` and its raw parameter values in
   `.skmcp.params.yml`.
6. On the first MCP install into a project, ensures the project's
   `.gitignore` excludes both parameter files.

### Update

An installed instance can be updated when the current source definition's
content hash differs from the hash recorded at install time (see "Update
detection" below). Updating an instance:

1. Computes the new definition's parameters and compares them against the
   values already on file for that instance. Any newly-required parameter
   that has no stored value is **missing**.
2. If any parameter is missing, its value must be supplied before the
   update proceeds; closing out of that prompt without supplying every
   missing value aborts the update - nothing changes.
3. Removes the old instance and reinstalls the new definition under the
   **same** instance name, using the merged parameter values (existing
   values kept, missing ones now filled in).
4. Refreshes the recorded hash in `.skmcp.yml`.

Updating a repository preset that fans out to multiple installed instances
(different projects, agents, or both) updates every instance whose hash is
stale.

### Remove

Removing an instance reverses install: the native server entry is dropped,
its guidance block (if any) is removed by its marker key, and its entries
are dropped from both `.skmcp.yml` and `.skmcp.params.yml`. Removal is
safe to call even when one side is already gone (missing native server,
guidance block, or ledger entry).

### Update detection (hashing)

Each definition is hashed for identity comparison: a deterministic JSON
serialization of every field except `name` (so renaming a server in
`mcp.yml` is not a content change) with all object keys sorted recursively
(so key order in `headers`/`env` never affects the hash). The hash is
`sha256:<hex digest>`. Parameter **values** are never part of the hash -
they live only in `.skmcp.params.yml` - so filling in or changing a
parameter value is not, by itself, an "update."

## Tracking files

Two files, kept per agent and scope, record what SkillKeeper has installed:

- **`.skmcp.yml`** - the install ledger. One entry per installed instance:

  ```yaml
  schema: 1
  servers:
    - remote: git@github.com:acme/mcps.git   # omitted for manual presets
      group: tooling                          # omitted when at the repo root
      local: <presetId>                       # present only for manual presets
      source: docs-http                       # server name in mcp.yml/preset
      name: docs_http_1                       # assigned instance name
      hash: sha256:...                        # hash of the raw def at install
  ```

  The ledger identifies a preset by **reference**, not by a generated
  install ID: `(remote, group, source)` for a repo preset, `(local,
  source)` for a manual one. This is what lets update matching survive a
  reinstall and lets the same file double as the ownership record - it is
  the only place that says which native config entries SkillKeeper owns, so
  updates and removals act on exact instance names instead of touching
  anything unrecognized.

- **`.skmcp.params.yml`** - the sibling parameter-values file, keyed by
  instance name:

  ```yaml
  docs_http_1:
    host: mcp.example.com
    token: sk-...
  ```

  This file holds raw secrets and is never meant to be committed. The first
  MCP install into a project appends both `.skmcp.params.yml` and
  `.skmcp.params.yaml` to the project's `.gitignore` (creating the file if
  it does not exist, or appending only the lines that are missing under a
  `# SkillKeeper MCP parameter values` comment).

Both files live at the root of the agent's skills destination for the
relevant scope - the same root the skills engine already resolves for that
agent:

| agent    | project scope                              | global scope                          |
|----------|---------------------------------------------|----------------------------------------|
| claude   | `<project>/.claude/skills/`                 | `~/.claude/skills/`                    |
| cursor   | `<project>/.cursor/skills/`                 | `~/.cursor/skills/`                    |
| copilot  | `<project>/.github/copilot/skills/`         | `~/.config/github-copilot/skills/`     |
| opencode | `<project>/.opencode/skills/`               | `~/.config/opencode/skills/`           |
| codex    | `<project>/.codex/skills/`                  | `~/.codex/skills/`                     |

## Per-agent native destinations

Each agent has its own native MCP config file and its own supported
transports. `mcp install --global` (and `--project`) picks which of the two
destinations below is written; every agent supports both, not only codex:

| agent    | project destination            | global destination                              | transports       | container key |
|----------|---------------------------------|--------------------------------------------------|------------------|----------------|
| claude   | `<project>/.mcp.json`          | `~/.claude.json`                                 | stdio, http, sse | `mcpServers`   |
| cursor   | `<project>/.cursor/mcp.json`   | `~/.cursor/mcp.json`                              | stdio, http, sse | `mcpServers`   |
| copilot  | `<project>/.vscode/mcp.json`   | `~/.config/github-copilot/mcp-config.json`        | stdio, http, sse | `servers`      |
| opencode | `<project>/opencode.json`      | `~/.config/opencode/opencode.json`                | stdio, http, sse | `mcp`          |
| codex    | `<project>/.codex/config.toml` | `~/.codex/config.toml`                            | stdio, http      | `mcp_servers`  |

Writers only touch their own container key and the server entries they own;
other keys and other servers already in the file are preserved. Output key
order is sorted, so re-writing the same content is a no-op diff.

Codex differs from the other four agents in a few ways:

- **A project-scoped config is honored only for trusted projects**: Codex
  reads a project-scoped `<project>/.codex/config.toml` in addition to its
  global file, but only for a project the user has marked trusted from
  within Codex itself. SkillKeeper has no way to see that trust state, so it
  writes the project-scoped file regardless of it rather than pretending to
  verify something it cannot see. This applies equally to the CLI (`mcp
  install --agent codex --project <dir>`) and the desktop backend.
- **`sse` is not supported**: Codex's native config can express `stdio` and
  `http` servers. Whether its remote client also accepts `sse` is
  unverified, so this project does not write a config shape it has not
  confirmed works; installing an `sse` preset for Codex is skipped rather
  than attempted, and is reported back as a skipped install.

The Codex writer round-trips `~/.codex/config.toml` through a TOML
parser/serializer. That preserves table structure and values but does
**not** preserve hand-written comments or formatting in the file - a
`config.toml` with comments loses them the first time SkillKeeper edits it.

opencode's native shape differs from the other JSON-based agents: a stdio
server becomes a `local` entry whose `command` array is the command
followed by its args, with `env` under the key `environment`; an http/sse
server becomes a `remote` entry (both transports use the same shape, since
opencode does not distinguish them at this level).

At global scope, `~/.config/opencode/opencode.json` is also opencode's hook
target: a skill's `delimited-text` hook writes a `#`-delimited block into that
same file. The MCP writer carries such a block through its rewrites
byte-for-byte instead of failing on it or dropping it, so neither install order
loses data. Note that a `#` comment is not valid JSON, so a file holding both a
hook block and MCP servers is still not readable by opencode itself; avoid
installing global opencode hooks and global opencode MCP servers together.

## OAuth

An `oauth` block on an `http` or `sse` server definition carries the OAuth
*client configuration* the agent needs to sign in to that server. It is
meaningful only for those two transports, never for `stdio`.

```yaml
oauth:
  clientId: example-client
  callbackPort: 4321
  scopes: [read, write]
```

- `clientId` - a pre-registered OAuth client id. Absent leaves the agent to
  register one dynamically.
- `callbackPort` - a fixed loopback port for the redirect URI. Absent lets
  the agent choose its own.
- `scopes` - the requested scopes. Declared as a list because the agents
  disagree on the wire type it is rendered as (see "Per-agent rendering"
  below); an empty list is the same as omitting the field.

### SkillKeeper writes configuration; the agent signs in

SkillKeeper never performs the OAuth flow itself: it does not open a
browser, does not run a callback server, and does not obtain, store, or
refresh a token. Every agent runs its own authorization flow and keeps the
resulting token in its own store - Claude Code in the system keychain,
OpenCode in its own credentials file, Codex behind its own sign-in command -
so a token SkillKeeper obtained could not be placed anywhere useful. Writing
the client configuration and leaving the sign-in to the agent is exactly how
SkillKeeper already treats every other MCP field.

### A client secret is never stored

`oauth` carries only public-client fields: `clientId`, `callbackPort`, and
`scopes`. There is no `clientSecret` field. SkillKeeper's configuration is
committed to repositories and synchronized between machines, so a secret
placed in it would leak by construction. A user with a confidential client
supplies the secret through their own agent's command instead, which routes
it to the platform keychain rather than to a file SkillKeeper can see.

### Per-agent rendering

`scopes` is stored as a list because the agents do not agree on the wire
type: Claude Code takes one space-separated string, while Cursor and Codex
take an array. A list converts to both without loss.

| Agent | Native key | Client id | Scopes | Callback port |
|---|---|---|---|---|
| Claude Code | `oauth` | `clientId` | space-separated string | `callbackPort` |
| Cursor | `auth` | `CLIENT_ID` | array | not supported; dropped and reported |
| OpenCode | `oauth` | `clientId` | not written; unverified whether OpenCode accepts a scopes field | not supported; dropped and reported |
| Codex | `[mcp_servers.<name>.oauth]`, `scopes` in the server table | `client_id` | array, beside `url`, not inside `oauth` | see "Codex" below |
| Copilot | not supported | - | - | - |

A field an agent's native config cannot express is omitted rather than
guessed at, and the omission is reported back as a note next to the install
result, the same way a skipped agent already is.

Installing an oauth-carrying preset for Copilot skips Copilot outright and
reports why, rather than writing a server that looks installed and cannot
authenticate.

### Codex

Codex nests the client id in its own table and keeps scopes beside `url`,
not inside the `oauth` table:

```toml
[mcp_servers.remote]
url = "https://mcp.example.com/mcp"
scopes = ["read", "write"]

[mcp_servers.remote.oauth]
client_id = "example-client"
```

A `callbackPort` also writes two keys at the root of `config.toml`, not
inside the server table, because that is where Codex reads them from:

```toml
mcp_oauth_callback_port = 4321
mcp_oauth_callback_url = "http://localhost:4321/callback"
```

They are written together, derived from one value, and only when both are
absent or already hold the values SkillKeeper would write. If a different
value is already there, SkillKeeper writes the server but leaves the two
keys alone and reports the conflict: a half-written pair, or overwriting a
value another server or the user depends on, is worse than leaving it for
the user to resolve by hand. Uninstalling the server never removes these
keys either, for the same reason - they are not SkillKeeper's to delete.

Codex also gates its remote MCP client behind an experimental feature flag:

```toml
[features]
rmcp_client = true
```

SkillKeeper does not write it: enabling an experimental feature in someone's
configuration is not a decision this project makes for them. Set it
yourself before installing a remote server for Codex.

### Lint codes

`repo lint` reports three warnings for a malformed `oauth` block: `SK015`
(an `oauth` block on a `stdio` transport), `SK016` (a blank `clientId`), and
`SK017` (a `callbackPort` of `0`). All three are warnings, not errors - a
repository you only consume still resolves and installs with a bad auth
block on one preset, the same as any other lint warning. Authoring the
preset yourself in the desktop editor is different: it rejects the same
input outright and refuses to save, since you are the one who can fix it.
The CLI has no MCP authoring command, so it has nothing to reject there. An
`oauth` block that does reach an install on a `stdio` preset is dropped
rather than written, and the drop is reported for every agent. See
[CLI Reference](cli.md#repo-lint) for the full table of codes.

## Rules (guidance)

A preset's `rules` field, if present, is installed into the target agent's
guidance file using the same mechanism as skill guidance: a marked block

```
<!-- SKILLKEEPER_START: <key> -->
... rendered rules body ...
<!-- SKILLKEEPER_END: <key> -->
```

where `<key>` is built from the preset's identity (its source repository
remote, or `local:<presetId>` for a manual preset) and the installed
instance name, so the block can be found and replaced or removed later even
if the source preset changes or disappears. The rules body is rendered
(parameters substituted) before being written, and any literal
`SKILLKEEPER_START`/`SKILLKEEPER_END` marker line inside the body is
stripped first, so it cannot be mistaken for a block boundary.

Guidance files are the same ones skills write to per agent: `CLAUDE.md` (or
`.claude/CLAUDE.md`) for Claude, `AGENTS.md` for Codex and OpenCode,
`.github/copilot-instructions.md` for Copilot, and `.cursorrules` (or
`.cursor/rules/skillkeeper.mdc`) for Cursor. For Codex specifically, since
its MCP installs are global, its guidance target is `~/AGENTS.md`, not a
project file.

Removing an instance removes exactly its own marked block; other
SkillKeeper-owned blocks in the same guidance file (from skills or other
MCP instances) are left untouched.
