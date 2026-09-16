# Codex app-server protocol contract

Research date: 2026-09-16. Runtime inspected: the repository-installed `codex-cli 0.153.3`. This is a version-pinned protocol audit, not a claim that a schema establishes runtime behavior. The proof of concept supplies the behavioral evidence used by the technical design.

## Sources and reproduction

The official [Codex App Server documentation](https://developers.openai.com/codex/app-server/) establishes the lifecycle and intended integration. Wire field names and enum values below come from the installed executable's generated schemas. Those take precedence over examples on the changing documentation page.

```bash
node node_modules/@openai/codex/bin/codex.js --version
node node_modules/@openai/codex/bin/codex.js app-server generate-json-schema \
  --out .cc/temp/codex-steering-research/schema
node node_modules/@openai/codex/bin/codex.js app-server generate-json-schema \
  --experimental --out .cc/temp/codex-steering-research/schema-experimental-audit
```

The stable bundle `codex_app_server_protocol.schemas.json` inspected here has SHA-256 `e8284c5cb8157554a3dd1e035aadbd4325aea501af56887e9c2e12eb1b9b9448`. Schema names in the following sections are paths relative to the generated schema directory. The full generated output and downloaded documentation are temporary research artifacts; the commands reproduce the pinned protocol surface. The implemented adapter checks in only its relevant generated TypeScript subset in `src/lib/agent-backends/codex/app-server-protocol-generated.ts`, with runtime envelope/field validation in `app-server-protocol.ts`.

Two documentation examples disagree with this runtime: `thread/start.sandbox` accepts `workspace-write`, not `workspaceWrite`; approval policy accepts `untrusted`, not `unlessTrusted`. The object-valued `turn/start.sandboxPolicy.type` does use `workspaceWrite`. Do not copy these literals between interfaces.

## Transport and handshake

Use `codex app-server --listen stdio://`. The documented default is stdio. Each physical LF-delimited stdout record is one JSON-RPC message, with the `jsonrpc` header omitted. Stdin stays open to carry requests, notifications, and responses to server requests. Stderr is a separate diagnostic stream.

Send one `initialize` request, await its response, then send an `initialized` notification. `v1/InitializeParams.json` requires `clientInfo.name` and `clientInfo.version`; title is optional. The documentation says requests before initialization receive `Not initialized`, and repeated initialization receives `Already initialized`.

Use `capabilities: {experimentalApi: false}`. `turn/steer` and its required fields are present in the stable generated `ClientRequest.json`; steering does not require experimental opt-in. The experimental schema adds only `additionalContext` and `responsesapiClientMetadata` to `TurnSteerParams`. Neither is needed for CC user-message delivery.

Keep the v2 turn/item notifications enabled. `optOutNotificationMethods` matches exact method names; it does not suppress server requests. Omit attestation and extended MCP form capabilities because CC does not implement them.

JSON-RPC IDs may be strings or integers. Classify messages structurally: method plus ID is a server request, method without ID is a notification, ID with result/error is a response. A server request's ID belongs to the server's request namespace and must not accidentally settle an outbound request with the same ID. Continue dispatching notifications while waiting for request responses.

The transport must split only on LF and preserve incomplete UTF-8 sequences across chunks. JavaScript `readline` is unsuitable on this project's Node 24 runtime because U+2028/U+2029 inside a valid JSON string can be treated as line separators.

CC's production client applies the [design's hard transport bounds](README.md#transport-memory-bounds): 16 MiB per incoming record, including incomplete records before decoding/parsing; 16 MiB queued archival/content payload shared with acceptance barriers; and a continuously drained 256 KiB stderr tail. These are CC resource policies, not provider-advertised maxima. A per-record cap does not bound aggregate queued memory, so the queued limit remains a hard failure threshold, not only a warning. Oversize fails with bounded evidence and preserves uncertainty for requests that may have been written. Complete valid frames are archived losslessly within these bounds; rejected/truncated records are identified as such. Stored transcript reads use a separate 64 MiB per-record cap with bounded LF/UTF-8 streaming, allowing for JSON escaping around archived wire frames. They fail on malformed/truncated history instead of accumulating an entire transcript. Do not copy the research client's unbounded capture buffers into production or infer RAM parity from matching process counts.

## Thread and turn configuration

`v2/ThreadStartParams.json` supports `model`, `modelProvider`, `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandbox`, `config`, `baseInstructions`, `developerInstructions`, `personality`, `serviceTier`, `ephemeral`, and source/metrics fields. All are optional on the wire; CC must still explicitly set its owned configuration.

`v2/ThreadResumeParams.json` requires `threadId` and accepts the same configuration overrides except creation-only fields such as `ephemeral`. Set `excludeTurns:true` to omit hydrated prior turns from the response rather than loading a large historical transcript just to ignore it. Resuming must not replay old assistant/tool output into the current CC turn; excluding response history does not mean discarding model continuity.

Both responses return the thread plus effective `model`, `modelProvider`, `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandbox`, optional reasoning effort, service tier, and `instructionSources`. The returned sandbox is a policy object. Inspect these effective values rather than treating a successfully written request as proof that the configuration took effect.

There is no process-environment map in stable thread/start, thread/resume, turn/start, or turn/steer. Spawn app-server with CC's existing environment contract. The optional experimental `environments` field selects execution environments and is not an OS environment-variable map. One process per CC turn keeps refreshed CC environment values, plugin configuration, and managed skill reconciliation aligned with the existing adapter lifecycle.

`config` is an arbitrary JSON object at thread creation/resume. Use it for existing Codex configuration overrides such as MCP/plugin selection, shell policy, native memory suppression, and write-envelope configuration. The schema alone does not establish configuration merge precedence or whether managed requirements override a key; verify the relevant behavior with the actual binary.

Stable `SandboxMode` strings are `read-only`, `workspace-write`, and `danger-full-access`. Stable `AskForApproval` strings are `untrusted`, `on-request`, and `never`, plus a granular policy object. Named permission profiles and runtime workspace-root fields are experimental; they are unnecessary for this migration.

`v2/TurnStartParams.json` requires `threadId` and `input`. The stable overrides `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandboxPolicy`, `model`, `effort`, `summary`, `personality`, and `serviceTier` apply to this and subsequent turns. `serviceTierForTurn` overrides only a newly started turn. `outputSchema` applies only to the final answer of this turn, but **CC must preserve its existing post-validation structured-output contract and omit it**; see `.kiro/steering/agent-backends.md`.

`turn/start` is not an unconditional new-turn primitive: the pinned schema describes behavior when the request steers an already active turn. CC should issue it only when its own active-turn state is empty and use `turn/steer` for delivery to an existing turn.

`UserInput` supports text, remote/local image, remote/local audio, skill, and mention forms. Existing CC text/image input mapping can be preserved without adding audio or native skill invocations to this change. A text input is `{type:"text", text:"..."}`; `text_elements` defaults to an empty array.

### CC instruction delivery

The previous SDK conversation adapter prepended `sessionInstructions` to the first user prompt of a new thread and avoided repeating them on resume. Consequently, SDK-created threads already contain that historical block. The implemented app-server adapter sends constructor-owned stable instructions through the privileged start/injection path and removes the fenced user-message duplicate: the approved native `workflow-validator-cohorts` R10 and `memory` R5 contracts require the strongest privileged instruction channel available to the transport. The working developer-role path is therefore used and `instructionDelivery` is declared `privileged`. See [the integration audit](integration-map.md#existing-governed-contracts) for the contract review. The SDK one-shot task runner separately sends `config.developer_instructions`; it remains outside this conversation migration.

`thread/inject_items` is a stable method whose documentation says injected items are appended to model-visible history and persisted. Its request is `{threadId,items:[...]}` and the response is `{}`. `v2/ThreadInjectItemsParams.json` deliberately leaves items as arbitrary JSON. The runtime's `ResponseItem` message schema, visible in the experimental resume-history definitions, supports `{type:"message",role:string,content:[{type:"input_text",text:string}]}`. The live probes established authority and persistence for this developer-role form. The adapter uses it for legacy thread upgrades or changed composed instruction bytes, and uses `thread/start.developerInstructions` for fresh threads. Preserve the neutral composition order: governing contract first, subordinate profile later. Dynamic memory indexes/deltas remain per-turn content rather than part of this privileged static block.

Injection appends rather than replaces instruction history. It has no documented replacement or deduplication key and cannot be atomically committed with CC-side state; a process failure between injection and recording a hash can repeat an update. The selected policy keeps the latest thread-scoped governing hash and unresolved marker through existing transcript storage, without an operation journal. Persist unresolved before injection, resolve only after acknowledgement, and skip unchanged instructions only from the latest resolved state. After uncertain injection the current dispatch stops; once its process is closed and there is no unresolved live cleanup failure, the next admitted attempt may reapply the **current** explicitly superseding static block once and must acknowledge it before model start. Another failure stops that attempt without a retry loop or forced checkpoint. This tolerates a rare duplicate instruction block, not a duplicate user command; native injection is not thereby idempotent. The macOS `instruction-recovery-01` probe passed lost-ack reapplication, duplicate blocks, A→B→A, and restart persistence. Durable cleanup holds remain deferred after the lifecycle observations; the selected policy retains manual recovery and restart-limited protection.

An instruction acknowledgement does not prove retention through compaction. The design invalidates cached instruction state on authoritative context loss and requires fresh acknowledgement before the next CC model turn. Its live probe compares matching pinned-runtime/model workloads on exec and fresh/injected app-server instruction paths through automatic compaction and resume. Block demonstrated migration regressions and disclose baseline weaknesses; fixing every pre-existing exec weakness is not a prerequisite. Schema support for events, exec's missing compaction reporting, or a presumed developer prefix cannot establish preservation/parity. The macOS `compaction-01` comparison observed one actual automatic compaction in each of exec, fresh app-server, and injected app-server, with governing instructions retained during the turn and after resume. This showed no regression for that pinned runtime/model/workload; other models, repeated compaction, and Linux are not established by it.

The schema's `baseInstructions` and `developerInstructions` fields on `thread/resume` do not themselves establish that revised instructions become new model-visible content. `baseInstructions` also changes the runtime's foundational instruction configuration, making it an inappropriate substitute for appending CC context. Experimental `turn/start.collaborationMode.settings.developer_instructions` carries collaboration-mode semantics and takes precedence over model and effort fields; adopting it solely for instruction refresh would expand this migration.

## Steering and completion

| Operation | Required request fields | Response | Completion meaning |
| --- | --- | --- | --- |
| `turn/start` | `threadId`, `input` | `{turn}` | Starts work; response is not final output |
| `turn/steer` | `threadId`, `input`, `expectedTurnId` | `{turnId}` | Server accepted input for that active turn |
| `turn/interrupt` | `threadId`, `turnId` | `{}` | Interrupt request accepted; wait for turn terminal notification |

Sources: `v2/TurnStartParams.json`, `TurnStartResponse.json`, `TurnSteerParams.json`, `TurnSteerResponse.json`, `TurnInterruptParams.json`, `TurnInterruptResponse.json`.

The documentation states that `turn/steer` appends input to the active in-flight turn, emits no new `turn/started`, and rejects a mismatched expected turn ID or a thread without an active turn. It accepts no model, working-directory, sandbox, or output-schema changes. A successful response does not promise immediate model compliance or cancellation of a running command.

Both start and steer have optional `clientUserMessageId`; `userMessage` items expose `clientId`. This is useful for correlating input echoes with CC queue entries. Neither schema nor the documentation promises idempotent delivery or deduplication for repeated client IDs. Never use it as justification to automatically retry an uncertain delivery.

`turn/completed` contains `{threadId, turn}`. Terminal statuses are `completed`, `interrupted`, and `failed`; `inProgress` is also in the shared TurnStatus enum. `turn.error` is populated for failure. Interrupt completion is documented to use `interrupted`. A final-answer item alone is not the terminal lifecycle signal.

`JSONRPCErrorError.json` guarantees numeric `code`, string `message`, and optional arbitrary `data`; it does not specify the numeric mismatch/no-active-turn errors. The `CodexErrorInfo` union includes `activeTurnNotSteerable: {turnKind:"review"|"compact"}` for steering attempts during review/manual compaction. Classify concrete request errors based on pinned evidence, not a generic assumption that any RPC error means input was never accepted.

If a request fails before its bytes could be sent, delivery is rejected locally. A confirmed no-active/mismatched/non-steerable response leaves the input queued for a later turn. A lost connection or timeout after writing the request makes acceptance uncertain. This distinction belongs inside the adapter and must use CC's existing delivered/rejected/uncertain delivery contract.

## Events, transcripts, and usage

The source of truth for streamed items is `item/started`, incremental item notifications, and `item/completed`. Do not depend on the final turn payload containing complete items. Scope every event to its thread and turn and keep item IDs stable across deltas and completion.

`v2/ItemCompletedNotification.json` contains user messages, agent messages, reasoning, command execution, file changes, MCP calls, dynamic tool calls, web search, plan updates, image view/generation, sleep, compaction, review markers, and collaboration/subagent activity. Preserve complete valid native messages inside CC's lossless transcript envelope within the transport bounds above. Normalize only operationally relevant events above the adapter boundary; unknown additive item types must not be mistaken for fatal errors.

An `agentMessage` has accumulated `text` and optional `phase`. `MessagePhase` is `commentary` or `final_answer`; the pinned schema explicitly says providers do not emit it consistently and `null` means unknown. `item/agentMessage/delta` contains only `{threadId, turnId, itemId, delta}` and cannot independently identify the phase. The mapper must combine lifecycle metadata with deltas and preserve the established fallback when phase is absent. A streamed delta and its completed accumulated text are two views of one item, not two messages.

`v2/ErrorNotification.json` carries `willRetry`; a retrying error is not turn failure. Use the terminal turn status to settle the operation. Surface configuration/runtime warnings and retain the structured failure information rather than treating all diagnostics on stderr as fatal.

`v2/ThreadTokenUsageUpdatedNotification.json` has `{threadId, turnId, tokenUsage:{last,total,modelContextWindow?}}`. Both usage breakdowns contain `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens` (default 0), `outputTokens`, `reasoningOutputTokens`, and `totalTokens`. They are counters, not currency costs. The generated schema does **not** define whether `last` is one model request or one user turn, or how totals behave across resume/compaction. The proof of concept established process-local `total` and model-request `last`. The adapter attributes the final process total to its single admitted turn, subtracting only an observed pre-start baseline within that same process, and adds the turn estimate to CC's known lineage cost. Never sum successive cumulative totals or blindly bill only the last request in a multi-step turn; invalid/decreasing categories and unknown history preserve unknown accounting.

## Server-initiated requests

`ServerRequest.json` lists the following methods, including some described as experimental even in the default generated bundle. `experimentalApi:false` is not evidence that CC can ignore native questions or other server requests. Leaving an incoming request unanswered can suspend the turn indefinitely.

| Method | Pinned response shape / integration policy |
| --- | --- |
| `item/commandExecution/requestApproval` | `{decision:"accept"|"acceptForSession"|"decline"|"cancel"|amendment}`. `decline` lets the agent continue; `cancel` interrupts the turn. Preserve CC permission policy; do not silently approve unexpected requests. |
| `item/fileChange/requestApproval` | `{decision:"accept"|"acceptForSession"|"decline"|"cancel"}` with the same decline/cancel distinction. |
| `item/permissions/requestApproval` | `{permissions,scope?:"turn"|"session"}`; grant only the requested subset. `{permissions:{},scope:"turn"}` grants no additional access. |
| `item/tool/requestUserInput` | `{answers:{questionId:{answers:string[]}}}`. Native question integration is separate from user steering; define and test the unsupported-request response instead of inventing user answers. |
| `mcpServer/elicitation/request` | `{action:"accept"|"decline"|"cancel",content?}`. Decline/cancel carries no accepted content. Includes form, URL, and explicitly opted-in extended-form requests. |
| `item/tool/call` | `{contentItems,success}` for registered dynamic tools. Do not register tools in this change; an unexpected call can return a clear failure result. |
| `account/chatgptAuthTokens/refresh` | Response requires access token and account ID. This is for externally managed ChatGPT auth. Use existing Codex-managed auth; do not adopt host-owned auth as part of steering. |
| `attestation/generate` | Omit the client opt-in; CC has no attestation implementation. |
| `applyPatchApproval`, `execCommandApproval` | Deprecated requests for legacy turn APIs. Do not use the legacy APIs or build a compatibility path for them. |

The documentation says `serverRequest/resolved` clears a pending request after an answer or lifecycle cleanup. Its schema is `{threadId,requestId}`; cleanup does not necessarily mean a user answered. Correlate by request ID, not item ID: the command approval schema warns that several approval callbacks can belong to one item.

The implemented runtime explicitly declines unexpected command/file approvals and MCP elicitation, grants no additional requested permissions, and returns a failed result for unregistered dynamic tools. Native questions, external auth, attestation, and unknown unsupported requests receive an RPC error and fail/interrupt the turn with a clear unsupported-operation diagnostic. Do not wait for an unimplemented UI, fabricate consent, or change CC's native-question capability merely because app-server exposes the method.

## Stability qualification

The official page presents app-server as the interface for rich clients and documents a stable API surface when `experimentalApi` is omitted or false. The same page, under **Connect a remote Code Mode host**, says: “The app-server command and WebSocket transport are experimental and aren't supported for production workloads.” The transport list also explicitly calls WebSocket experimental and unsupported.

That wording is broader than a WebSocket-only caveat. Stdio and stable methods avoid optional experimental surfaces, but do not justify claiming an unconditional production-support guarantee. The main design's [single upgrade procedure](README.md#sdk-and-runtime-upgrade-procedure) owns paired SDK/runtime pins, patch regeneration, protocol fixtures, and both transports' tests/live checks. The SDK task runner remains in scope for upgrades; migration or exec retirement is a separate evaluation. The pinned schema includes unstable fields such as `thread.path`; avoid relying on those fields for durable CC continuity.

## Questions that require behavioral evidence

The following cannot be settled by schema inspection. The technical design distinguishes measured results, required unresolved acceptance gates, and behavior outside scope. A proposed failure policy is not proof of an untested success path.

1. Does a steer accepted during an active shell/tool call reach the model in the same turn, without interrupting the tool or starting another turn? What ordering do acknowledgement, user-message item, and terminal events have?
2. Which exact error codes/data are returned for missing/mismatched/ended turns? Can completion race with the steering response? Does a repeated `clientUserMessageId` deduplicate, or merely correlate?
3. Can app-server resume an SDK/exec-created thread and preserve context? Does a new app-server process resume the same thread ID with refreshed environment/configuration/instructions?
4. Does closing stdin terminate only the server or also an active turn and child tools? Does explicit interruption yield a terminal event promptly? Cleanup must not leave untracked processes.
5. Are usage `last` and `total` per model request, per turn, or lifetime thread counters? What baseline appears on resume, and what is emitted before turn completion?
6. Which native server requests can occur under CC's existing config, including ordinary questions and MCP elicitation, when experimental API is disabled? Does CC's chosen unsupported-request response unblock the turn?
7. Are critical permission, native-memory, skill/plugin, MCP, and shell environment overrides effective through the new launch path? A schema-accepted payload alone is insufficient evidence.
8. Are final message phases present for CC's models, and is accumulated completion output consistent with streamed deltas? Preserve safe handling for absent phase even if one model supplies it.
9. Does one reapplication after a lost instruction-injection acknowledgement preserve authority/history, including duplicate identical blocks and A→B→A? This is distinct from non-idempotent user steering.
10. What happens to app-server and an ordinary tool child when the **CC-like parent** exits or is killed, and through the supported interrupt/EOF/escalation ladder? App-server SIGKILL and explicit EOF with the parent alive do not establish these paths. CC's best-effort shutdown hook does not remove the need to probe them; use the results to decide deferred cleanup durability.
11. How do fresh and injected developer instructions compare with exec's governing block under matching real automatic-compaction workloads, within the active turn and after resume? Is there a demonstrated migration regression, and does CC observe the context-loss signal needed for its own delivery state?
12. Do focused steering/resume, write-envelope, interrupt/EOF, parent-death, and escalation probes pass on macOS and Linux? What startup/steady-state memory is observed rather than inferred from process count?

The initial schema audit made no model calls. The companion POC and its 2026-09-16 extension supply the live evidence: question 9 passed on macOS; question 10 measured successful ordinary parent-death cleanup and an escalation survivor requiring manual recovery; question 11 showed no regression in the tested compaction workload. Question 12 remains incomplete on Linux. The [remaining design gates](README.md#required-live-evidence-before-enablement) also require CC queue/workflow integration evidence; native protocol probes do not certify application behavior.
