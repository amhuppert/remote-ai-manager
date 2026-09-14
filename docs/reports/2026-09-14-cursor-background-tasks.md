# Cursor provider task tracking — command-center#122

Implemented and verified on 2026-09-14 with `@cursor/sdk` 1.0.28. Cursor subagents now publish stable task identity, live progress, confirmed settlement, and durable interruption notices. Automatic continuation uses the native ongoing run: the agent waits for provider work and acts on its result within the same CC turn. Post-turn background completion remains unavailable and is disclosed in the UI and agent instructions.

## Authority and scope

Read #122 and parent #110, including Alex's governing 2026-09-12 policy: usable approximations and weaker guarantees may ship when disclosed; native equivalence is not a prerequisite. #122 has no prerequisite ticket dependencies. Native spec inventory/search contained no competing Cursor background-task spec. The legacy `background-task-handling` spec has approved requirements, design, and tasks and is ready for implementation. Its shared lifecycle contracts remain intact; no approval, spec, graph workflow, or CC job/dev-server implementation was changed.

## Verified provider surface

Checked the installed public SDK declarations (`dist/esm/public-api.d.ts` and their referenced types), bundled event projection, and authenticated native execution:

- Task tool calls expose `call_id`, `running`/`completed`/`error`, and a successful result containing `agentId` and `isBackground`. A returned background handle does not prove completion.
- `send(..., { onDelta })` exposes nested `tool-call-delta` task progress. It can report the child's current tool while the parent run remains active. It does not expose an independent post-run child completion subscription.
- Generic `SDKTaskMessage` is a summary projection, without task identity. It is not treated as a task lifecycle event.
- Native shell events do not provide a reliable detached-task handle and completion subscription in this SDK surface. Shell text is not parsed into invented task state.
- A direct authenticated probe asked for background work. The model claimed background capability, but its structured task result had `isBackground: false`. The parent continued in the same run; no later events arrived during an 18-second observation window. The unsupported API conclusion comes from the published surface, not that bounded observation or the model's claim.

## Implementation

`background-tasks.ts` projects native task calls and public nested progress into the shared background-activity view. Identity is `cursor:<CC run ID>:<call ID>`. Duplicate starts and late events cannot resurrect settled tasks. Foreground subagents are explicitly labeled `subagent`; a background handle remains unresolved. Task token/tool-use counters stay `null` because the observed surface does not supply them.

`background-task-store.ts` atomically persists the current run's task lifecycle beside the conversation's SDK store. The runtime orders transcript, lifecycle persistence, and activity publication. Terminal history remains in the native transcript; the current ledger is cleared when the next prompt is accepted. A failed ledger save emits a visible accounting warning and does not swallow prompt acceptance or subsequent native transcript events.

On Stop, shutdown, an unobservable task at run end, or recovery after a crash, unresolved tasks become `lost` with an explicit **outcome unknown** notice. Notices have stable IDs. Recovery gives the next agent prompt the loss information without automatically repeating side effects. It does not claim that an interrupted command failed or completed.

The fallback instruction asks Cursor to run provider subagents and shell commands to completion in the current turn and consume their results before ending. `externalTurns` remains false: no synthetic external turn or unsupported wakeup is invented. The existing turn owner therefore retains accounting and lock/queue ordering through the continuation.

Both worker and supervisor idle timers now apply only while no run is active. Quiet provider work remains subject to the existing 20-minute turn-stall bound. Worker self-termination attempts bounded native run cancellation before SDK disposal, then retains the process-group escalation. This matters because SDK shell children can lead separate process groups.

## Validation

Every behavioral change began with a failing focused reproduction; subsequent focused registered checks passed. Formatting, disclosure copy, and wiring used existing behavior tests rather than artificial tests of visual text layout. See [machine-readable receipts](2026-09-14-cursor-background-tasks.evidence.json) for full run IDs and live evidence.

Passed focused files:

- `background-tasks.test.ts` and `background-task-store.test.ts`: identity, progress, settlement, unknown handles, summaries ignored, real file recovery.
- `conversation-runtime.behavior.test.ts`: continuation, deduplicated transcript, task loss, restart recovery, Stop, and ledger-write failure.
- `conversation-runtime.test.ts` and `task-runner.test.ts`: existing turn and task-runner regression coverage.
- Worker `entry.test.ts`, `sdk-port.test.ts`, `supervisor.test.ts`, and `worker-process.test.ts`: delta delivery, single acceptance, quiet active runs, idle expiry after settlement, cancellation before disposal, bounded cancellation failure, and real worker-process regression coverage.

Registered full typecheck and architecture seams, changed lint and formatting all passed. Exact-file runs used `--require-match`; the current CLI reports one matching file. The CLI changed during this session to reject `--wait` for validation; final commands used its documented blocking default. No direct test runner or production build was used.

### Authenticated live flows

All live application flows used this worktree's `cctl dev ensure nextjs` URL, `http://localhost:3002`, with its own `.config/api-token`. The managing server's database was not used. The fixture repository and its nested worktree were created under `.cc/temp/cursor122/projects/`.

| Flow | Observed result |
| --- | --- |
| Native subagent plus automatic continuation | Child waited 18 seconds and computed 21 × 41; parent returned `BG122_FLOW_RESULT_861` in the same CC turn. Ledger progressed from running to completed. |
| Real progress API | Authenticated `/api/conversations/active` exposed the stable task ID, `subagent` type, current tool `shell`, timestamps, and unknown counters as null. |
| Queued user prompt during provider work | Queue POST returned HTTP 200 while the child was running. `BG122_ORDER_RESULT_899` preceded queued `QUEUE122_ACK_599`; four prompts/four turns at that checkpoint, 113 unique transcript IDs out of 113 entries. An earlier late queue attempt returned 409 and was not counted as a pass. |
| Stop during a real shell child | Authenticated abort returned HTTP 200; child PID 74980 was gone, ledger recorded lost, and the transcript contained an outcome-unknown notice. |
| Crash reproduction | Before the cancellation fix, SIGKILL of the verified owned dev-server PID killed the worker but left its shell child alive. The child later exited on its own timer. |
| Crash after the fix | Repeated SIGKILL with a live native child: server PID 3936, worker PID 6915, child PID 8202. Both worker and child were gone within 1,508 ms. The durable running ledger survived the server crash for recovery. |
| Restart after the fixed crash | Exactly one notice for the interrupted task; agent acknowledged unknown outcome with `RECOVERY122_FIXED_ACK_887`, used zero tools, and did not replay the child. Ledger cleared on accepted input; activity API returned null. All 384 transcript entries had unique IDs. |
| Durable accounting | Final settled state was awaiting, pending queue empty, seven recorded prompts/seven turns. Native final usage remained in the transcript; interrupted crash turns without terminal usage were not reconstructed. |
| Cleanup | Fixture deletion removed its worktree and conversation row; all observed worker/child PIDs were gone. Existing deletion retains SDK store files, so this throwaway fixture's remaining SDK store was explicitly removed after evidence capture. |

Desktop and 390-pixel mobile screenshots of the existing composer warning were opened and inspected. Expanded mobile disclosure wraps without clipping. Local screenshots are `.cc/temp/cursor122/disclosure-desktop.png` and `disclosure-mobile-expanded.png`. Next.js diagnostics reported no configuration or session errors. The test browser pages were closed.

## Limits and follow-up opportunities

- This ships automatic continuation **within the current turn**, not autonomous completion notifications after that turn. No supported local SDK subscription supplies the latter. An unexpected background handle is reported as unobservable and cleaned up best effort.
- Shell detachment is discouraged by instructions, not enforced isolation. Native cancellation cleaned up the tested SDK child, but a cancellation failure, a worker killed before its watchdog runs, or a deliberately escaped process cannot be guaranteed clean by the worker process group alone. Group disappearance is not proof that every possible detached descendant has exited.
- A hard server crash cannot emit a notice while the server is down. The durable task ledger produces the loss notice on the next runtime invocation; there is no automatic recovery prompt or replay.
- Child token/tool counters, post-crash missing usage, and provider cost remain unknown. Cursor runtime `costUsd` remains null. The existing shared conversation aggregate stores zero for an unavailable cost; this is an existing accounting limitation in sibling #120, not a claim that Cursor ran for free. No cost or per-child usage was fabricated here.
- The model's narrative duration estimates in recovery replies are not validation evidence. Process liveness, native structured events, authenticated responses, durable records, and deterministic IDs are the evidence.
- No changes were made to CC-owned jobs, independent dev servers, other providers, or the external-turn orchestration path.
