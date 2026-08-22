# Cursor transport bake-off protocol

## Purpose

Choose exactly one Phase 1 production transport:

1. a per-conversation Node child running `@cursor/sdk`; or
2. a per-conversation `agent acp` child using newline-delimited JSON-RPC.

The comparison uses the same workspaces, prompts, MCP fixture, lifecycle
timeouts, and redaction rules. A public API or documentation claim is useful
background, but it does not count as a live pass.

## Tested versions and host

| Item | Observed value | Status |
| --- | --- | --- |
| Bundle baseline / current HEAD | `fa6bf4306f52926be195bef101e09598494dac3e` | matched |
| Host | Linux x86_64, kernel 6.8 | supported candidate |
| Node | 22.14.0 | satisfies SDK `>=22.13` |
| Bun | 1.2.15 | packaging comparison only |
| Bubblewrap | 0.9.0 | available |
| `@cursor/sdk` | 1.0.28, published 2026-08-13 | staged and authenticated live fixture passed |
| `@cursor/sdk-linux-x64` | 1.0.28 | staged matching platform package passed |
| `@agentclientprotocol/sdk` | 1.3.0 | package research available; not installed |
| Cursor Agent CLI | `2026.08.11-e8db854` | installed, pinned, and authenticated |
| Cursor CLI embedded ACP SDK | 0.14.1 | materially older than staged ACP 1.3.0 |
| Cursor CLI login | authenticated subscription login | usable by ACP only |
| Explicit Cursor API key | caller-supplied; never placed in the environment | private-fd SDK injection passed |

Do not install or update Cursor, inspect a user credential store, or start an
SDK login that mints an API key as part of the spike without Alex's explicit
direction. Always spawn the pinned CLI with `--disable-auto-update`. The
authenticated SDK fixture used the existing key Alex supplied for this test;
it did not mint or persist another credential.

Phase 1 uses the same non-interactive bypass policy as the existing Claude and
Codex backends. Prefer a one-turn allow response when ACP asks defensively; do
not persist a global allow decision. Native mid-turn approval UI is not a
transport differentiator for this phase.

## Evidence states

- **pass**: captured by an authenticated fixture on the pinned version and host.
- **fail**: the pinned implementation violates the requirement in a repeatable
  fixture.
- **partial**: useful behavior exists but a required edge or authority rule
  fails.
- **unknown**: documentation, types, or protocol permit the behavior, but the
  authenticated fixture has not proved it.
- **not exposed**: the public transport has no corresponding surface.

Every fixture records the transport, version, host, case id, timestamps,
process ids, exit/signal state, bounded event metadata, hashes for identity
markers, and a redacted result. It never records prompts, credential values,
auth responses, unbounded stderr, or raw secret-bearing tool payloads.

## Decision order and gates

Evaluate categories lexicographically in this order rather than hiding a fatal
failure inside a weighted total:

1. isolation and cleanup;
2. permissions;
3. continuity;
4. MCP authority;
5. models;
6. usage and cost;
7. authentication and deployment;
8. implementation and fixture burden.

Phase 1 is a no-go for a transport if load/resume, bounded cancellation with no
orphan children, or lossless public-boundary event framing is unstable. Neither
candidate may claim filesystem enforcement, privileged instructions, or
authoritative MCP behavior unless the corresponding adversarial cases pass.

## Shared experiment cases

### E01 — preflight and version negotiation

- Capture the exact version and capability response.
- Exercise missing credentials, invalid credentials, and a valid credential.
- Confirm errors and bounded stderr contain no credential or auth-response
  material.
- Repeat with a deliberately unsupported version or mocked version response.

### E02 — concurrent isolation

- Start two conversations in distinct child processes with distinct workspaces,
  `CC_*` marker hashes, credential handles, agent/session refs, and process
  groups.
- Run turns concurrently and confirm neither process observes the other's cwd,
  marker hash, ref, events, or store.
- Confirm the parent server environment is unchanged.

### E03 — event and framing coverage

- Capture text, thinking, file read, file edit/write, shell, MCP, permission,
  subagent/task, image, usage, terminal error, and cancellation events.
- Preserve the complete public-boundary SDK object or exact ACP stdout line
  before interpretation.
- Inject unknown fields/types and malformed input through a fake transport.
  Unknown data must survive; malformed data must become a bounded protocol
  error without crashing or being echoed unbounded to logs.

### E04 — durable continuity and replay

- Create, prompt with a unique non-secret marker, persist the opaque ref, and
  kill the owning process.
- Start a new process, load/resume with the same cwd and configuration, and ask
  for a response that proves prior-turn context.
- Repeat with stale, deleted, corrupt, cross-workspace, and already-active refs.
- Record replayed frames separately and prove they do not duplicate durable CC
  transcript content.

### E05 — cancellation and cleanup

- Cancel during generation, a long shell command, MCP execution, and a pending
  permission or interactive request.
- Request native cancellation, apply the same grace timeout, then terminate the
  process group if needed.
- Inspect the process tree after each case and require zero surviving child or
  grandchild processes.

### E06 — MCP authority

- Inject the same real stdio MCP fixture through the transport's public client
  surface.
- Test project and user ambient configuration, duplicate names, empty inline
  configuration, per-run replacement, disable/filter behavior, approval, env
  handling, and reapplication after resume.
- Do not mutate the user's Cursor configuration. Ambient fixtures live in an
  isolated workspace/config root under this spike.

### E07 — models

- Capture the authenticated account catalog and a stable default candidate.
- Exercise one catalog model, one valid custom id, one invalid id, and a removed
  or unavailable id.
- Resume and confirm the declared model behavior; no silent substitution is
  allowed.

### E08 — instructions and structured result

- Exercise the first-turn instruction envelope and determine its actual
  priority relative to user/project instructions.
- Request the shared JSON-schema result contract, validate it, and run one
  bounded repair attempt.
- Record privileged instruction delivery as unsupported unless precedence is
  directly proven.

### E09 — filesystem and network

- Test direct file tools, shell writes, absolute paths, symlinks, temp paths,
  subprocesses, MCP/custom tools, and outbound network.
- Run both unsandboxed and every intended sandbox/permission configuration.
- The Phase 1 descriptor remains `fsWriteRestriction: "unsupported"` even if
  this probe succeeds; a declaration change requires its own review.

### E10 — token usage and settled cost

- Capture per-turn token fields, cancellation/retry behavior, and correlation
  ids.
- Query billed usage until the bounded settlement window ends.
- Report cost only when a settled charged amount is unambiguously correlated to
  the turn; otherwise record `null`.

## Candidate-specific capture

### SDK worker

- Spawn one Node child per active conversation and pass fixed cwd, config,
  credential, and CC identity at spawn.
- Use a caller-owned store under the isolated fixture directory.
- Capture both `Run.stream()` messages and `onDelta` updates without narrowing
  unknown objects before the raw envelope is written.
- Re-pass tool restrictions and inline MCP configuration on `Agent.resume()`;
  the SDK documents that they are not persisted.
- Treat `run.cancel()` as the native request, then apply the shared process-group
  cleanup policy.

### ACP child

- Spawn `agent acp` as the process-group leader and tee exact stdout lines
  before JSON parsing.
- Do not rely on a typed NDJSON helper that drops malformed frames or echoes
  full bad lines to stderr.
- Capture `initialize` capabilities before using `session/load`, model, MCP, or
  optional session methods.
- Treat `session/cancel` as the native request, then apply the shared
  process-group cleanup policy.
- Separate replay emitted by `session/load` from new turn events.

## Decision artifact

The final record must include a pass/fail/unknown table linked to each fixture,
the process-tree and auth/deployment findings, the selected transport and
rejected alternative, exact Phase 1 capability declarations, unresolved vendor
gates, and an explicit go/no-go result.

The completed result is recorded in `TRANSPORT_DECISION.md`, with detailed live
observations in `AUTHENTICATED_EVIDENCE.md`. Cases E01/E02, the exercised E03
native event classes, E04 restart/stale/cross-cwd behavior, E05 generation and
marked shell cleanup, an ordinary E06 stdio MCP call, E07 catalog/invalid/resume
behavior, and E10 per-turn usage were sufficient to settle the transport
choice. The remaining adversarial breadth is retained as Phase 1 implementation
acceptance work and does not authorize stronger capability declarations.
