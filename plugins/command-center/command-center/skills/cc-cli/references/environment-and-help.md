## Identity and environment resolution

Every CC session is spawned with the env contract already set:

| Variable | Meaning |
|---|---|
| `CC_SERVER_URL` | CC server base URL |
| `CC_API_TOKEN` | instance API token |
| `CC_PROJECT` / `CC_SESSION` / `CC_CONVERSATION_ID` | your identity |

Inside a CC session, ordinary actions need no identity flags — commands resolve
the ambient scope from the environment. Resolution order when both are present:

1. Explicit flags: `--server`, `--token`, `--project`, `--session`, `--conversation`
2. Env vars (the contract above)
3. Token only: the `<configDir>/api-token` file (the server's own token store)

A command that needs identity and cannot resolve it exits `2` naming the
missing variable. Outside CC (a plain terminal), pass the flags explicitly.

Cross-session **mutations** always require explicit `--project`/`--session`
flags — `cctl` never silently *acts on* a different session than its env
identity. The exception is the read-only `cctl conversation` group, which
auto-resolves a conversation's owning project/session from its **id** alone
(see that section), so reading a `<conversation-ref>` needs no flags.
`cctl ticket attach conversation <ticket> <id>` uses that same global lookup
for its read of the source conversation; the mutation still targets only the
ticket identified by `<ticket>`.

## `cctl doctor`

The connectivity/auth/version diagnostic. Run it first whenever any `cctl`
command exits `3`, or to sanity-check the environment.

```
cctl doctor
```

Success (exit 0) prints the server URL, server and CLI build stamps, your
resolved identity, and token validity:

```
server        http://127.0.0.1:3000
server build  b034865-2026-07-02T21:00:00.000Z
cli build     b034865-2026-07-02T21:00:00.000Z
identity      project=my-repo session=my-session conversation=abc123
token         valid (source: env)
```

`doctor` reports a build-stamp mismatch and still exits `0` because diagnosing
the skew is its job. Build-gated commands fail with exit `4`; offline help,
version, and cross-instance diagnostics have their own contracts. A mismatch means the binary and responding server advertise different builds.
Use the intended server's published binary; repeated calls to the same skewed
binary do not resolve it. `doctor` prints that server's `cctl` path (`server cctl`) —
invoke that binary instead.

### Troubleshooting (exit 3 recovery)

- **`cannot reach the CC server … is the CC server running?`** — the server
  is down or `CC_SERVER_URL` points at the wrong place. Inside a CC session
  this means the server itself restarted or died; there is nothing to fix
  from the session — report it to the user.
- **`the server rejected the API token`** — the token in `CC_API_TOKEN` (or
  your `--token` flag) does not match the server's `<configDir>/api-token`.
  The doctor output names which source the token came from; fix that source.
- **`no API token`** — nothing resolved from flag, env, or the token file.
  Inside CC this should never happen (the env contract injects it); outside
  CC, pass `--token` or export `CC_API_TOKEN`.

## Build identity

`cctl --version` prints this binary's build stamp offline. Compare it with the
server build from `cctl doctor`.

```sh
cctl --version
cctl --version --json
```

The JSON metadata is `{ "name": "cctl", "version": "<sha>-<build-time>" }`.

## Discovering commands with `--help`

`cctl` is a progressive-disclosure graph: every subcommand is a node with its own
`--help`. Navigate node by node instead of front-loading — `--help` resolves the
**full** positional path, so it is subcommand-granular:

```
cctl --help                              # top-level usage: the command list + global flags
cctl workflow --help                     # the 'workflow' group index: one line per subcommand
cctl workflow create --help              # the leaf: description, usage, flags, examples, related, skills
cctl conversation compaction get --help  # 3-level paths resolve too
```

A leaf node's help is a mini-skill: `description`, `usage`, `flags`, `examples`
(which teach failure-prone shapes, e.g. `--message-range A:B`), a `related:` block
(sibling commands), and a `skills:` block ("load X when Y"). A group node renders
an index of its children. Help always exits `0`, works offline, and never prompts —
it is the recovery path, so reach for it whenever a command surprises you.

### `--help --json` — the structured help node

`cctl <command> --help --json` returns the native help node directly. The root
uses the same shape with `path: ""` and `kind: "root"`; groups and leaves have
`kind: "group"`, `"command"`, or `"validation"`.

The node contains `path`, `summary`, `description`, `usage`, `children`,
`arguments`, `flags`, `examples`, `related`, `skills`, and `sections`. Flags
state their source, requiredness, value constraints, and available file
alternative. Payload metadata names the byte limit and validation twin;
levels name the disclosure selectors. Help stays offline. Read mutable state
with the relevant `list` or `status` command.
