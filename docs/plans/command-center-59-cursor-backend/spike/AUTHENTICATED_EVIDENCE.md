# Cursor transport authenticated evidence

Date: 2026-08-14

## Current outcome

Select a per-conversation isolated `@cursor/sdk` Node worker for Phase 1. Its
authenticated fixture passed concurrent isolation, durable resume from a new
process, raw event preservation, model validation, generation cancellation,
real stdio MCP, and two marked shell-process cancellation trials.

Reject ACP. It reproducibly returns a cancelled prompt while leaving the
cancelled shell process alive outside the ACP process group; terminating the
whole ACP group does not remove that tool process. This violates the charter's
highest-priority isolation and cleanup gate. The SDK ran the same marked
process shape twice and native cancellation terminated it before agent close
or process-group cleanup.

## Policy and pinned environment

- Phase 1 permission policy: non-interactive bypass, matching the existing
  Claude and Codex backends. A provider-neutral mid-turn approval UI is not in
  scope.
- Repository baseline: `fa6bf4306f52926be195bef101e09598494dac3e`.
- Host: Linux x86_64, Node 22.14.0.
- Cursor CLI: `2026.08.11-e8db854`.
- SDK: `@cursor/sdk` and `@cursor/sdk-linux-x64` 1.0.28, staged without changing
  the repository dependency graph or lockfile.
- Requested model for live runs: `composer-2.5`; every `session/new` response
  reported it as the current model.
- SDK model catalog: 36 values; `composer-2.5` was present, selected explicitly,
  and preserved through resume.
- CLI invocation was pinned to its version directory and used
  `--disable-auto-update --force --sandbox enabled --trust --model
  composer-2.5 acp`.
- CLI launcher SHA-256:
  `eed61c5224668c9236334c4c68936a16aecc37374b592f59e31eb50433817831`.
- CLI entry bundle SHA-256:
  `f6fd4e6bf3d6ecbf66cc2dcabcf708b8a7c37b400d10c82a58658b5e331c36d0`.
- Bundled Node SHA-256:
  `e0e46d3a1c0667117303412647cafcbcefb1be7612493015ec8fd6b7440162a4`.
- Cursor sandbox helper SHA-256:
  `51dccdd2113f0cc0a77bbf665d7d03b31c49cbd8414f2c0529cee1b14e63077d`.

The CLI build embeds `@agentclientprotocol/sdk` 0.14.1. The separately staged
current ACP package is 1.3.0; its additional resume, close, and lifecycle types
must not be attributed to the installed Cursor binary.

## Probe safety and framing

The live probe uses a custom byte-level newline framer below JSON parsing. It
retains exact native lines in memory, records only direction, byte length,
SHA-256, method, update kind, and bounded correlation metadata, and never
prints prompt text, session ids, auth responses, or raw stderr. Child stderr is
bounded and treated as sensitive because the embedded ACP library can log full
failed requests and malformed lines.

Red-green contract command:

```text
node --test .cc/temp/cursor-acp-live/acp-client.test.mjs
```

Result: seven passing tests covering exact line preservation, fragmented input,
oversized-line rejection without echo, malformed and primitive JSON, redacted
metadata, one-turn bypass selection, unsupported request rejection, raw frame
capture, permission routing, and process-group close.

## ACP live cases

### E01 — authenticated smoke and capability negotiation

Command:

```text
node .cc/temp/cursor-acp-live/acp-smoke.mjs
```

Result: pass for ordinary interactive text.

- Existing CLI subscription authentication completed `authenticate` without a
  browser flow.
- Protocol version 1 was negotiated.
- Advertised capability keys were `loadSession`, HTTP/SSE MCP, prompt content,
  and `sessionCapabilities.list`. No resume or close capability was advertised.
- The account returned 35 model values and reported `composer-2.5` current.
- The response exactly matched the non-secret marker and ended with
  `stopReason: "end_turn"`.
- Native updates included agent message, agent thought, available commands, and
  session info frames.
- No prompt usage or `usage_update` was observed.
- EOF produced exit code 0 with no live ACP process group and no stderr.

### E04 — restart continuity and replay

Command:

```text
node .cc/temp/cursor-acp-live/acp-continuity.mjs
```

Result: continuity passes only with adapter mitigations.

- A first process stored a non-secret marker, exited, and left no process group.
- A different process loaded the opaque ref and recalled the marker exactly.
- `session/load` replayed one prior user message, one agent thought, and one
  agent message before returning. None carried a message id.
- Replay content matched the durable first-turn content. All load-time updates
  therefore need quarantine from transcript persistence and SSE broadcast;
  content-level deduplication after normal routing is not reliable.
- A random stale ref was rejected with JSON-RPC code `-32602`.
- The same valid ref was accepted with a different working directory. A Cursor
  opaque ref would need to bind and verify the CC-owned cwd before calling load.
- Cursor stored the session in its global config root rather than a CC-owned
  store. Observed `meta.json` mode was `0664`; `store.db` mode was `0644`.
  A restrictive child umask can improve new modes but cannot transfer state
  ownership to Command Center.

### E05 — generation cancellation

Command:

```text
node .cc/temp/cursor-acp-live/acp-cancellation.mjs
```

Result: pass for model generation, but not sufficient for the cleanup gate.

- Cancellation after the first agent text chunk returned
  `stopReason: "cancelled"` in 13 ms.
- Only the ACP leader remained immediately afterward.
- EOF then exited cleanly with no process group.

The first shell attempt also returned cancelled and left no process in the ACP
group, but group inspection could not prove where Cursor executed the tool. A
second fixture therefore made the tool write its exact pid and use a unique
process title before waiting indefinitely.

### E05 — marked shell descendant, repeated twice

Command, run twice:

```text
node .cc/temp/cursor-acp-live/acp-shell-descendant.mjs
```

Result: repeatable hard failure.

Both runs had the same outcome:

- ACP emitted pending and in-progress execute-tool updates.
- The marked shell process started successfully.
- `session/cancel` returned the prompt with `stopReason: "cancelled"` within 4
  ms, and ACP subsequently described the tool call as completed.
- The tool process was not parented by the ACP leader and was not in the ACP
  leader's process group.
- The marked process remained alive after native cancellation.
- It also remained alive after EOF, grace, and termination of the complete ACP
  process group.
- The probe validated the exact process by pid and unique command marker, killed
  it explicitly, and verified that no marked process remained.

Generic production supervision cannot reliably discover and kill an arbitrary
reparented tool process from the ACP stdout contract. Treating a cancelled JSON-
RPC response as cleanup would therefore leak work after a conversation stops.
This disqualifies ACP under the charter even though ordinary text, resume-by-
load, and generation cancellation work.

## Additional installed-ACP findings

- `session/load` is the only continuity method and explicitly replays the full
  history. There is no no-replay `session/resume` in this binary.
- There is no JSON-RPC shutdown or `session/close`. EOF plus process supervision
  is the only available close path.
- `mcpServers: []` retains ambient Cursor MCP configuration. Inline MCP servers
  are merged by name; ACP cannot give CC sole MCP authority on this build.
- Session state is stored under Cursor's global `acp-sessions` directory.
- Model variant configuration is persisted through a shared `acp-config.json`
  path and can race across per-conversation children. Spawning with an explicit
  validated `--model` avoids the setter for initial selection but not the shared
  persistence design.
- No live usage event was observed and the Cursor ACP implementation has no
  discovered usage-emission path. Phase 1 would declare token usage unavailable
  and `costUsd: null` if ACP were otherwise eligible.

## SDK live cases

Command:

```text
node .cc/temp/cursor-sdk-probe/live/sdk-live-bakeoff.mjs
```

Result: pass for the Phase 1 transport-selection gates.

The sanitized evidence file was 247,323 bytes with SHA-256
`fffa4595fc8cfdbcd8db680eb203896433a49a2e0f8cc3705a7ff53a70e4df96`.
It remained mode `0600`; a credential scan found no key material. Raw prompts,
events, agent refs, and tool payloads were not printed.

Red-green fixture contracts:

```text
node --test .cc/temp/cursor-sdk-probe/live/sdk-live-support.test.mjs \
  .cc/temp/cursor-sdk-probe/live/sdk-mcp-server.test.mjs
```

Result: eight passing tests for bounded private JSON, redacted event metadata,
credential rejection, round-trip raw fixtures, explicit model selection,
allowlisted error classification, the Phase 1 bypass policy, and the real stdio
MCP server.

### E01/E02 — authentication, preflight, and concurrent isolation

- CLI and SDK authentication remain distinct. `Cursor.auth.status()` does not
  reuse the CLI subscription login; SDK workers received the caller-supplied
  key through a private file descriptor, never argv or environment.
- Two authenticated turns ran concurrently in different Node processes,
  process groups, workspaces, state directories, agent refs, and sentinel
  identities. Both returned their exact non-secret response markers.
- Neither worker observed the other's sentinel or cwd, the parent environment
  remained unchanged, worker stderr was empty, and no worker process group
  survived normal close.
- All 34 files under the accumulated private runtime area denied group and
  other access. The worker sets umask `0077` before the SDK creates state.

### E03 — public-boundary event preservation

- The fixture records complete SDK public objects before interpretation, then
  stores only hashes and bounded metadata in the evidence summary.
- Raw fixtures round-tripped exactly for text, thinking, token deltas, usage,
  status, MCP and shell tool calls, results, and cancellation.
- Representative fixture hashes were
  `6a558ed63f184e03a8e7793eea2a468ca63b3e2428f9e66fd06aa126cef1f6de`
  for an ordinary turn,
  `e10866c44031691de7e1edea072ca69455f635eec73512c9e9b250008d2cc242`
  for MCP, and
  `a2fb4fdb9dcabd74ff058357f96463b2aadba597cbb4febe904539436785ca55`
  plus
  `1daa4ac808a912e0078ed3103533700245e900b487a90fc8155b8d17121f80f8`
  for the two shell-cancellation trials.
- Actual Command Center transcript-envelope integration and adversarial unknown
  SDK event injection remain implementation acceptance work; the transport
  boundary itself did not narrow the captured objects.

### E04 — restart continuity

- A different worker process resumed the first worker's caller-owned JSONL
  store and opaque agent ref, recalled the exact prior marker, and retained
  `composer-2.5`.
- Resume did not replay the prior user or assistant messages through the new
  turn's stream.
- A stale ref and the valid ref under a different cwd were both rejected.
- Tool restrictions, bypass policy, model, MCP config, and cwd must be passed
  again on every resume; those options are not all persisted by the SDK.

### E05 — cancellation and descendant cleanup

- Generation cancellation after first text completed with status `cancelled`
  in 70 ms and left no worker process group.
- Two shell trials launched an indefinite Node process with a unique process
  title and recorded its exact pid, parent pid, and process group.
- In both trials the tool process was neither parented by the SDK worker nor in
  its process group. SDK `run.cancel()` returned in 35 ms and 63 ms,
  respectively, and the marked process was already dead after native cancel.
- Both marked processes remained dead after awaited agent disposal and worker
  cleanup. No explicit marker remediation was needed, and a final host process
  scan found no probe process.

### E06/E07 — MCP and models

- A real inline stdio MCP server negotiated, advertised one deterministic tool,
  received the call, and produced the exact expected response.
- The worker used `settingSources: []`; strict MCP authority still remains
  unsupported until ambient merge, duplicate-name, disable/filter, permission,
  env, and resume-reapplication cases pass.
- The authenticated catalog contained 36 model ids and accepted explicit
  `composer-2.5`. A deliberately invalid id failed with
  `ConfigurationError`; no substitution occurred. Resume retained the declared
  model.

### E10 — usage and cost

- Finished ordinary, resumed, and MCP turns emitted stable per-turn token usage
  in both stream and result surfaces. The fixture observed input, output, cache
  read, cache write, and total token fields.
- `agent.getUsage()` returned `feature_unavailable` for both workers after the
  settlement polling window. Settled billed cost is therefore unavailable and
  Phase 1 must report `costUsd: null` rather than estimate it.

## Authentication and permission findings

Sanitized checks also prove that CLI and SDK login are distinct:

- `agent status --format json` reports the CLI authenticated.
- `Cursor.auth.status()` reports the SDK logged out in the same environment.
- Official SDK documentation says it does not read credentials from a local
  Cursor app installation.
- SDK credential resolution is explicit `apiKey`, `CURSOR_API_KEY`, or a key
  minted by `Cursor.auth.login()` and stored separately.

The live bake-off used an existing API key. The parent read it into memory,
zeroed the source buffer, and passed it to each worker over a private file
descriptor. It was absent from argv, environment, logs, public evidence, and
persisted SDK state.

The intended Phase 1 policy is non-interactive bypass. An initial SDK diagnostic
with sandboxing enabled and auto-review disabled was rejected as a
sandbox/approval configuration error. The final live fixture explicitly set
both sandboxing and auto-review off and passed text, MCP, and shell tool turns.
This policy does not establish filesystem or network confinement; those
capabilities remain unsupported.

## Current lexicographic scorecard

| Priority | Isolated SDK worker | ACP child |
| --- | --- | --- |
| Isolation and cleanup | **Pass**; concurrent isolation, private state, generation cancel, and two marked shell cancellations passed with no survivors. | **Fail**; marked shell process survives native cancel and whole-group termination, reproducibly. |
| Permissions | **Pass for the selected Phase 1 bypass policy** with sandbox and auto-review disabled; native mid-turn approval remains unsupported. | Pass with `--force` and defensive one-turn allow routing. |
| Continuity | **Pass**; a new process resumed caller-owned state without replay, rejected stale and cross-cwd refs, and retained the model. | Partial pass; load works, but replay quarantine and client-side cwd binding are mandatory. |
| MCP authority | Inline stdio MCP passes; strict authority remains unsupported pending the full ambient/disable/filter matrix. | Fail for strict authority on this build because ambient MCP is always retained. |
| Models | Catalog lookup, explicit `composer-2.5`, invalid-id rejection, and resume behavior pass. | Explicit spawn model honored; catalog exposed through session config. |
| Usage and cost | Stable per-turn token fields pass; settled billed usage returns `feature_unavailable`, so cost is unavailable. | No usage observed; settled cost unavailable. |
| Authentication/deployment | Separate SDK key and Node 22.13 artifact required. | Reuses CLI subscription login, but requires exact CLI pinning. |
| Implementation burden | Worker IPC, packaging, private store, and supervisor. | Raw framer, replay quarantine, cwd binding, global-state mitigation, and supervisor; cleanup failure is not mitigable through the public contract. |

## Side effects and cleanup

The authenticated ACP calls created Cursor ACP session records in the user's
normal Cursor config directory. They were not deleted: this binary advertises
session listing but no session-delete or session-close method, and deleting
global Cursor state manually would be destructive. All marked long-running
tool processes were killed by the fixture and a final process scan found none.

The SDK calls created only caller-owned fixture state under `.cc/temp/`. The
API-key source remained ignored and untracked. Its observed mode was `0664`;
the fixture did not alter user-owned permissions, but it should be restricted
to `0600` or removed after use. No marked SDK process survived, and no
credential material appeared in the private fixtures or sanitized evidence.
