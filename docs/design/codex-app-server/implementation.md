# Implementation and verification

Date: 2026-09-16. Runtime and SDK: **0.153.3**. This implements the conversation transport migration and shared queue prerequisite. **Production in-turn delivery is enabled** in `src/lib/agent-backends/codex/rollout-policy.ts` at Alex's explicit request on 2026-09-16, without Linux verification. Ordinary conversations already use app-server; tasks retain the SDK. There is no automatic transport fallback.

## Implemented behavior

- A private app-server client owns one process per admitted turn, correlated RPC requests, server-request refusals, LF-only UTF-8 framing, and identity-checked bounded teardown. Incoming records and queued payload each have a 16 MiB limit; stderr retains 256 KiB. Received valid frames drain independently of RPC acknowledgements, including after an uncertain request or disconnect, within the shutdown deadline.
- The conversation runtime preserves opaque thread references, effective model/cwd/sandbox checks, managed skills and MCP/native-memory policy, images, final-answer phases, content replay, and cancellation. Start acceptance requires correlated evidence. Steering is serialized against the active turn and never automatically retried after uncertain delivery.
- The shared queue archives accepted input before releasing later output. Successful archive followed by queue-settlement failure permits the answer to finish while preserving review/no-redelivery state. Archive failure stops output. Claude and Cursor use the same callback contract; per-conversation dispatch reserves order before asynchronous preparation.
- Governing instructions use privileged thread start/injection. Latest hash, unresolved status, and compaction invalidation persist through existing transcript storage. History scanning is bounded; lost acknowledgements and A→B→A updates do not revive stale state.
- Accounting translates process-local usage into per-turn estimates and the CC cumulative ledger. Missing or invalid usage/history remains unknown. Context occupancy is not inferred from process-local token totals.
- Unverified cleanup produces typed failure, retains live runtime ownership, blocks reuse, and reports through existing notifications. This protection ends at restart. Durable cleanup persistence remains a separately evaluated lifecycle change.

## Real-system evidence

All new live runs used macOS x64 and `gpt-5.6-sol`. [Implementation evidence](implementation-evidence.json) records outcomes and local artifact hashes. [Extended POC results](poc-results.md) retain the original scenarios and the additional instruction, compaction, and process probes.

| Check | Observation |
| --- | --- |
| Production adapter smoke | Four real turns covered privileged instructions, image recognition, changed instructions on resume, text/image steering, unchanged-hash resume, and active-tool cancellation. All 145 native frames were persisted. Accepted user archival preceded later answer projection despite a held callback. |
| CC live in-turn queue | With a temporary worktree flag, both session and project scopes passed text/image steering, FIFO archival, SQLite settlement, same-turn delivery, replay, resume without redelivery, and the real abort route. Six real turns. The flag was restored after that probe and subsequently enabled by the rollout decision above. |
| CC session start/resume | Real HTTP/actor/transcript path returned the marker twice with the same thread reference and persisted cumulative cost. |
| CC project start/resume/replay | Two real turns retained the thread and marker; messages were read back through the replay endpoint and durable transcript. |
| Managed graph implementer path | Two real turns through the production manager and actors validated structured output, retained the thread, permitted scratch writes, and received an OS denial for candidate writes. The binding was an ephemeral managed iteration; full graph orchestration was not launched. Validators and Codex collaboration continue to use unchanged SDK tasks. |
| CC checkpoint continuity | Three consecutive cycles produced distinct fresh thread references, applied receipts with attempt-correlated acceptance, and the correct earlier marker after each reset. |
| Instruction uncertainty and compaction | Extended POC passed acknowledgement loss/reapplication, duplicates and A→B→A. Exec, fresh developer instructions, and resumed injected instructions each underwent a real automatic compaction and preserved the governing token during the turn and after resume. |
| Process lifecycle | Ordinary parent death and graceful cancellation reaped the observed ordinary tool. Frozen-server escalation left a separate-group tool alive; the harness explicitly removed it. The implementation reports this uncertainty instead of claiming verified cleanup. |

Live verification found two integration defects that were fixed: Turbopack rewrote static native package resolution into a bundle identifier, and app-server represents the workspace cwd implicitly rather than repeating it in additional writable roots. Earlier session failures occurred before input dispatch. Verification was repeated successfully after restarting the worktree server.

The original adapter smoke used a test dependency override to enable steering; its script now exercises the enabled production default. Separate live queue checks temporarily enabled the source flag in the worktree server and exercised the real queue, actor, HTTP, SQLite, and transcript paths. No browser UI claim is made. Session/project/checkpoint checks also use the actual dev CC instance. Its scratch session was deleted, project conversation archived, local configuration restored, and server stopped. Private authentication copies used by the smoke were removed.

## Checks and verification follow-ups

Registered validation covers shared queue SQLite durability, Claude/Cursor callbacks, transport framing/lifecycle, instruction state, accounting, event projection, the migrated 94-case runtime suite, backend conformance, cleanup ownership/notification, and retained SDK behavior. Validation receipts:

| Check | Result / run |
| --- | --- |
| Final focused regression | 33 files passed in three batches — `vrun-1ee4d220-5a12-4c3d-afe9-d18faf22053c`, `vrun-7680d368-8769-45f2-ac25-d4d63229e36e`, `vrun-efb9180e-06eb-44d7-a03f-1c3445ae28f1` |
| Full typecheck | Passed — `vrun-a1b5622f-7641-4fab-b485-4a2d881b127d` |
| Lint | Passed — `vrun-feb3ceab-c266-4087-97f0-73346cd587e6` |
| Architecture seams | Passed — `vrun-9604f31b-c560-4225-ac20-629f34e29742` |
| Retained SDK task runner and Unicode-separator regression | Both files passed — `vrun-4a904a08-8d08-492c-935f-e151bfadd140` |
| Focused native runtime | 25 cases passed — `vrun-afc0f623-0870-4121-8b3c-1bf85edc0d9b` |
| Graph envelope after fixture boundary cleanup | Passed — `vrun-7652b5ef-a1d4-4fbf-817d-6e7cb73230c2` |
| Shared queued accounting / durable boundary | 11 and 6 cases passed — `vrun-88cb57cb-f6d6-4d68-9598-d0c4b1568398`, `vrun-2c4505b3-ecf9-44cd-92a1-e3f173576755` |

Enablement checks passed with the production default on: backend conformance, catalog/API/enqueue consumers, composer, submission hook, document feedback, and deferred-queue coalescing (eight files; exact receipts in `rolloutDecision.validation` in the evidence JSON). Tests retain explicit next-turn capability coverage. Final full typecheck (`vrun-f0af6902-4892-4b35-ac7d-f69e823116b9`), lint (`vrun-523fb9cf-405d-4c9f-9fef-b1d8b703c0f3`), and architecture seams (`vrun-5ea15a62-3bb2-401f-974c-65f1fef6e33f`) also passed.

The repository-wide dependency-selected run was not completed: it stopped after exposing stale SDK-era fixture assumptions, which were corrected and included in the passing focused runs. No full-suite pass is claimed.

Alex authorized enablement after reviewing the reported limitations. These checks remain unverified follow-ups, not enablement blockers:

1. Linux verification was explicitly waived for this rollout. No Linux runtime or daemon was available here; focused steering/resume, write-envelope, cancellation, parent-death/escalation, and memory observations remain unverified.
2. Exercise live CC restart with unresolved delivery claims and explicit recovery in both conversation scopes. Ordinary steering, image, FIFO, replay, resume, and interruption flows passed live; ambiguous delivery and reload are covered by durable fixtures but have not been fault-injected into the running CC server.

A stalled, uncancellable persistence callback can retain a pending turn/close and its runtime owner after the native process has stopped. The child shutdown and queued payload remain bounded; releasing ownership before storage settles could let an old accepted-user write cross a later turn. This limitation is deliberately characterized rather than hidden behind a timeout that drops ownership.
