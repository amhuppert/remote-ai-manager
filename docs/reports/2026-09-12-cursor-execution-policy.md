# Cursor execution policies and migration scope: ticket #117

## Governing decision

Alex's 2026-09-12 migration-wide direction supersedes the original strict-parity
charter and the earlier instruction-only decision: maximize usable Cursor
features, accept degraded controls, and disclose backend differences through
informational UI warnings. Exact filesystem confinement and privileged
instruction priority are not prerequisites for shipping Cursor features.
The parent #110 and all siblings #111–#125 carry this policy in their current
ticket descriptions. The original audit remains historical evidence, not a
feature-admission requirement.

## Implementation

- Both Cursor facets admit governed execution and declare filesystem policies
  `instruction-only`. The neutral seam distinguishes this from `enforced` and
  `unsupported`; other backends retain their existing mechanisms.
- CC sends instructions inside a fenced user message, including the allow/deny
  paths, read-only areas, and instructions covering shell, subprocess, MCP and
  delegated-agent edits. Task sandbox and network preferences become instructions.
  Native approvals do not block task execution.
- Current instructions and write policies are delivered when creating or
  resuming a runtime, including after restart. Interrupted first turns retain
  pending instructions. Policy changes recreate the runtime with current input.
- Workflow configuration, authoring, resolved admission, and implementer
  dispatch accept Cursor for implementers, validators, plan repair, and
  collaboration staffing in full, owned and read-only modes. Model validation
  reads Cursor's generated catalog through the neutral configured-catalog seam.
- Workflow assignment editors and the conversation composer show an
  informational warning: read-only and file ownership limits rely on agent
  instructions, and native network/tool-approval limits are not enforced.
  There is no acknowledgement step or disabled choice for these limitations.
- Explicit requests for a privileged instruction channel are still represented
  honestly by the neutral contract; CC feature callers do not request that
  channel merely because execution is governed.

This is not a claim of filesystem isolation or adversarial instruction priority.
An agent can ignore these instructions, write outside assigned paths, and affect
other contexts sharing its worktree. Ownership declaration validation and CC's
commit-scoping machinery still apply; they do not prevent those writes.

## SDK and transport evidence

Verified on 2026-09-12 against installed source and the public npm package,
before implementation. No provider mock was used to establish an API limitation.

| Surface | Evidence | Consequence |
| --- | --- | --- |
| Installed `@cursor/sdk` 1.0.28 | `package.json`; `node_modules/@cursor/sdk/dist/esm/options.d.ts` | CC's pinned dependency is unchanged. No top-level `AgentOptions.systemPrompt` exists on this version. |
| Published `@cursor/sdk` 1.0.31 | [npm metadata](https://registry.npmjs.org/@cursor%2fsdk/latest), [versioned tarball](https://registry.npmjs.org/@cursor/sdk/-/sdk-1.0.31.tgz), `package/dist/esm/options.d.ts:366-388` | Adds `systemPrompt`, but replaces the whole main-loop harness prompt, requires server-side access, is not persisted, and does not replace native subagent prompts. Access denial occurs on the first send. This is an available research option, not a tested privileged guarantee. |
| Sandbox options, both versions | `export interface SandboxOptions { enabled: boolean; }` (1.0.28 line 63; 1.0.31 line 99) | No public exact write allow/deny roots, default-temp exclusion, per-destination network policy, or fail-if-unavailable control on this surface. |
| Main-loop tool selection | Both versions document that `tools` and `disallowedTools` do not constrain native subagents' curated toolsets and must be supplied again on resume. | A main-loop tool allowlist cannot prove confinement of native subagents. |
| Host callback tools | `LocalAgentOptions.customTools` documents host-process execution without interactive approval, including sandboxed/auto-review runs. | Approval or sandbox enablement alone cannot establish confinement of host callbacks. |
| CLI permissions | [Permissions](https://cursor.com/docs/cli/reference/permissions) documents separate `Shell(commandBase)`, `Write(pathOrGlob)`, and `WebFetch(domainOrPattern)` permissions. | File-tool and web-fetch permissions do not document OS enforcement over arbitrary shell/subprocess/MCP effects. |
| CLI sandbox transport | [Parameters](https://cursor.com/docs/cli/reference/parameters) documents `agent sandbox run`, a writable workspace, extra read/write and read-only paths, blocked patterns, and boolean `--network`. | This is a candidate outer process sandbox, but the documented contract does not establish CC's exact write set and trusted-server-only network policy across the worker, SDK state, MCP, and native subagents. It has not been admitted or claimed as equivalent. |

Declaration SHA-256 values:

- Installed 1.0.28 `dist/esm/options.d.ts`:
  `7b3cb70b33fd10d377761dcb168ecef9ecbd26e8d6184bc654557eb441e3befe`.
- Published 1.0.31 `dist/esm/options.d.ts`:
  `a0846936190c1e2bb2c3f45d047fae8ca0643bd075eb4bfcbe0c9d38dfce2817`.
- Published 1.0.31 tarball npm integrity:
  `sha512-0SdJQqp5oXn81oJqIVkLpgHih+CL6CAudK83pCsdJyA23AvInSWlMaGpLi+JlrK3efHoswiEhhASs9WpeEz3QQ==`.

Downloaded declarations, metadata, and documentation snapshots are retained in
the private worktree directory `.cc/temp/cursor-policy-investigation/`.
The declaration findings do not prove that every possible external OS wrapper
is impossible; they establish that the examined public provider surfaces do not
supply the required contract.

## Instruction lifecycle

- Conversations deliver a fenced block on the first turn of each runtime,
  including a runtime created with a persisted provider reference. This carries
  current instructions after CC rebuilds a runtime for an instruction change.
- Successful subsequent turns on that runtime retain the provider history and
  do not repeat the block. Failed or aborted attempts leave delivery pending.
- The outer fence is longer than any backtick sequence in the instructions, so
  an embedded code example cannot prematurely close it.
- Tasks route `systemInstructions` through the same conversation renderer,
  including task continuation in a separate worker. Scoped conversation-to-task
  continuations reuse the conversation store and preserve its raw provider
  reference. The conversation actor releases the idle worker before task
  execution takes ownership, allowing subsequent conversation turns to resume.
- Structured logging records instruction count and delivery mechanism, without
  logging instruction contents.

## Verification

Focused registered regression tests cover policy delivery on create/resume,
retry after cancellation, governed task execution, role admission, all placement
modes, UI selection and disclosure, and existing Claude/Codex paths. Behavior
reproductions failed before fixes at the workflow schema, filesystem gate,
implementer dispatch, and resolved model-catalog boundaries.

Registered checks (all passed):

- Fifteen selected regression files, with `--require-match`:
  `vrun-07942f79-30f3-4551-bda5-f0f73159b79b`.
- Final UI disclosure regression:
  `vrun-7d3c3a7c-2cf0-4f9b-a4b0-26f61193d6fd`.
- Seven continuation, actor, and output-capture regression files after the live
  handoff fix: `vrun-df01182d-63a3-4777-827c-c0496759617a`.
- Full typecheck: `vrun-624f7510-1900-4539-a844-1c638e4a996c`.
- Changed-file lint: `vrun-3bb39666-8e23-4c05-84c4-fe73183c8f81`.
- Full architecture seams: `vrun-42996ca0-6c11-4d6c-842b-395ad65b005e`.

The real SDK acceptance file `instructions.acceptance.test.ts` passed both
cases (seven authenticated turns, 66.42 seconds) on macOS with SDK 1.0.28 and
Composer 2.5. A governed conversation wrote two real receipts across changed
allowed paths and a worker restart; its continuation reference was reloaded
from disk and its replies reflected updated instructions. It then captured a
remembered token through a structured task and resumed the conversation with
the same reference and retained token. A governed validator
task wrote its review in scratch, preserved the candidate, and resumed from a
saved reference with updated instructions and retained context. Published
receipts and credential-screened raw artifacts are under
`.cc/temp/cursor-migration-continuity-live/published.jsonl`. The registered validator list
has no live Cursor command; this single-file run used the repository's narrow
diagnostic exception and production worker bundle.

UI inspection covered the workflow-assignment Storybook context at 900 and
390 pixels, and the running application's conversation composer at 1280 and
390 pixels. Screenshots were opened and inspected; warnings wrap without
horizontal overflow. Cursor remained selectable, keyboard selection worked,
and switching to Claude removed the Cursor warning. The real
`/api/agent-backends` response exposes governed execution, instruction-only
filesystem policies, and native-control warnings; its receipt is saved at
`.cc/temp/cursor-migration-policy/live-catalog.json`.

A real Cursor conversation launched saved definition
`45177451-7862-4c9c-a52a-1f11ce728311` through `cctl workflow start` with its
normal CC capability. The corrected execution
`5f0b01e3-d9ed-4a60-b98b-6eaa086f715d` completed on its first iteration in a
read-only session placement. The Cursor implementer read `candidate.txt`,
structured output capture returned `{"candidate":"CURSOR_GRAPH_CANDIDATE"}`,
and the Cursor conversation validator returned `verdict_pass` for that exact
candidate and output. Direct filesystem inspection confirmed unchanged bytes
(SHA-256 `3ed8e3c51f456b9a99ba35a82e3e1abf10cdcc5dcb661bcc8ba7d68630d18fc5`).
SQLite confirmed both execution conversations use Cursor, with no backend
fallback. Full receipts are retained in
`.cc/temp/cursor-migration-policy/graph-corrected.json` and
`live-conversations.json`. After stopping and restarting the session dev
server, the archived execution retained identical context output and validator
state (`graph-after-restart.json`). The throwaway session is removed after
verification and the dev configuration is restored.

The first live execution exposed a real continuation defect: output capture
received a conversation reference but the task runner required its own encoded
reference. Recovery produced incorrect output; a later model validator accepted
it. That execution is not counted as a successful end-to-end verification.
The reference/store handoff and idle-worker release were reproduced in failing
registered tests (`vrun-1d313af3-25c1-4226-8bfa-2686d9acd5b7` and
`vrun-23145f4b-cce4-4532-aeb5-cb3cd0808e10`) before implementation. The corrected
execution and SDK round-trip test verify the fix. This does not establish that
model validators always judge correctly.

All role and ownership combinations have admission coverage. The corrected
live workflow covers implementation, structured capture and conversation
validation in read-only mode. Plan repair also executed on Cursor during the
initial failing fixture; full collaboration behavior and every role/mode
combination remain part of the sibling migration tickets and #125's broader
matrix. This ticket does not claim completion of all sibling features.

## Provider limitations and follow-up

SDK 1.0.28 remains pinned. Native privileged instructions, exact filesystem and
network confinement, and cross-subagent policy enforcement remain unavailable or
unproven. Stronger enforcement would require a supported SDK/transport or outer
execution boundary with exact roots, denials and network destinations covering
all relevant processes and tools. It would need real adversarial verification
on each claimed platform. These are optional improvements under the governing
migration policy, not blockers for instruction-based Cursor support. Native
provider memory remains owned by #124.
