# Cursor parity — final validation of the application matrix (2026-09-21)

Ticket command-center#125, the closing child of command-center#110, under Alex's governing Cursor migration policy of 2026-09-12: maximize usable Cursor support with the mechanisms the SDK provides, keep degraded behavior available, disclose every difference, and treat provider gaps as improvement opportunities rather than delivery blockers.

This document records one authenticated pass over the whole Cursor matrix with Cursor as the executing backend and Claude and Codex disabled for every single-backend feature. The matrix itself lives in code — `src/lib/agent-backends/cursor/acceptance/parity-matrix.ts` — and its test refuses any row whose capability facts drift from the registered descriptor, whose cited evidence no longer exists, or whose audit gap nobody claims. The fenced section below is that module's rendering, compared byte for byte by the test.

## Summary

| | |
| --- | --- |
| Matrix rows | 54 — 45 verified, 9 unresolved |
| Audit gaps closed (2026-09-04 baseline) | 42 of 42 claimed, each by exactly one row |
| Child tickets accounted for | #59 and #111–#124, every one with at least one row |
| Live acceptance suite | 17 files, 79 tests, 38 published records, all passing, 446 s |
| Application pass | 12 areas driven through the running app on an isolated dev instance |
| Defects found | 1, fixed with a failing reproduction first (collaboration handoff) |
| Unresolved rows | 9: 8 provider gaps, each named with its blocker in the matrix and in `docs/cursor-backend.md`, plus one product decision (Quick Ticket enrichment budget) |

Eight unresolved rows are provider limitations with no supported mechanism to bind to; none withholds a feature, and under the governing policy they do not block closing the parent. The ninth, Quick Ticket enrichment, is a Command Center sizing decision surfaced by this pass: the feature executes on Cursor but its output budget failed both live runs, so it is recorded as unresolved with its blocker rather than as a pass. None of the nine is a Claude-equivalent guarantee that Command Center claims to provide for Cursor.

## Baseline

| | |
| --- | --- |
| Host | macOS x86_64 (`darwin-x64`), Node v24.16.0 |
| `@cursor/sdk` / `@cursor/sdk-darwin-x64` | 1.0.31, exact pin |
| Model | `composer-2.5`, explicit selection on every run (`fast=false` unless stated) |
| Instance | this worktree's `cctl dev ensure nextjs` server at `http://localhost:3002`, its own `.config` database, transcripts, logs, and api-token; the managing server's database was not used |
| Fixture project | a throwaway git repository under `/tmp/cc-cursor-root/parity-scratch`, discovered by the instance through its own `baseDir`, with `defaultAgentBackend: "cursor"` and every workflow default (implementer, context validator, collaboration second agent, naming, compaction) pointed at Cursor |
| Backend catalog on the instance | descriptor facts read from the running server matched the matrix's descriptor facts exactly |

## Authenticated acceptance suite

The registered `cursor-acceptance` command (re-registered in `CommandCenter.json` by this ticket; `pathArgs: "forbid"`, exit 78 without a credential, never part of a merge gate) ran once on the pinned baseline: 17 files, 79 live tests, 446 s, 38 published records. Its closing sweep now also proves that every live case the parity matrix cites was produced as a pass by that run, so a renamed, skipped, or failed case stops supporting its row while the suite still holds a credential. The evidence tree is under the git-ignored `.cc/temp/cursor-acceptance/`.

Cases exercised there and cited by the matrix: credential absent/invalid/valid and CLI-login-is-not-SDK-auth, the pinned baseline, argv/environment credential scans across a worker group, two-conversation isolation, orphan and idle worker lifetime, generation/shell/MCP cancellation with host process scans, ordinary and file-operation streaming, image input, model listing/resume/rejection, inline stdio MCP and the three-transport filtering matrix, instruction delivery on resume for conversations and validators, native-memory fallback for both facets, restart continuation and invalid references, one-turn billing, and the final credential sweep.

## Application pass

Each row names what was driven through the running application, the durable evidence read back, and where it lives. Conversation and workflow identifiers are the instance's own; provider agent references are deliberately omitted.

| Area | What was driven | Durable evidence |
| --- | --- | --- |
| Session-scope chat | Conversation `3fa56711` created a file, ran `git status`, and streamed thinking, text, tool use and tool results | Transcript holds every native envelope; the row auto-named itself `Parity Note Git Status` (`name_origin=auto`) through the Cursor naming task |
| Project-scope chat | Project conversation `d12184f9` wrote `project-scope-write.txt` in the project's main worktree | `project_conversations` row on backend `cursor`, auto-named; file present on disk |
| Queue and steering | `STEER-ONE` submitted mid-turn was accepted with `deliveryTiming: in_turn` and acknowledged inside the running turn (`STEER-ONE acknowledged.`); an attachment submitted mid-turn stayed pending with the error `Cursor steering accepts text only; attachments require the next turn`, was reported as `IMAGE THIS TURN: no` by the running turn, and drained on the next turn (`green`) | `pending_queue` column captured during and after the turn |
| Images | A flat magenta PNG was named `magenta` on a prompt turn; the queued attachment above was named `green` on the following turn | Transcript entries and the queue row |
| Forks | `POST …/fork` at message 16 produced `f0715f53` with `forkMode: synthetic`, a bounded seed, and `backend_ref: null`; its first turn recalled `FORKSEED-7781` from the seed and minted its own agent | `forked_from` and `backend_ref` columns of source and fork: distinct agents, source `prompt_count` unchanged |
| Restart and resume | The dev server was stopped and re-ensured; the next prompt to `3fa56711` resumed the same agent reference and answered `TOKEN=FORKSEED-7781 COLOUR=magenta` | `backend_ref` identical before and after, `prompt_count` 7→8 |
| Capabilities | Conversation `5c7391e7` listed its delivered skills catalog (Command Center's managed bundle plus the project's), quoted the shared-memory policy sentence, ran `cctl memory recall` successfully with its own session identity, read a bundled skill's `SKILL.md`, and quoted the background-completion sentence | `agent_capabilities_runtime` column records the applied `cursor-skills`, `cursor-plugins`, `cursor-agents` cascades; `context_tokens`/`context_window_max` null; `total_cost_usd` 0 with the billing-unavailable notice |
| MCP | A stdio server and a real streamable-HTTP server (`/tmp/parity-mcp`) were configured; a conversation-level PATCH disabled one stdio tool; the Cursor turn read `VAULT-TOKEN-4417` from the allowed stdio tool, `BEACON-REMOTE-6630` from the HTTP tool (`9d72e256`), and reported the filtered tool `UNAVAILABLE` (`8c9394a4`) | `mcp_overrides` and `mcp_runtime` columns (`lastApplyDisposition: applied_now`), the HTTP server's own call log, tool inventory from the refresh endpoint |
| One-shot tasks | `POST /agent-runs` on backend `cursor` completed with a summary and two reference documents; a second run was cancelled and settled as `failed: Agent run cancelled` | `agent_run_records` rows for `e02c4759` (completed) and `bc545cc6` (failed) |
| Git assistance | `/commit` in `e4d2d1ef` produced commit `e69feaa Record Cursor validation parity note` with a generated body | `git log` before and after in the session worktree |
| Questions | Conversation `9b360f28` asked through `cc_question`; the pending batch was stored, answered over the API (`indigo`), and the same turn finished with `ANSWER=indigo` | `pending_question_id`/`pending_questions` columns while waiting, cleared afterwards |
| Background work | Conversation `a5860640` launched one `task` subagent that slept 20 s and reported `BGTASK-OK-5150`; the parent waited and answered `SUBAGENT SAID: BGTASK-OK-5150` | `cc-provider-tasks.json` in the conversation's agent store records the task (`taskType: subagent`, `status: completed`, start and last-activity times); the transcript holds the `cursor_task_delta` stream and the settled tool result |
| Costs and context | Every conversation on the instance carries the notice `Cursor billed cost is unavailable for this account (feature_unavailable)`; `total_cost_usd` is never estimated, `context_tokens` and `context_window_max` stay null | Conversation rows and transcript notices; the account's key is refused by the provider's usage endpoint, so the ledger records the durable unavailable state |
| Memory policy | The delivered instructions carried the shared-memory policy verbatim and `cctl memory recall` worked from inside the Cursor turn | Conversation `5c7391e7` answer |
| Naming | Session naming: `POST /sessions` in optimistic mode with only instructions produced the session `Cursor Name Proof` (`session.name_generation_started/completed` on backend `cursor`); conversation naming: every conversation above was auto-named | `sessions` row, `name_origin=auto` on conversations, global log |
| Compaction | `POST …/context-artifacts` (`conversation_compaction`, `wait: true`) on the 19-message conversation `3fa56711` completed on backend `cursor` with a substantive brief | `context_artifacts` row `7cbf073e` (`status: complete`, `backend: cursor`, model selection recorded) |
| `/ticket` | `/ticket …` in `4950413a` generated the ticket fields through the originating Cursor conversation and created `parity-scratch#1` with the conversation auto-attached and a compaction snapshot captured | `tickets` row, `ticket_attachments` row, the transcript notice `Created ticket parity-scratch#1` |
| Quick Ticket enrichment | `POST /tickets` with `workType: bug` and diagnostics ran the enrichment task on backend `cursor` twice (`parity-scratch#2`, `#3`); both runs failed closed at the `output_size` stage, so neither ticket received a triage note. Recorded as unresolved, see below | Global log (`tickets.enrichment.started` / `tickets.enrichment.failed`, `outputBytes` 2354 and 2251 against 2048); the diagnostic-report attachments on both tickets |
| Graph workflow | A one-off plan with one full-placement context, launched by a Cursor conversation running `cctl workflow run` with its own capability, completed in 95 s: the Cursor implementer (`c7b7e7fc`) wrote `cursor-graph-marker.txt`, the Cursor context validator (`e53ab22a`) passed it with an explicit verdict (byte count and `xxd` terminator check), and the final publish joined the lane into the session branch | Execution `1332e8fd` archived as `completed`; `graph_workflow_events` for context, task, validator-specialist and join status; commit `7e9d2f0 Graph workflow join final_publish … marker -> __session__` on the session branch; the marker file with exactly `CURSOR-GRAPH-OK-9173` |
| Collaboration | `/collab` from Cursor conversation `67d85252` against Claude, one negotiation round, completed (`asymmetric_completed_final`); Agent One's lane held the conversation's own Cursor agent reference with real token usage and no cost figure; the conversation then resumed on its next prompt and summarized the collaboration's recommendation | Workflow `3ab4fd3b` in `workflow_envelopes`, both lanes in `workflow_lanes`, `backend_ref` equal to Agent One's lane reference, `total_turns` 1→2 after the resume |
| Auth, baseline, hosts, models, isolation, cancellation, cleanup | Exercised by the acceptance suite above without weakening the existing guarantees; no worker or `sleep` orphan remained on the host after the pass | Acceptance evidence tree; host process scans |

### Defect found and fixed: collaboration handoff

The first `/collab` attempt (workflow `11d54c37`) failed at Agent One's first turn with `A Cursor worker is already active for this conversation under a different runtime owner.` The originating conversation's idle worker stays registered under its conversation id for five minutes after a turn; Agent One resumes that conversation's agent as a task under the same id with a new owner token, and the supervisor's ownership guard refuses. Ticket #119's live run had passed only because its originating worker had already expired.

The fix, written test-first:

- `src/lib/workflows/conversation/manager.ts` gains `releaseIdleConversationRuntime`, which closes a settled conversation's hosted backend runtime without evicting the actor (the next turn reopens one from the persisted reference, as after an idle expiry) and answers `busy` when an admission, attempt, stop, or checkpoint hold is in flight.
- `src/lib/workflows/collaboration/manager.ts` calls it in the dispatch chain after the start claim and before the slice runs, for both start and resume; a `busy` outcome fails the run through the same path a thrown slice does, handing the conversation back.

Live re-verification: attempt `c809ca6b` logged `conversation.runtime_closed` → `conversation-manager.idle_runtime_released` → `collaboration.manager.originating_runtime_release` and Agent One's `task.started` with `continuationKind: conversation`; attempt `3ab4fd3b` completed. Two earlier retries failed for reasons outside Cursor, recorded below.

### Observations that are not Cursor defects

- Collaboration attempt `c809ca6b` failed at Agent Two (Claude) because the model wrote its artifact path without the required `memory-bank/` prefix and the artifact-file validation refused it. Attempt `6379962e` failed at Agent One's round-1 artifact with `ENOENT` because this pass deleted the session worktree's untracked `memory-bank/` directory to unblock the graph-workflow launch while that collaboration was still running; that was an operator error in this validation, not a product fault.
- Quick Ticket enrichment ran on Cursor for `parity-scratch#2` and `#3` and failed both times at the `output_size` stage: the model returned 2354 and then 2251 bytes against the 2048-byte budget the prompt states, and the enrichment failed closed as designed (a warning, no triage note). The size rule and the failure mode are backend-neutral, but on Cursor they made the feature produce nothing in two of two runs, so the matrix row is unresolved. The decision this needs — a larger budget, a stronger instruction, or truncation to the budget instead of refusal — belongs to the feature's owner (#116) and was not made unilaterally here.
- Graph workflow launch refuses a session worktree with uncommitted changes; the first launch attempt was refused because the one-shot task flow had left untracked files behind. The refusal is correct behavior.

### Not exercised live in this pass

- **Native spec managed delivery.** Plan sign-off and approvals are human-only Spec Studio actions, so a managed delivery could not be run autonomously. The row rests on the persistence and launch tests plus ticket #118's report; the graph execution above used the same engine, staffing, and validator path.
- **Smart Commit/Merge validation fixes and conflict resolution.** Both need a failing registered validation or a real merge conflict in the fixture; their rows rest on their tests and on ticket #116's live results, carried into [Evidence carried from removed ticket reports](#evidence-carried-from-removed-ticket-reports) below.

## Unresolved provider gaps

Each of these rows is `unresolved` in the matrix with its blocker stated; the descriptor declares the corresponding capability absent, and `docs/cursor-backend.md` lists what Command Center does instead. The ninth unresolved row, `quick-ticket-enrichment`, is not a provider gap and is described under the observations above.

| Row | Blocker |
| --- | --- |
| `native-question-api` | The installed SDK rejects native questions in both main-loop and subagent execution, so no provider-held interactive request exists to bind to. |
| `provider-external-turns` | The SDK offers no completion subscription once a run has ended, so there is no supported signal to start a provider-originated turn from. |
| `mcp-config-authority` | The provider exposes no way to read or override account-level MCP administration, so authoritative configuration cannot be declared without overclaiming. |
| `per-turn-cost-attribution` | The provider never links a billing entry to the run that produced it, and host-supplied usage identifiers are not accepted, so exact per-turn attribution is unobtainable. |
| `context-occupancy` | The SDK publishes neither an effective context-window maximum nor current occupancy; public usage figures are billing totals, and checkpoint blobs are not a metrics API. |
| `privileged-instructions` | AgentOptions exposes no system or developer instruction field, so no privileged channel exists to deliver governed instructions through. |
| `filesystem-confinement` | SandboxOptions exposes only an enabled flag, with no path allowlist and no coverage of shell, direct file tools, MCP or subagents, so an exact write envelope cannot be expressed. |
| `native-memory-neutralization` | The SDK carries no memory field an embedder can set; the only memory switch in the package belongs to the server-delivered feature config. |

## The matrix

<!-- cursor-parity-matrix:begin -->
### Runtime, authentication and cleanup

| Row | Verdict | Mechanism | What Cursor does | Limitation or blocker | Owner | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `authenticated-launch` | verified | native | A worker authenticates with the explicitly supplied API key. An absent or rejected credential fails preflight with a named reason instead of starting a degraded run. | — | command-center#59 | `src/lib/agent-backends/cursor/preflight.test.ts`<br>live: `credential-live`<br>live: `preflight-credential-absent`<br>live: `preflight-credential-invalid`<br>live: `preflight-credential-valid`<br>live: `preflight-cli-is-not-sdk-auth` |
| `pinned-baseline` | verified | cc-owned | The SDK and its platform-native package are pinned together and checked against the host before a turn, so a mismatched install refuses rather than failing mid-run. | — | command-center#59 | `src/lib/agent-backends/cursor/sdk-pin.test.ts`<br>live: `baseline` |
| `credential-isolation` | verified | cc-owned | The worker and every process it spawns carry no credential in argv or environment, and the SDK writes no agent state outside the store Command Center owns. | — | command-center#59 | `src/lib/agent-backends/cursor/worker/credential-env.test.ts`<br>live: `worker-group-argv-env-scan`<br>live: `worker-concurrency-isolation`<br>live: `final-credential-sweep` |
| `worker-lifetime` | verified | cc-owned | Workers are supervised: an orphaned worker exits with its parent and an idle worker expires, so a conversation left alone reclaims its process. | — | command-center#59 | `src/lib/agent-backends/cursor/worker/supervisor.test.ts`<br>live: `orphan-worker-lifetime`<br>live: `idle-worker-expiry` |
| `cancellation` | verified | cc-owned | Cancelling a turn stops generation, a running shell descendant and a blocked MCP call, and leaves no marked process on the host. | — | command-center#59 | `src/lib/agent-backends/cursor/conversation-runtime.test.ts`<br>live: `cancel-generation`<br>live: `cancel-shell-descendant-trial-1`<br>live: `cancel-long-mcp-call`<br>live: `cancel-usage-attribution` |

### Conversations

| Row | Verdict | Mechanism | What Cursor does | Limitation or blocker | Owner | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `session-project-chat` | verified | native | Session-scoped and project-scoped conversations stream text, thinking and tool activity from Cursor and persist every native envelope as a durable transcript. | — | command-center#59 | `src/lib/agent-backends/cursor/transcript-projections.test.ts`<br>`src/lib/agent-backends/cursor/conversation-runtime.behavior.test.ts`<br>live: `streaming-ordinary-turn`<br>live: `streaming-file-operations`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `image-input` | verified | native | PNG, JPEG, WebP and GIF attachments reach the model, bounded at five images, 5 MiB decoded per image and 20 MiB per turn. | — | command-center#59 | `src/lib/agent-backends/cursor/image-input.test.ts`<br>live: `image-turn` |
| `model-catalog` | verified | cc-owned | Models come from a generated catalog minus the project's opt-out list, with parameters and variants carried through the shared model-selection contract; a model the provider rejects surfaces that rejection. | — | command-center#59 | `src/lib/agent-backends/cursor/model-catalog.test.ts`<br>`src/lib/agent-backends/cursor/model-policy.test.ts`<br>`src/lib/agent-backends/cursor/model-config.integration.test.ts`<br>live: `model-available-custom`<br>live: `model-applied-on-resume`<br>live: `model-sdk-rejected` |
| `structured-output` | verified | cc-owned | Conversations and tasks satisfy the shared structured-output contract by rendering it into the prompt and validating the answer afterwards. | No native output schema is forwarded to the provider, so a malformed answer is caught after the turn rather than prevented during it. | command-center#115 | `src/lib/agent-backends/structured-output.test.ts`<br>`src/lib/agent-backends/cursor/task-runner.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |

### Continuity, queueing and forks

| Row | Verdict | Mechanism | What Cursor does | Limitation or blocker | Owner | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `conversation-resume` | verified | native | A Cursor agent id is a real provider handle, so resume returns to that exact session rather than replaying a reconstructed thread. | — | command-center#59 | `src/lib/agent-backends/cursor/continuity.test.ts`<br>live: `continuation-restart`<br>live: `continuation-invalid-refs` |
| `restart-durability` | verified | cc-owned | A server restart reloads the backend and its opaque provider reference from SQLite, and the next prompt resumes the same Cursor agent. | — | command-center#59 | `src/lib/conversations/cursor-backend-restart.durability.test.ts`<br>live: `continuation-restart`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `durable-queue` | verified | cc-owned | A message submitted while Cursor is working is stored in SQLite and drained exactly once, preserving its model choice and images across cancellation and server restart. | Recovery after an ambiguous dispatch holds the message for review instead of replaying it, because the provider offers no delivery idempotency key. | command-center#112 | `src/lib/conversations/message-queue-service.test.ts`<br>`src/lib/conversations/message-queue-recovery.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `synthetic-fork` | verified | cc-owned | A fork seeds an independent agent and store with bounded transcript text, and the UI labels that seed as synthetic rather than as inherited model context. | Provider checkpoints and hidden state are not inherited, so a fork resumes from the visible transcript rather than from the source agent's internal state. | command-center#112 | `src/lib/sessions/synthetic-fork-seed.test.ts`<br>`src/lib/conversations/service.test.ts`<br>`src/lib/agent-backends/cursor/continuity.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `checkpoint-capture` | verified | unavailable | Command Center declares checkpoint capture, checkpoint forks and agent handoff unavailable for Cursor, so those actions are withheld rather than offered and then failing. | Cursor conversations cannot produce a Command Center checkpoint, a checkpoint fork or a handoff summary; history zoom and checkpoint-based recovery stay Claude and Codex features. | command-center#111 | `src/lib/conversation-checkpoints/fork-capabilities.test.ts`<br>`src/lib/agent-backends/cursor/descriptor.test.ts` |

### In-turn interaction and background work

| Row | Verdict | Mechanism | What Cursor does | Limitation or blocker | Owner | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `in-turn-steering` | verified | native | Text submitted during a running turn is steered into that turn through the provider's steer API, with the acknowledgement correlated to the requesting run. | Attachments and provider refusals fall back to the next turn, and an acknowledgement lost after dispatch leaves delivery uncertain for review rather than resending. | command-center#123 | `src/lib/agent-backends/cursor/steering.test.ts`<br>`docs/reports/2026-09-15-cursor-interactions.md`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `cc-questions` | verified | cc-owned | Cursor asks the user a mid-turn question through Command Center's own question tool over the SDK's supported custom-tool callback, using the existing question panel. | A question expires after five minutes, only one batch is pending per conversation, and a restarted server cannot reconnect an outstanding callback, so its marker is retired and a late reply is refused. | command-center#123 | `src/lib/conversations/in-turn-questions.test.ts`<br>`src/lib/agent-backends/cursor/worker/question-bridge.test.ts`<br>`docs/reports/2026-09-15-cursor-interactions.md`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `native-question-api` | unresolved | unavailable | The provider's own interactive request tools stay denied, and the descriptor declares no native mid-turn ask. | **Unresolved:** The installed SDK rejects native questions in both main-loop and subagent execution, so no provider-held interactive request exists to bind to. Command Center's question tool is a substitute over a supported callback, not the provider's native question API, so it cannot survive a process restart the way a provider-held request could. | command-center#123 | `src/lib/agent-backends/cursor/policy.test.ts`<br>`docs/reports/2026-09-15-cursor-interactions.md` |
| `background-tasks` | verified | cc-owned | Native subagent task calls are tracked in a durable per-conversation store and published as live background activity; tasks still running when the turn ends are marked lost and disclosed to the next turn. | Tracking ends with the turn: an unfinished task is reported as lost rather than continued, and live activity is rebuilt from the store rather than restored after a restart. | command-center#122 | `src/lib/agent-backends/cursor/background-tasks.test.ts`<br>`src/lib/agent-backends/cursor/background-task-store.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `provider-external-turns` | unresolved | unavailable | Cursor produces no turns Command Center did not start, and the descriptor declares external turns unavailable rather than simulating them. | **Unresolved:** The SDK offers no completion subscription once a run has ended, so there is no supported signal to start a provider-originated turn from. Work that finishes after a turn ends cannot wake the conversation, so an agent is instructed to complete background work inside its turn instead of relying on a continuation. | command-center#122 | `src/lib/agent-backends/cursor/descriptor.test.ts` |

### Skills, plugins and agents

| Row | Verdict | Mechanism | What Cursor does | Limitation or blocker | Owner | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `managed-skill-bundle` | verified | cc-owned | Command Center's immutable managed skill bundle reaches Cursor conversations and tasks, alongside project and user skills discovered from disk, while ambient provider settings stay suppressed. | Skills are delivered as a rendered catalog in the session instructions rather than as provider-native skill objects, and the catalog is capped at 16 KiB. | command-center#113 | `src/lib/agent-backends/cursor/capability-delivery.test.ts`<br>`src/lib/agent-backends/cursor/capability-catalog.test.ts`<br>`src/lib/managed-skills/service.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `capability-cascade` | verified | cc-owned | Skills, plugins and agents resolve through the shared cascade and are applied when the next conversation starts. | Capability selection is fixed when a conversation is created, so a change made mid-conversation is deferred rather than applied live; plugin rules, hooks and commands are not translated. | command-center#113 | `src/lib/agent-backends/cursor/runtime-config.test.ts`<br>`src/lib/agent-capabilities/cursor-runtime-state.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `command-catalog` | verified | cc-owned | The command palette lists the built-in commands Cursor can actually execute, and skill-derived commands share its slash prefix. | — | command-center#113 | `src/lib/commands/backend-command-catalog.test.ts`<br>`src/lib/commands/capability-filter.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |

### MCP

| Row | Verdict | Mechanism | What Cursor does | Limitation or blocker | Owner | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `mcp-transports` | verified | cc-owned | stdio, streamable HTTP and SSE servers all reach a Cursor turn through the worker's MCP bridge. | — | command-center#114 | `src/lib/agent-backends/cursor/mcp-translation.test.ts`<br>`src/lib/mcp/backend-capabilities.test.ts`<br>live: `mcp-parity-transports`<br>live: `mcp-inline-stdio` |
| `mcp-tool-filtering` | verified | cc-owned | Per-tool allow and deny lists are enforced by Command Center's bridge in front of every transport, so a filtered tool is never reachable from the agent. | Filtering is a Command Center bridge rather than a provider-native permission layer, so it covers the tools the bridge exposes rather than being enforced inside the provider. | command-center#114 | `src/lib/agent-backends/cursor/worker/mcp-bridge.test.ts`<br>live: `mcp-parity-transports` |
| `mcp-inventory` | verified | cc-owned | Tool inventory comes from a direct probe, and configured startup and per-tool deadlines are enforced by the bridge. | There is no provider runtime-status query, so the inventory reflects a probe Command Center performed rather than the server list the provider currently holds. | command-center#114 | `src/lib/mcp/tool-discovery-probe.test.ts`<br>`src/lib/agent-backends/cursor/worker/mcp-bridge.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `mcp-apply` | verified | cc-owned | A disabled server is omitted from the emitted configuration, and a configuration change takes effect on the next turn. | Saved changes apply when the next input is accepted. | command-center#114 | `src/lib/mcp/runtime-apply.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `mcp-config-authority` | unresolved | unavailable | Command Center supplies MCP servers inline with ambient setting sources suppressed, and declares that it is not the authoritative configuration. | **Unresolved:** The provider exposes no way to read or override account-level MCP administration, so authoritative configuration cannot be declared without overclaiming. Provider-side administrative MCP configuration is outside Command Center's resolved set, so the configuration a user sees is what Command Center supplied, not necessarily everything the agent can reach. | command-center#114 | `src/lib/mcp/backend-capabilities.test.ts` |
| `mcp-conversation-override` | verified | cc-owned | Patching MCP configuration on a conversation reads that conversation's own backend, so a Cursor conversation is applied with Cursor's timing rather than Claude's. | — | command-center#114 | `src/lib/mcp/config-route-handlers.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |

### One-shot tasks

| Row | Verdict | Mechanism | What Cursor does | Limitation or blocker | Owner | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `task-runner` | verified | cc-owned | Cursor runs one-shot tasks on the supervised worker in both the standard and isolated profiles, with full model selection, cancellation, stall handling and a task transcript. | — | command-center#115 | `src/lib/agent-backends/cursor/task-runner.test.ts`<br>`src/lib/agent-backends/task-execution.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `agent-run-cli` | verified | cc-owned | `cctl agent run` and the agent-runs API accept Cursor and execute it through the same admitted task path as any other backend. | — | command-center#115 | `src/lib/agent-runs/route-handlers.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `production-continuity-binding` | verified | cc-owned | Workflow and collaboration consumers resolve a real continuity binding — conversation identity, working directory, store and validated model — instead of the refusal the Phase 1 wiring supplied. | — | command-center#115 | `src/lib/agent-backends/cursor/continuity-binding.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |

### Agent-assisted product features

| Row | Verdict | Mechanism | What Cursor does | Limitation or blocker | Owner | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `ticket-command` | verified | cc-owned | `/ticket` generates its fields through the originating Cursor conversation rather than refusing or borrowing another backend. | — | command-center#116 | `src/lib/tickets/slash-command.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `quick-ticket-enrichment` | unresolved | cc-owned | Quick Ticket enrichment runs as an isolated one-shot Cursor task when Cursor is the configured backend. | **Unresolved:** In two of two authenticated runs Cursor's triage note exceeded the 2 KiB enrichment budget (2354 and 2251 bytes) and the enrichment failed closed, so no Quick Ticket on Cursor received a triage note; the budget or the failure mode needs a decision before this row can pass. The triage note is refused, not truncated, when it exceeds the 2 KiB budget the prompt states, so an over-long answer leaves the ticket with its diagnostic report and no triage note. | command-center#116 | `src/lib/tickets/enrichment.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `conversation-naming` | verified | cc-owned | Cursor can be selected as the conversation-naming backend and produces names through the configured naming task. | — | command-center#116 | `src/lib/conversations/name-generation.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `session-naming` | verified | cc-owned | Session names come from the configured naming backend, so a Cursor-only deployment no longer depends on a hardcoded Claude call. | — | command-center#116 | `src/lib/sessions/service.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `compaction-generation` | verified | cc-owned | Cursor can be the configured compaction backend and generates the context artifact itself. | — | command-center#116 | `src/lib/context-artifacts/service.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `commit-merge-message` | verified | cc-owned | `/commit` and `/merge` generate their message through the Cursor conversation instead of falling back to the default text. | — | command-center#116 | `src/lib/conversation-commands/service.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `validation-fix` | verified | cc-owned | Smart Commit and Smart Merge repair failing validations through a Cursor task in the merge worktree. | — | command-center#116 | `src/lib/workflows/auxiliary-cursor.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `conflict-resolution` | verified | cc-owned | Conflict analysis and resolution run as a two-turn Cursor task, the second turn returning the structured result the domain validates. | — | command-center#116 | `src/lib/workflows/auxiliary-cursor.test.ts`<br>`src/lib/sessions/conflict-resolution.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |

### Graph workflows and spec delivery

| Row | Verdict | Mechanism | What Cursor does | Limitation or blocker | Owner | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `workflow-assignments` | verified | cc-owned | Cursor is assignable as a graph workflow implementer, validator, plan-repair agent and collaboration second agent, in the schema, the assignment editor and the config cascade. | — | command-center#118 | `src/lib/workflow-graph/config-schemas.test.ts`<br>`src/lib/workflow-graph/definition-validation.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `workflow-auxiliary-runners` | verified | cc-owned | Validator, advisory-response, output-capture and plan-repair runs execute on Cursor, inheriting the assignment's backend rather than requiring a Claude fallback. | — | command-center#118 | `src/lib/workflow-graph/validator-runner.test.ts`<br>`src/lib/workflow-graph/plan-repair/agent-runner.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `owned-workflow-writes` | verified | instruction-only | Path-owned and read-only workflow placements accept Cursor: the same write envelope Claude receives is composed, delivered and briefed in the implementer prompt. | The write envelope is delivered as instructions, so a Cursor lane can write outside its owned paths; ownership violations are detected after the fact rather than prevented. | command-center#118 | `src/lib/workflow-graph/implementer-write-envelope.integration.test.ts`<br>live: `instructions-durable-resume`<br>live: `validator-instruction-policy-resume`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `spec-managed-delivery` | verified | cc-owned | A native spec's managed delivery workflow can be staffed with Cursor, and that staffing survives freeze, reload and reopen. | — | command-center#118 | `src/lib/specs/managed-workflow-definition-service.test.ts`<br>`src/lib/workflow-graph/workflow-manager.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |

### Collaboration Mode

| Row | Verdict | Mechanism | What Cursor does | Limitation or blocker | Owner | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `collaboration-mode` | verified | cc-owned | Cursor participates in Collaboration Mode in either position, against Claude, Codex or Cursor, with its lanes dispatched as task runs. A standalone /collab releases the originating conversation's idle worker after claiming the conversation, so Agent One can resume that agent even seconds after a Cursor turn. | A collaboration lane's autonomous settings cannot be enforced on Cursor, so sandbox, network and approval limits are delivered as instructions and disclosed in the collaboration row. | command-center#119 | `src/lib/workflows/collaboration/backend-pair.test.ts`<br>`src/lib/workflows/collaboration/backend-refusal.test.ts`<br>`src/lib/workflows/collaboration/agent-caller-production.test.ts`<br>`src/lib/workflows/collaboration/manager.test.ts`<br>`src/lib/workflows/conversation/manager.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |

### Cost and context

| Row | Verdict | Mechanism | What Cursor does | Limitation or blocker | Owner | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `billed-cost` | verified | cc-owned | A durable per-conversation ledger reconciles the provider's billed usage entries against Command Center turns and settles late charges as they arrive. | An account whose key cannot reach the usage endpoint records a durable unavailable state and reports no cost at all, rather than estimating one. | command-center#120 | `src/lib/agent-backends/cursor/billing-ledger.test.ts`<br>`src/lib/agent-backends/cursor/conversation-runtime.billing.test.ts`<br>`src/lib/conversations/cost-settlement.test.ts`<br>live: `billing-one-turn`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `per-turn-cost-attribution` | unresolved | unavailable | Per-turn cost is inferred from the provider's usage entries and stays unknown when it cannot be attributed. | **Unresolved:** The provider never links a billing entry to the run that produced it, and host-supplied usage identifiers are not accepted, so exact per-turn attribution is unobtainable. Cost shown for a Cursor turn is an attribution Command Center inferred, not a figure the provider tied to that run. | command-center#120 | `src/lib/agent-backends/cursor/billing-ledger-store.test.ts`<br>live: `cancel-usage-attribution` |
| `context-occupancy` | unresolved | unavailable | Context occupancy is reported as unknown. Billing token counts are never presented as a window measurement, and the UI says so. | **Unresolved:** The SDK publishes neither an effective context-window maximum nor current occupancy; public usage figures are billing totals, and checkpoint blobs are not a metrics API. No numeric context threshold can be enforced for Cursor, so occupancy-driven rotation is unavailable and the transcript shows Context unknown. | command-center#121 | `src/lib/agent-backends/cursor/descriptor.test.ts`<br>`docs/reports/2026-09-18-cursor-native-context.md` |
| `native-compaction-observation` | verified | cc-owned | A native summary message observed during a turn becomes a durable conversation notice and sets the neutral compaction signal, which a configured context-limit policy can rotate on. | The signal confirms that the provider produced a summary, not that context was successfully replaced or when that replacement began and ended. | command-center#121 | `src/lib/agent-backends/cursor/transcript-projections.test.ts`<br>`docs/reports/2026-09-18-cursor-native-context.md`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |

### Execution policy and disclosure

| Row | Verdict | Mechanism | What Cursor does | Limitation or blocker | Owner | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `capability-admission` | verified | cc-owned | Admission is decided from declared execution classes and task profiles, not from a backend name or a single task-facet boolean, so a consumer opens for Cursor only when the class it needs is declared. | — | command-center#111 | `src/lib/agent-backends/execution-admission.test.ts`<br>`src/lib/agent-backends/facet-gating.test.ts`<br>`src/lib/agent-backends/conformance.test.ts` |
| `privileged-instructions` | unresolved | instruction-only | Governed instructions reach Cursor as a fenced System Instructions block at the head of the first user message, on create and on resume, and the descriptor says so. | **Unresolved:** AgentOptions exposes no system or developer instruction field, so no privileged channel exists to deliver governed instructions through. The block has no system priority, so governed instructions are advisory text the model may weigh against the rest of the conversation. | command-center#117 | `src/lib/agent-backends/cursor/runtime-config.test.ts`<br>live: `instructions-durable-resume` |
| `filesystem-confinement` | unresolved | instruction-only | A filesystem write policy supplied to Cursor is translated into explicit instructions and is declared instruction-only on both facets; an unrepresentable policy is refused at the adapter boundary rather than silently dropped. | **Unresolved:** SandboxOptions exposes only an enabled flag, with no path allowlist and no coverage of shell, direct file tools, MCP or subagents, so an exact write envelope cannot be expressed. There is no mechanical confinement: a Cursor agent can write outside its allowed paths, and the declaration exists so no consumer mistakes the instruction for an enforced envelope. | command-center#117 | `src/lib/agent-backends/cursor/task-runner.test.ts`<br>`src/lib/workflow-graph/implementer-write-envelope.integration.test.ts`<br>live: `instructions-durable-resume` |
| `native-memory-neutralization` | unresolved | instruction-only | Command Center delivers its shared-memory policy to Cursor as an instruction and declares that it has no mechanism to disable the provider's own memory. | **Unresolved:** The SDK carries no memory field an embedder can set; the only memory switch in the package belongs to the server-delivered feature config. Cursor's native memory may remain active alongside Command Center memory, and its state cannot be read back to confirm otherwise. | command-center#124 | `src/lib/agent-backends/native-memory.contract.test.ts`<br>live: `native-memory-conversation-fallback`<br>live: `native-memory-task-fallback` |
| `execution-warnings` | verified | cc-owned | Every instruction-only limit is disclosed in the backend's execution warnings, shown wherever Cursor is selected, and none of them disables a supported feature or demands an acknowledgement. | — | command-center#117 | `src/lib/agent-backends/catalog.test.ts`<br>`src/lib/agent-backends/cursor/descriptor.test.ts`<br>`docs/reports/2026-09-21-cursor-parity-final-validation.md` |
| `network-approval-limits` | verified | unavailable | Network access and native tool approvals are not restricted for Cursor, and the execution warning states that plainly instead of implying a sandbox. | A Cursor turn reaches the network and runs native tools without Command Center approval gating, so it must be treated as an unsandboxed agent on the host. | command-center#117 | `src/lib/agent-backends/cursor/policy.test.ts` |
<!-- cursor-parity-matrix:end -->

## Evidence carried from removed ticket reports

The per-ticket Cursor reports this document names (tickets #112, #114, #116 and #118, and the earlier Cursor investigation reports) were removed from the tree in commit `8e9cc2ec7`. Each remains readable with `git show 8e9cc2ec7^:<path>`. Three verified rows had no other durable record of a live run, so their observations are carried here verbatim in substance.

| Row | Source | Observed result |
| --- | --- | --- |
| `mcp-inventory` | Ticket #114, 2026-09-10 (`docs/reports/2026-09-10-cursor-mcp-parity-validation.md`) | On the session dev server with its worktree-local datastore, the actual discovery API returned ready inventories for stdio, authenticated HTTP and authenticated SSE fixture servers. Bridge authentication, filtering, deadlines, environment, disconnect and sanitized tool errors were exercised against real bridge clients in `vrun-007c5d18-7a3d-4932-bdb6-1d5aa721f8c9`; inventory authentication diagnostics passed in `vrun-7578cdfb-707f-41b3-ae34-88dafb9cb40e`. |
| `validation-fix` | Ticket #116, 2026-09-14 (`docs/reports/2026-09-14-cursor-auxiliary-consumers.md`) | With actual Cursor SDK calls through the production fresh-task path, the validation auto-fix repaired `answer.cjs` from 322 to 323 in a scratch repository. The real Node assertion then passed and the service result was `fixed`. |
| `conflict-resolution` | Ticket #116, 2026-09-14 (`docs/reports/2026-09-14-cursor-auxiliary-consumers.md`) | The production fresh-task path analyzed a real Git conflict in `colors.txt` and left its contents unchanged. The production resolver then removed the conflict, preserved lavender, green and blue, and staged a result with no unmerged paths or conflict markers. |

## Validation

All checks ran through the registered `cctl validate run` commands.

| Check | Run |
| --- | --- |
| Conversation manager (idle runtime release, red then green) | `vrun-3ff48b68-99cf-496f-97bc-94adf6b31bbd` → `vrun-72ae6f00-3dc4-412c-94c2-b52d71935f0a` |
| Collaboration manager (handoff ordering and busy refusal, red then green) | `vrun-c3f166a9-278e-4181-b198-cc968d4d3aaf` → `vrun-b15b0ed8-cab9-4a77-8259-fac6b168f38c` |
| Parity matrix and published documents, with the changed-scope input-selection contract | `vrun-412ed2bc-aa70-4618-970b-5ec4edaf963f` |
| Changed-scope tests (2122 files, 29203 tests) | `vrun-47ef5d7e-0025-452d-87ce-d56bb4e21428` — two failures, both the matrix test's over-broad `@vitest-inputs` declaration (`docs/reports/**`), narrowed to the Cursor report files and re-run green in the row above |
| Typecheck | `vrun-737b4cdc-d577-45fb-b801-0416bd34f49e` |
| Lint | `vrun-d1610661-b96b-41ff-adb3-141def637f2f` |
| Seams | `vrun-9a693572-fdbb-4041-a20b-0eda24c4fa17` |
| Format | `vrun-4c9ea28c-8bb8-490d-93bd-a92ccaf78622` |
| Authenticated `cursor-acceptance` | local run, 17 files / 79 tests / 38 records, exit 0 |

## Evidence retention and cleanup

Bounded, sanitized identifiers and observations from the pass are in [`2026-09-21-cursor-parity-final-validation.evidence.json`](./2026-09-21-cursor-parity-final-validation.evidence.json): conversation, workflow, execution, ticket, and validation-run identifiers, outcomes, and the durable fields read back. It carries no credential, no provider agent reference, and no prompt contents. Raw drivers and JSON captures remain under `/tmp/cc-cursor-125-evidence/` and `.cc/temp/` on this machine; the fixture repository is `/tmp/cc-cursor-root/parity-scratch`.

The extra scratch session created for the naming check was deleted through the sessions API (worktree removed). The fixture MCP servers were stopped, no Cursor worker or shell descendant from the pass remained on the host, and the scratch project stays discoverable only by the dev instance's own configuration.
