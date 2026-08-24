# Cursor Phase 1 — authenticated acceptance evidence

Record of the live acceptance matrix required by spec R14.2 and D19. Every
figure below was produced by one run of the registered `cursor-acceptance`
validation command against a real Cursor account.

Structural figures — case counts, published-record counts, findings, survivor
counts — are stable and are what this document asserts. Per-run figures — token
counts, latencies, pids, event counts — necessarily differ between runs against
a live model, so they are illustrative of one run rather than a contract. The
evidence tree in a worktree reflects that worktree's most recent local run.

Support is per host: each entry in `CURSOR_SDK_EVIDENCED_HOSTS` is backed by a
green run of this matrix on that host. Two baselines are recorded below; the
detailed narrative that follows describes the original Linux run, with the
macOS section noting where its observations differ.

## Pinned baseline — Linux x86_64

| | |
| --- | --- |
| Host | Linux x86_64 |
| Node | v22.14.0 |
| `@cursor/sdk` / `@cursor/sdk-linux-x64` | 1.0.28 (exact pin, no range) |
| Default model | `composer-2.5` |
| Run | 12 acceptance files, 66 cases, 26 published records, all passing, 146.1 s |

## Second baseline — macOS x86_64 (2026-08-23, ticket #88)

| | |
| --- | --- |
| Host | macOS x86_64 (`darwin-x64`, Intel) |
| Node | v24.16.0 |
| `@cursor/sdk` / `@cursor/sdk-darwin-x64` | 1.0.28 (exact pin, no range) |
| Default model | `composer-2.5` |
| Run | 12 acceptance files, 66 cases, 26 published records, all passing, 187.3 s |

The same matrix, driven through darwin-native process inspection: argv and
environment reads come from the `KERN_PROCARGS2` sysctl (raw NUL-delimited
records, exactly what `/proc` supplies on Linux — `ps -E` flattens them and was
rejected for that reason), process identity and group membership from `ps`, and
working directories from `lsof`. Key observations from the green run:

- Cancellation: generation settled in 180 ms (bound 10 000 ms); marked shell
  descendants were dead 58 ms and 56 ms after **native** cancel, each leading
  its own process group; the long-running inline MCP call settled in 102 ms
  with the server gone at 69 ms and zero survivors. Cancelled runs reported no
  usage.
- Bounded lifetime: a `SIGKILL`ed Command Center server left its worker gone in
  78 ms with its process group; an idle worker with a 4 s TTL was reaped at
  4 974 ms.
- Continuation recalled the prior turn's marker with zero replayed events;
  random, corrupt, and cross-workspace refs all failed closed with
  `AgentNotFoundError`.
- The closing sweep scanned 443 sources including 4 live process-boundary
  snapshots, checked 21 workspaces for SDK default-state leakage, and found
  zero credential occurrences — for the Cursor key and for every ambient
  credential-shaped variable alike.

**Limit specific to this host:** no Cursor CLI (`agent`) is installed, so the
`preflight-cli-is-not-sdk-auth` case ran in its reduced form — it proved the
SDK finds no ambient credential in a scrubbed child (`cliState: "absent"`,
`sdkLoggedIn: false`) but could not re-demonstrate that an *authenticated* CLI
is ignored. That stronger half remains evidenced by the Linux run only.

Two suite defects surfaced by this run were fixed for every host: worker logs
now route to a durable `logs/acceptance.log` inside the evidence root (the
per-fork vitest config directories are deleted per file, which had silently
removed the log surface from the sweep), and the launcher pins `final-*` files
last with a custom sequencer (Vitest's duration cache had reordered the closing
sweep ahead of the cases it audits on any second run).

The baseline is asserted live, not stated: `harness.acceptance.test.ts` runs the
production static preflight against the real `node_modules` and fails the suite
if the host, Node version, SDK version, platform package, or its native assets
differ from the pin.

## Running it

```bash
cctl validate run cursor-acceptance
```

The suite needs `CURSOR_API_KEY` in the environment of the process that runs it.
Absent, it does not skip quietly:

```text
cursor-acceptance: verdict=blocked reason=credential_absent
cursor-acceptance: CURSOR_API_KEY is not set in this environment, so no authenticated Cursor turn can run.
cursor-acceptance: no live evidence was produced — this is NOT a pass. …
```

and exits **78** (`EX_CONFIG`) — deliberately neither `0` nor `1`, so a blocked
run is legible as its own third state rather than as a pass or as ordinary test
failures. A credential the provider rejects does not produce a green run either:
the harness authenticates through the same worker SDK port production uses
before any case runs.

The command is registered with `pathArgs: "forbid"` and is deliberately **not**
in `preMerge` or `laneMerge` — a merge gate must not depend on a credential.

Until this branch merges, `cctl validate list` does not show `cursor-acceptance`:
Command Center resolves the validation registry from the canonical project root,
not from a session worktree. The runs recorded here invoked the registered
wrapper directly (`bash scripts/validate/cursor-acceptance.sh`), which is the
same executable the registration names.

## What the run observed

### Preflight taxonomy (R3.1)

| Case | Observed |
| --- | --- |
| Absent credential | `preflight_failed` / `missing_credential`, refused before any worker process existed |
| Empty credential | identical to absent |
| Provider-rejected credential | `preflight_failed` / `invalid_credential`; the rejection message did not echo the key |
| Valid credential, create start | `ready` |
| Valid credential, resume start | `ready` in a distinct worker process |
| Cursor CLI logged in, SDK not | CLI `isAuthenticated: true`; `Cursor.auth.status()` in a credential-scrubbed child reports `logged-out` |

An authenticated Cursor CLI is therefore **not** SDK authentication, and
preflight does not treat it as such.

### Concurrency and isolation (R4.1, R4.3)

Two conversations started together and alive at the same moment differed on
every axis checked: pid, process group (each worker leads its own), working
directory read from `/proc/<pid>/cwd`, store path, continuation ref, and the
`CC_*` session identity in its environment. Neither worker's environment
contained the other's workspace, store, or session name. No worker environment
contained `CURSOR_API_KEY`. The parent's controlled environment keys were
byte-identical before and after. No caller-owned state file was readable or
writable by group or other. `git worktree list` in each conversation's
repository reported exactly one worktree.

### Streaming, file operations, usage, cost (R5.1, R8.1, R17)

An ordinary turn produced 14 native events across 4 classes
(`status`, `thinking`, `assistant`, `usage`), monotonically indexed from 0 under
one run id, every one round-tripping losslessly through the native envelope, and
exactly one usage record (11 478 in / 42 out / 18 016 total).

A file-operation turn produced 38 events including 9 `tool_call` events, and the
workspace matched the claims: the file the agent said it created exists, the file
it said it deleted does not, and the seeded token it read appears in the stream.

`costUsd` is `null` on every case. Nothing estimates cost from tokens, model
names, or published rates.

### Continuation (R7.1, R7.3)

After the owning worker was closed with verified teardown, a new worker resumed
the persisted ref in the same workspace and store, recalled a marker only the
first worker's turn established, and emitted **zero** replayed events — every
forwarded event belonged to the new run, and the prior turn's assistant text did
not reappear. The resumed turn reported one usage record (23 412 total tokens).

Random, corrupt, and cross-workspace refs each failed closed with
`AgentNotFoundError`, returned no ref, attached to nothing, and left a worker
that closed with verified teardown.

### Model selection (R10)

| Case | Observed |
| --- | --- |
| Default | `composer-2.5`, source `default`, selected explicitly |
| ID absent from the project list | refused before any worker started |
| Listed custom ID (`composer-2`) | live turn completed |
| ID the SDK rejects | `ConfigurationError` at attach; **no substitution** — nothing answered on another model |
| Resume | the declared model is genuinely applied: a resume carrying the rejected id is refused, so resume does not silently reuse the created model |

The rejected-ID case is what makes the others meaningful: if a bogus id had
quietly produced a good answer, the id Command Center sends would be decorative
and the "default" would be provider auto-selection wearing our label.

### Inline stdio MCP (R12.1)

A real stdio MCP server negotiated under `settingSources: []`, received one call,
and returned a reply carrying the marker Command Center placed in the entry's
explicit `env` — proof the whole path ran, not just the call. 2 `tool_call`
events, ordered and monotonically indexed alongside every other native event,
and one usage record for the turn (64 974 total tokens).

No test or production path read or wrote Cursor's own user or project MCP
configuration.

### Cancellation (R9.1, R9.2, R9.3)

| Case | Settle | Host scan |
| --- | --- | --- |
| Generation | 76 ms (bound 10 000 ms) | worker group gone |
| Marked shell descendant, trial 1 | dead 46 ms after **native** cancel | still dead after disposal and cleanup |
| Marked shell descendant, trial 2 | dead 44 ms after **native** cancel | still dead after disposal and cleanup |
| Long-running inline MCP call | 52 ms; server gone 56 ms | zero survivors |

Each produced exactly one `cancelResult` and one `aborted` terminal outcome. The
shell trials recorded the marked process's pid, ppid and pgid while it was alive
(trial 1: 3597903 / 3597519 / 3597903; trial 2: 3598345 / 3597955 / 3598345) —
each led its own group. Death was measured **after native cancellation and before
the worker's process group was touched**, which is the exact behaviour that
distinguished the SDK from ACP in the transport bake-off.

A cancelled run reported **no** usage records: no fabricated tokens, and no other
run's usage attributed to it.

### Bounded worker lifetime (R9.5)

- Command Center server killed with `SIGKILL`, no orderly shutdown: the worker
  was gone in **51 ms** and took its process group with it.
- An idle worker with a 4 s TTL was reaped at **5 221 ms**.

### Image input (R16.1)

A 254-byte PNG generated byte-for-byte in code
(`sha256:6ffeb5c3f137d2cccf322871f18313ef46041223cf3f53a47b9e1e1278488d11`)
was translated through the production `translateCursorImages` path and sent as a
turn input. The model's answer reflected the image's actual content. 16 native
events, ordered, every one round-tripping losslessly.

The turn then goes through the **real Command Center transcript boundary**, not
a private artifact: the user message is built by `buildUserTranscriptBlocks`, the
native events by the production `projectCursorNativeEvent` and
`conversationTranscriptFrame`, and each frame is appended through
`appendTranscriptEntryOnce` — the id-checked idempotent path production uses for
Cursor's run-scoped ids. Reading back with the caches cleared, the way a
restarted server does: the user turn's `image_ref` block survives with its
persisted path, the image-derived answer survives, and 16 entries persist from
32 appends, because every frame was appended **twice on purpose** and the
run-scoped id deduplicated it.

The image capability rests on this fixture. It is exercised through the same
translation the conversation runtime calls, not a hand-built SDK payload.

### Credential containment (R6.2)

The closing sweep scanned **464 sources** — raw fixtures, published records,
worker logs, transcripts, caller-owned SDK stores and every workspace the matrix
created — plus the SDK's own default credential store. **Zero findings**, for
both the literal value and its base64 encoding.

**A Cursor worker inherits no credential at all.** `CURSOR_API_KEY` is handed
over private IPC and never appears in the worker environment, but excluding it
alone would still have copied the server's *other* credentials into a worker —
and from there into every unsandboxed shell tool and inline MCP server the model
chooses to run. `buildWorkerEnv` therefore drops the whole credential-shaped
surface from the inherited environment before spawning
(`worker/credential-env.ts` owns the rule: `API_KEY`, `TOKEN`, `SECRET`,
`PASSWORD`, `PASSWD`, `CREDENTIAL`, with `KEY` matched only as a whole
underscore-delimited segment so `KEYBOARD_LAYOUT` survives). Command Center's own
`CC_API_TOKEN` is unaffected — the session contract *places* it after the filter
runs, rather than inheriting it, so `cctl` keeps working inside a Cursor session.

Measured live this run: across both worker groups, both marked shell
descendants, and the inline MCP server, **zero credential-shaped variables** were
present in any captured environment.

> Operator note: this is a deliberate asymmetry with Claude and Codex sessions,
> which still inherit the server environment whole. A Cursor agent cannot read
> `GITHUB_TOKEN`, `OPENAI_API_KEY`, or similar from its environment.

The sweep is not limited to the Cursor key either. It scans for **every
credential-shaped variable in the environment the run inherited** (9 this run,
the Cursor key among them), using the same rule the supervisor strips by — so
the suite looks for exactly what production claims to withhold rather than for a
narrower definition of its own. Zero findings.

Files are not the whole surface. `/proc` entries vanish when a process is
reaped, so each live case reads the **argv and full environment of every process
in its worker's group while those processes are alive** and scans them there.
Four snapshots were captured this run: both worker groups from the isolation
case, the marked shell descendant in each cancellation trial, and the inline MCP
server mid-call — real children the worker spawned, which is precisely the "any
environment the worker passes to its children" boundary. Zero findings on all of
them, for the Cursor key and for every ambient credential alike. That second
scan runs **on the live `/proc` bytes**, not on the artifact: the artifact is
redacted, so a check that ran afterwards could not have seen a third-party
credential in a worker or tool environment at all.

What is *persisted* from those captures is redacted: every environment value is
replaced by its byte length and a truncated sha256, and each block carries the
verdict of the live scan that produced it. Keys survive, values do not — so the
snapshot still proves what it exists to prove (`CURSOR_API_KEY` absent from
every worker environment, the real `CC_SESSION=` contract present in both), and
the closing sweep asserts every persisted assignment matches the redacted shape.
The digest keeps it auditable: a reviewer holding a suspected value can hash it
and compare. Redaction covers all values rather than credential-shaped names
only, because a server environment carries connection strings and socket paths
under names no allow-list can enumerate.

For each of the 21 workspaces the run created, the SDK's default per-workspace
state root (`~/.cursor/projects/…/sdk-agent-store/…`) was checked and **none had
been created**: every conversation persisted only into its Command Center-owned
store. `~/.cursor/sdk/auth.json` does not exist at all. No marked worker, tool,
or MCP process survived on the host.

## Evidence hygiene

Raw fixtures — full native event streams — stay under
`.cc/temp/cursor-acceptance/`, which is git-ignored, created `0700`, with files
written `0600`. The tree is cleared at the start of every run so a set of records
always describes one matrix.

Published output is `published.jsonl`: bounded metadata and sha256 digests only,
enforced at the write boundary by a Zod schema (metric strings capped at 200
characters, digests matched against `^[0-9a-f]{64}$`). The same boundary refuses
any record containing registered credential material, so the guard is structural
rather than a convention each case must remember. The closing sweep re-reads the
file through that schema, so the claim is about the file a reviewer opens.

## Four claims that were weaker than they looked

All four were caught in review of earlier versions of this suite, and all four
are worth stating because each weak version passed its own tests. The last three
are the same claim failing three different ways, which is the point.

**The image case proved SDK delivery, not persistence.** It decoded the
in-memory worker frames and wrote them to a private artifact, then called that a
transcript round trip. It never touched Command Center's transcript writer or
reader, so a persistence regression could not have failed it. It now runs the
real chain — `buildUserTranscriptBlocks`, `projectCursorNativeEvent`,
`conversationTranscriptFrame`, `appendTranscriptEntryOnce`,
`readConversationMessages` with the caches cleared — and appends every frame
twice on purpose so exactly-once is demonstrated at the durable boundary rather
than assumed from the runtime that feeds it.

**The credential sweep scanned files, not processes.** `/proc` argv and
environment readers existed and were unit-tested, but no live case pointed them
at a worker, a shell tool, or an MCP server — so the boundary the criterion
actually names, "any environment the worker passes to its children", went
unchecked while the sweep still reported clean. Capture now happens inside each
live case while the processes exist, covers the whole worker process group, and
persists the bytes for the closing sweep to re-scan. The sweep asserts the
snapshots exist and carry a real session contract, because a scan over nothing
is the easiest way to report zero findings.

**The fix for that leaked other people's credentials.** Capturing the process
boundaries was right; persisting them verbatim was not. A worker inherits the
Command Center server environment, which on a real host carries third-party API
keys that have nothing to do with Cursor — so the first version of the capture
wrote every one of them into a raw evidence file, while the scan, which knew
only the Cursor key, reported the file clean. Values are now redacted to a
length and a digest before anything reaches disk, and the sweep scans for every
credential-shaped variable in the inherited environment rather than for the
Cursor key alone. The general lesson: a check that proves *one* secret is absent
is not a check that no secret is present, and an artifact written to prove
containment is itself a containment boundary.

**And redacting the artifact blinded the scan that needed it.** Redaction
stopped the leak into the evidence tree, but it also meant the broadened ambient
scan — which ran over the persisted files — could no longer see a process
environment at all. A worker or tool child could have carried the server's other
credentials and the run would still have reported zero findings. Two changes
close it: the ambient scan now runs at the live capture, on the unredacted
`/proc` bytes, and the supervisor stops the credentials reaching a worker in the
first place, so the scan is checking a property production actually enforces
rather than reporting on one it does not. The rule lives in one module that both
consumers import, so the suite cannot drift to a narrower definition than the
spawn boundary applies.

## Limits of this evidence

- Each baseline describes one host, one SDK build, one account, and one run.
  Preflight fails closed on any SDK/platform combination outside the evidenced
  set rather than extrapolating.
- The matrix drives the production supervisor, worker bundle and SDK. Neutral
  conversation-runtime projection, transcript persistence and SSE behaviour are
  proven by the scripted-worker suites, not here.
- Strict MCP authority remains **unsupported**. An ordinary inline call passing
  is not the authority matrix (ambient merge, duplicate names, per-run
  replacement, disable/filter, permission, environment); that is a separate gate.
- The Phase 1 permission policy runs with `sandboxOptions.enabled: false` and
  `autoReview: false`. Successful unsandboxed tool execution establishes
  **nothing** about filesystem or network confinement, and neither is claimed.
- Task facet, native mid-turn ask, external turns, context-window metrics,
  bundled managed skills, native fork and parity all remain unsupported.
