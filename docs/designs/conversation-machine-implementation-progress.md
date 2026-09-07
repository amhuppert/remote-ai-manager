# Conversation machine implementation progress

Implementation source: [plan](conversation-machine-implementation-plan.md) and [technical design](conversation-machine-technical-design.md).

Baseline verified: `8489cd68f0bdea9506cdbfa585a86b808b7f5511`; assigned worktree was clean. Preparation read the required steering, project configuration, and validation help. `memory-bank/focus.md` is absent. No native approval is claimed by this implementation record.

## Delivery status

| Change | Status | Commit | Evidence |
| --- | --- | --- | --- |
| 1. Durable reconstruction and write gate | Complete | `8a97e05f` | Focused regressions, affected tests, typecheck, seams, lint, format pass |
| 2. Turn definitions | Complete | `5fd938ed` | Shared contract, actor, snapshot, permission and debug carriage tests; typecheck, lint, seams, format pass |
| 3. Admitted attempt lifetime | Complete | `3ae4dc5c` | Lifecycle races and affected tests pass after two fixture migrations; typecheck, lint, seams, format pass |
| 4. Durable acknowledgement | Complete | `1c37f421` | Delayed/rejected row and snapshot commits, reconciliation, command readback and checks pass |
| 5. Composition and registry boundaries | Complete | `6a047028`, `e0469254` | Shared hosted composition, runtime ownership, ephemeral writes, capability and profile tests pass |
| 6. Context and delivery receipts | Complete | `23f1bff7` | Accepted-input marker, required/advisory receipts, queue/fork cleanup and checks pass |
| 7. Results and graph adaptation | Complete | `6b3e082e` | Fresh/hosted projections, typed graph recovery, partial accounting and checks pass |
| 8. Debug ownership | Complete | `287e3795` | Serialized verification, generation fencing, cleanup and checks pass |
| 9. Runtime configuration equality | Complete | `d00c984b` | Semantic configuration, actual instruction refresh, preview and checks pass |
| 10. Composed integration and guards | Implemented; baseline suite failures remain | `c4899438`, `f3099065` | Composed cases, guards and live smoke pass; full-suite disposition below |

## Validation evidence

Registered commands are `format`, `lint`, `typecheck`, `seams`, and `test`. Evidence below records actual run IDs, verdicts, and matched scope. Registered wrappers execute from the canonical checkout with this worktree as cwd; installed CLI/server behavior is not evidence of branch code.

| Run | Verdict | Scope / matched files | Run ID |
| --- | --- | --- | --- |
| 01-format-final | pass | changed; not reported | `vrun-df03ddf5-b229-4506-99a9-83d1b7d86516` |
| 01-format | pass | changed; not reported | `vrun-42d627c8-7053-4f14-a80e-faa7894118b3` |
| 01-gate-green | pass | changed; 1 | `vrun-cff92645-7253-4061-9ccb-474c79c3d403` |
| 01-gate-red | fail | changed; 1 | `vrun-795b42a7-7cc8-4f3c-8a2c-dd8606d8eb8d` |
| 01-lint | pass | changed; not reported | `vrun-2c8d485a-c62f-4e73-96ae-375dff0e2411` |
| 01-loader-accounting | pass | changed; 1 | `vrun-e8cb0849-b9c0-4b64-be3e-ea236cfed90e` |
| 01-loader-green | pass | changed; 1 | `vrun-50da6cd2-c3e3-4a07-9041-3a877863d418` |
| 01-loader-red | fail | changed; 1 | `vrun-1ca50d6c-e3d0-4a2a-b851-ac3dbb5c8048` |
| 01-manager | pass | changed; 1 | `vrun-a4d40b67-5880-4859-a7a0-e5ac5fb9324a` |
| 01-rehydrate-green | pass | changed; 1 | `vrun-1d6b0194-6f0c-4056-927c-f69fdf1494f7` |
| 01-rehydrate-red | fail | changed; 1 | `vrun-0d1de505-9691-4317-8725-a623b4a15b2b` |
| 01-seams | pass | full; not reported | `vrun-ebcbedd7-aded-4331-9677-1ef4b1fe1c30` |
| 01-stream-green | pass | changed; 1 | `vrun-d23f4133-4946-4240-a210-a1e24ab5cad6` |
| 01-stream-initial | fail | changed; 1 | `vrun-eea9d3d4-5374-4c8b-b9b9-30f9643191cb` |
| 01-stream-red | fail | changed; 1 | `vrun-545de90f-c85a-43b7-90e5-cc2ba69b5f12` |
| 01-stream-setup | pass | changed; 1 | `vrun-7489232b-7eae-4134-85f8-e5807a192b90` |
| 01-types-final | pass | full; not reported | `vrun-2765ba70-e147-4cc5-a5bf-b4580f34d1dc` |
| 01-types-initial | fail | full; not reported | `vrun-8669a924-19cc-4857-96d6-47606189e7d5` |
| 01-types-updated | fail | full; not reported | `vrun-4feeddf8-8311-4da4-b75c-ae8af3617e29` |

## Behavior changes and unresolved failures

Change 1 carries row-owned aggregates and activity through ordinary/project construction and overlays them over stale control snapshots. The same totals projection synchronizes the row; another turn adds only its own accounting. Ephemeral streaming compaction gates memory delivery reset, with durable control drives proving the reset executes.

The loader, stale-snapshot, and write-gate regressions failed on the expected behavior before their fixes. The streaming database regression was also confirmed by temporarily omitting the gate: both ephemeral scopes deleted `memory_index_delivery_state`. Its initial setup run was not a behavior reproduction (missing schema-required fixture fields); the corrected drive exercises the real machine, actor implementation, AgentCall, fake provider, and SQLite.

Required input fields were added explicitly to synthetic callers and local fixtures. The intentionally invalid persistence fixture retains all other required fields. Typecheck failures during this migration were resolved; the final recorded typecheck passes. No snapshot format changed or snapshot fixture rewrites occurred. Affected tests passed (`vrun-58758b0e-e555-4c7b-abf3-b6ba0f39500c`); matched scope is recorded in `.cc/temp/conversation-validation/01-affected-status.json`. Final branch smoke verification remains pending.

## Change 2 validation

| Run | Verdict | Scope / matched files | Run ID |
| --- | --- | --- | --- |
| 02-actors-final | pass | changed; 1 | `vrun-0d96ed0a-01c6-489b-9fe6-12d8e4869af7` |
| 02-actors | fail | changed; not reported | `vrun-2559a6e2-32ff-443b-96a6-79957236b0c6` |
| 02-carriage | pass | changed; 5 | `vrun-184fa2df-db7c-4835-8ba5-81143e6a7f56` |
| 02-debug-carriage | pass | changed; 2 | `vrun-7799708a-29ea-4bcd-9b4b-6987c08a4210` |
| 02-format | pass | changed; not reported | `vrun-c6486715-349d-456b-bd18-4de140c569c4` |
| 02-lint | pass | changed; not reported | `vrun-e153e926-aae2-4664-a357-704b8fc41555` |
| 02-lock-green | fail | changed; not reported | `vrun-1f6afa94-6459-4d92-8c2f-945e96de1d14` |
| 02-lock-red | fail | changed; not reported | `vrun-f6ce0032-4e21-4824-8230-79e6d061532a` |
| 02-machine-initial | fail | changed; not reported | `vrun-bb439782-c4d9-463f-8101-e4b47352e444` |
| 02-machine | pass | changed; 1 | `vrun-707cd072-ac1c-486c-a5ad-094a506a0845` |
| 02-queue | pass | changed; 1 | `vrun-e1dbfddf-8535-40e9-857d-daf8ce958b29` |
| 02-seams | pass | full; not reported | `vrun-8ff7346e-c461-4a06-b8cc-774b1eaa2c2b` |
| 02-spec | pass | changed; 1 | `vrun-cbd64618-f2a3-45e2-aabe-79b281787f84` |
| 02-typecheck | pass | full; not reported | `vrun-e3eaf008-2991-4aaf-a1f9-217537dae8c7` |
| 02-types-final | fail | full; not reported | `vrun-3e14e19b-8a6b-4411-8d57-80482ff2f550` |
| 02-types-initial | fail | full; not reported | `vrun-d26cd485-8ce9-43a4-9e7a-84ab2aeffcb6` |
| 02-types-updated | fail | full; not reported | `vrun-5df2be7e-f681-4a5c-a24e-be93580a04ec` |

The lock bypass regression failed on the missing lock acquisition before removal. Intermediate migration failures were obsolete flat-input assertions; the executor now receives the shared normalized turn. Snapshot fields remain flat. Shared schemas preserve explicit false, task execution authority and timeout zero, and reject task-only options on conversation requests.

## Change 3 validation

The admitted attempt owns preparation, cancellation, execution, backend closure, delivery cleanup, and resource release. Production callers use explicit durable or ephemeral bindings and an accepted completion handle. UI and workflow Stop share the lifecycle owner; the abort registry is an index. Profile admission is reserved before settings/emitter installation. A persisted task continuation remains explicit on the task spec because graph task continuations survive host restarts. Ephemeral hosts start without a fabricated durable seed or continuation.

| Run | Verdict | Matched files | Run ID |
| --- | --- | --- | --- |
| 03-lifecycle-checkpoint-2 | pass | 5 | `vrun-97720d05-36cf-4798-be09-848dbf19d4d0` |
| 03-actors-migration-4 | pass | 1 | `vrun-d7f7bd5f-459e-45e3-b19c-e8c6f3f58fbc` |
| 03-core-regression-3 | pass | 6 | `vrun-19a1dae9-75eb-4a54-a605-623f053396f5` |
| 03-callers-checkpoint-2 | pass | 10 | `vrun-2ae536db-cc35-4930-a61b-ebdbf8a09630` |
| 03-stop-checkpoint | pass | 3 | `vrun-ae95b8dc-83c2-4764-9720-06272e6050fc` |
| 03-queue-outer-finalizer | pass | 1 | `vrun-b44d558f-7f99-40ea-b23a-608c5b73a699` |
| 03-sdk-migration | pass | 1 | `vrun-9ca8fbe1-0a3e-4aac-8cac-e5bd3ac006e0` |
| 03-stop-admission-green | pass | 1 | `vrun-2fa03a4d-4911-427f-8ede-5e9be1407432` |
| 03-outcome-red | fail | not reported | `vrun-b9f131ba-35ca-40f4-9a92-74a7e9677ab5` |
| 03-outcome-green | pass | 1 | `vrun-077080dd-6390-49f7-849d-68d31f1abda9` |
| 03-profile-refusal-red | fail | not reported | `vrun-2655d43e-72cb-427c-b9e8-934ad0fc3daf` |
| 03-profile-refusal-green | pass | 1 | `vrun-30a72c5f-829c-4fa6-a531-cc782afc1ed6` |
| 03-types-final-2 | pass | not reported | `vrun-95a05983-900a-4a9c-af7a-abe6d100e1f3` |
| 03-format-final | pass | not reported | `vrun-d02bb46b-6ca9-4dd5-9753-6da9535be400` |
| 03-seams-final | pass | not reported | `vrun-47f8dc3c-53ed-4d62-be87-6b0481f59e44` |
| 03-lint-final | pass | not reported | `vrun-16083e32-7b7a-4186-a889-be98d3d23ca1` |

The owner-level receipt failure test proves cleanup continues after a required receipt rejects. Shutdown regression tests cover replacement runtime closure and closed admission while an idle backend close is pending. Broader integration and final branch smoke remain pending. Durable row/snapshot acknowledgement is intentionally the next delivery boundary (change 4).

The affected checkpoint (`vrun-8c5f993b-094c-4d6d-b10c-50a74ccc80a4`) passed 142 files / 6,400 tests with 2 skipped files and exposed two stale fixtures. Consumer locality now uses a real ephemeral admitted task instead of a partial actor override/fabricated durable seed; debug parity awaits retry and keeps its explicit core-machine sender. Their focused reruns passed. No snapshot fixture rewrites occurred.

- 03-debug-retry-2: pass, 1 matched files, `vrun-91898eac-2222-4f3a-baee-fedb62d62082`.
- 03-consumer-locality: pass, 1 matched files, `vrun-b76d52ec-ccf2-4ff6-8e1f-1139bc033327`.
- 03-debug-parity: pass, 1 matched files, `vrun-63e47754-9ab7-4256-8db1-6b6c7b570581`.
- 03-types-checkpoint: pass, not reported matched files, `vrun-93dcde8a-b66c-4a81-a2c2-f1d57d8c901b`.
- 03-format-commit: pass, not reported matched files, `vrun-6af9cd93-9405-4b7b-9c84-5112be2bb4c6`.

Final change 3 checks:

- 03-types-commit: pass, `vrun-6bc8312f-0988-43db-a8c1-f1abb31ee135`.
- 03-lint-commit: pass, `vrun-9aca2697-1efd-467a-9dae-5e952cbc4bde`.
- 03-seams-commit: pass, `vrun-5c4b086c-9daf-489c-82a7-339b105048f2`.
- 03-format-commit: pass, `vrun-6af9cd93-9405-4b7b-9c84-5112be2bb4c6`.

## Change 4 validation (in progress)

Completion now awaits enrolled row writes and the flushed resume-token snapshot. Failed row, snapshot, receipt, and backend-close work remains owned for explicit bounded reconciliation; admission/draining remain closed. Debug commands return applied/unchanged/refused after their write barrier; recording has one writer, and its route returns immediately readable state. Mutation publication follows commit. Settled persistence records are discarded only after draining. Debug verification feature extraction and its semantic completion delivery remain part of change 8.

| Run | Verdict | Matched files | Run ID |
| --- | --- | --- | --- |
| 04-capture-reconcile-green | pass | 1 | `vrun-d475d9ee-5c92-492c-9502-dde41e870028` |
| 04-capture-reconcile-red | fail | not reported | `vrun-917b0828-a839-40b4-912f-df28ece00962` |
| 04-checkpoint | pass | 6 | `vrun-3f0c2904-4bb5-4fb8-a1ff-3be348b1a94c` |
| 04-close-reconcile-green | pass | 1 | `vrun-cd45e086-4a44-45de-b572-aab8cf542b78` |
| 04-close-reconcile-red | fail | not reported | `vrun-205d50a9-4386-4db2-805c-1413a8726f27` |
| 04-command-green | pass | 1 | `vrun-08970106-5684-426d-8d23-bf8e4040e609` |
| 04-command-publication | pass | 1 | `vrun-f07fd65c-3f9b-4370-a35f-ec2aef70b183` |
| 04-command-red | fail | not reported | `vrun-bfac9b98-c238-4bdc-8a5d-86c27b344795` |
| 04-durability-green | pass | 1 | `vrun-1ec7ca51-aecb-4eeb-a261-39a26fb62449` |
| 04-durability-red | fail | not reported | `vrun-9b0d2ea7-3c9f-4c0e-8917-d337213715da` |
| 04-ephemeral-log-contract-2 | pass | 1 | `vrun-972c7843-40c3-45da-9f33-f0892cb4eccb` |
| 04-ephemeral-log-contract | fail | not reported | `vrun-9cedd3a9-731e-4162-862d-6c414af9960f` |
| 04-format-checkpoint | pass | not reported | `vrun-4a974fb5-6662-4e98-b436-041e50750e3d` |
| 04-format-reconcile | pass | not reported | `vrun-7edb06e7-eb94-440f-b5ad-8e2fade0cd55` |
| 04-format | pass | not reported | `vrun-47c9d219-5790-473d-b441-f96c651e9137` |
| 04-host-checkpoint | fail | not reported | `vrun-d8098f49-593f-4922-8d01-f9e3876df9f3` |
| 04-lint | pass | not reported | `vrun-8f2181e3-254b-4852-af3f-23b6fea51e00` |
| 04-receipt-reconcile-green | pass | 1 | `vrun-a6a65bd0-b79f-4cc3-a850-a66e42dc239f` |
| 04-receipt-reconcile-red | fail | not reported | `vrun-19380001-32e0-416a-b7a5-b565fbeef5c4` |
| 04-reconcile-green | pass | 1 | `vrun-cd61a707-97d0-47dd-9712-3bdef12bd959` |
| 04-reconcile-red | fail | not reported | `vrun-1f316df7-ae52-4930-b114-42b619f10198` |
| 04-recording-route | pass | 1 | `vrun-6ca9824d-491e-4c34-a94b-1a12049bb139` |
| 04-seams | pass | not reported | `vrun-bbfb82b7-cb74-4344-b0fd-29522a3179ae` |
| 04-snapshot-reconcile | pass | 1 | `vrun-c1bf6406-3330-4600-a22a-be11074f7b07` |
| 04-types-checkpoint | pass | not reported | `vrun-764f9eab-830e-40d6-9ee9-722395dc603b` |
| 04-types-command | pass | not reported | `vrun-672766d6-8c57-4d52-8010-9e4417102a87` |
| 04-types-debug | fail | not reported | `vrun-5f8c0b5b-46c8-4132-8abc-73d7b5fe76ca` |
| 04-types-initial | fail | not reported | `vrun-c3d0353e-8155-4e25-a04d-8a1bd62d1602` |
| 04-types-reconcile | pass | not reported | `vrun-99abc6a3-6129-4ca3-99e8-5701e1885f38` |

The row/snapshot/recording latency tests failed on early acknowledgement; required-receipt and failed-close regressions failed on reuse without reconciliation. Snapshot capture failure also reproduced missing retained recovery. The first ephemeral-log fixture migration run failed on a missing infrastructure spy in its hoisted setup; its corrected run passes. No snapshot fixture rewrites have occurred. The affected checkpoint and final change checks remain pending.

### Change 4 completion checkpoint

Durability now covers synchronously enrolled row writes, deferred snapshot capture/flush, accepted-turn completion, semantic debug commands and Stop. Failed required receipts and runtime closes retain a reuse gate. Bounded concurrent reconciliation joins one promise, retries retained work, and does not repeat backend execution or accounting. Recording uses one awaited writer; unchanged selections do not write/publish. Failed commands publish no successful debug mutation.

- Concurrency red: `vrun-9b7bef99-9531-48b9-aee7-569f07dc6a2e`; green: `vrun-dc155549-062f-42da-9386-74be00872ba1` (1 matched file).
- Snapshot reconciliation: `vrun-c1bf6406-3330-4600-a22a-be11074f7b07`; capture retry: `vrun-d475d9ee-5c92-492c-9502-dde41e870028`; failed receipt retry: `vrun-a6a65bd0-b79f-4cc3-a850-a66e42dc239f`; failed close retry: `vrun-cd45e086-4a44-45de-b572-aab8cf542b78` (each 1 matched file).
- Affected checkpoint `vrun-94efdcdd-875c-4933-b982-120058ff2560`: 541 files / 13,406 tests passed; stopped on 2 fixture failures (old task argument shape and missing isolated admission read seam in project answer recovery). Both corrected; explicit 2-file checkpoint `vrun-3e68e525-751a-43be-8d27-c84020cfa0c1` passed. This is not a claim that all 815 selected files completed.
- Final typecheck `vrun-f535a87d-a11e-4faf-97a8-4ea07307d9fe`, format `vrun-e89d3e12-e5b3-44c0-844d-0a7198f89610`, lint `vrun-c4f35be8-32a3-4fd2-bbe1-8b7657cc7b7d`, seams `vrun-bbfb82b7-cb74-4344-b0fd-29522a3179ae`: passed.
- No serialized snapshot format/fixture changes. Full composed/live checks remain Change 10. Debug verification completion migration remains Change 8; composition ownership of adapter instances remains Change 5.

Change 4 commit: `1c37f421` (`fix(conversation): acknowledge committed lifecycle state`).

### Change 5 work in progress (uncommitted)

- `runtime-binding.ts` owns the backend handle, incarnation, tracked background effects, external handler and close promise. Concurrent close joins, index removal waits for drain, failed close is retained until explicit reconciliation. Runtime state contains required `managed`; execution and Stop use it. External session deletion and process shutdown are still pending migration; the registry still has its obsolete close-all API at this checkpoint.
- MCP tooling and alignment use narrow semantic read operations. Alignment projection preserves autonomy and origin message ID. Debug recording route now ensures a semantic binding.
- `actor-dependencies.ts` defines required execution/transcript/effects/context/policy/debug groups; `effects.ts` owns database-effect contracts and ephemeral noops. The broad actor intersection, actor globals/setters, and persistence adapter's write gate are removed. Real ephemeral policy metadata adapters are NOT implemented yet; this is the next production policy work. Existing policy no-op expectations have been retired.
- `createConversationManager(deps)` now holds admission/commands. `actor-host.ts` holds `.provide()`, registry access, creation/deferred start and eviction. `production.ts` builds required collaborators and imports manager contracts only as types. `actors.ts` builds injected invoke actors and completion barrier with the host's actual adapter. Core stubs reject unconfigured execution. Rehydration uses the supplied host, queue and storage; the default startup call delegates through the manager instance. Internal target identity/codec migration is pending.
- Tests are being migrated to file-local constructed cores via `testing/manager-fixture.ts` and `createTestActorImplementations`. `testing/lifecycle-fixture.ts` already constructs the same application/host core over isolated storage and the provider boundary. No production setup aliases were retained. Some fixture changes remain incomplete; this tree has NOT passed typecheck/host checkpoint yet.

Evidence:
- Runtime owner red `vrun-ab0d7e7c-b5c9-4ae5-9336-92de92a1196f`; green `vrun-61042eab-7626-446b-abc9-97adc04677c3` (1 file).
- Ownership checkpoint before composition extraction `vrun-843ba26d-8349-4689-a43f-0017d614a9c0` (6 files: runtime binding/state, cancellation, actor implementations, alignment route, charter contract) passed.
- Explicit composed application/host checkpoint `vrun-1bf9e3ae-2206-41a6-b67d-2bf0aab5886b` (4 files: turn admission, durability, recording route, profile admission ordering) passed.
- Required actor-factory/policy test `vrun-e05f2585-e200-463f-966a-6b55d1bd8d14` passed (1 file, 201 tests).
- Host migration checkpoint `vrun-e7241ca1-c9c4-455b-9644-f3b2945d1d5d` stopped on task fixture using unconfigured core actors (3 files/23 tests passed before stop). Fixture now starts from its production-provided machine; focused `05-task-facade-fixture.json` is running at this note.
- Typecheck `vrun-21908704-6375-40eb-b0ee-756063ab812e` failed on unused task imports and overly generic rehydration mutation port. Those have been narrowed/cleaned after the verdict; rerun required.

Remaining Change 5: finish fixture migration and checks; build real MCP/capability policy over in-memory ephemeral application metadata (explicit worktree, real enforcement), put all durable policy writes through effect facet; migrate session deletion/process shutdown and remaining external backend-index consumers; internal ConversationTarget/flat-codec mapping; clean obsolete comments/imports/setups and run required checks before commit. Changes 6–10 remain required, including final live smoke.

### Change 5 continuation — policy storage and lifecycle ownership

Still uncommitted. Added `policy-state.ts` and `runtime-policy.ts`: MCP service reads/updates an explicit application-state port; durable stores retain real missing-row checks, ephemeral services keep state on ManagedConversationRuntime. Production composes actual MCP/capability services with explicit worktree and backend, direct effect writes go through the effect facet. Shared MCP apply serializer covers separate service instances for the same indexed conversation.

Session deletion now awaits manager stop/eviction and preserves worktree on failed close. Shutdown hook takes required lifecycle drain; instrumentation supplies manager stop-all. Removed competing registry close-all. Added hosted-backend fixture for real lifecycle closure tests. Moved cancel/debug verification runtime actions into host; machine defaults are pure stubs. New machine fixture wires real settlement core with explicit infrastructure. Removed actor fixture masking casts; missing fields fixed with real required collaborators. Memory preview now uses a detached configuration projection through manager rather than backend handle.

Validation evidence:
- `05-delete-red` vrun-c6b5bd3d-83ec-4ef5-9192-9b500856e8d5: expected red, deletion resolved despite failed close.
- `05-delete-green` vrun-ab5a1b48-161c-4f44-8d02-66f1a3ffa589: all 112 session service tests pass.
- `05-policy-host-types` vrun-7f8ad394-53cc-478b-8608-fc6f7dce7834: typecheck passed before subsequent fixture/action extraction.
- `05-host-checkpoint2` vrun-fccea8bc-f53f-4b4e-b3d2-7a63306800e3: 5 of 6 files pass; manager queue fixture retained no-op machine override. Fixed override, `05-manager-fixture-green` vrun-3e176390-3632-4ba7-80e4-e95798dfc735 passes. Other files: shutdown, task facade, MCP service, rehydration, queue finalization.
- `05-live-policy3` vrun-f6782d52-018c-406b-98d3-143601180db4: both session/project composed ephemeral streaming tests pass: real discovery/composer/real Codex capability adapter, MCP refusal prevents second dispatch, policy hashes held in managed memory, all database tables unchanged. Follow-up second-outcome assertion also passed in policy checkpoint.
- `05-policy-checkpoint` vrun-cb88d7cc-6af8-475d-ab96-66feb6714538: 6/8 files pass. Two fixture migrations fixed: project composition carries backend/worktree; debug parity raw machine needed composed settlement.
- `05-machine-wiring` vrun-c2660300-eab3-4d67-9dea-3c076afe777f: 7 files pass (machine, debug parity, debug adapter, continuation clear, persistence, graph write-envelope carriage, actor implementations).
- `05-before-target-types` vrun-56a626dc-dec5-49e7-b693-d58f7a5c2f25 failed only six unused raw-machine imports and one memory test port rename; edits now address them, not yet rechecked.

Remaining Change 5: replace internal identity fields with ConversationTarget and explicit unchanged snapshot projection/inverse; finish all feature fixture checkpoints and registered format/lint/typecheck/seams before commit. Changes 6–10 remain required and untouched.

### Change 5 completion checkpoint

Composition is implemented: injected actor host/manager/required dependency groups; real ephemeral MCP and capability enforcement with managed in-memory metadata; one backend owner and awaited session/process teardown; semantic tooling/alignment/memory reads. Internal inputs/context use ConversationTarget, and the snapshot codec projects/restores the unchanged flat serialized identity. Production capability seed composition now has a pure module and retains lazy storage loading. No snapshot fixtures changed.

Focused coverage includes actual composed session/project ephemeral streaming with real discovery/composer and provider adapter, unchanged isolated database dump, MCP rejection before dispatch, shutdown/deletion failure retention, profile replay, queue recovery, persistence codec, machine/debug integration and required dependency construction.

- 05-target-codec: passed `vrun-119d8cad-adde-4196-a26b-2be822f764ed`; requested scope changed, effective scope changed.
- 05-target-types3: passed `vrun-ba123055-9217-4119-9ebc-b378b7dc0860`; requested scope changed, effective scope full.
- 05-target-checkpoint: passed `vrun-a4916d1f-8579-4037-ae00-d2b504d8ac36`; requested scope changed, effective scope changed.
- 05-live-policy3: passed `vrun-f6782d52-018c-406b-98d3-143601180db4`; requested scope changed, effective scope changed.
- 05-delete-green: passed `vrun-ab5a1b48-161c-4f44-8d02-66f1a3ffa589`; requested scope changed, effective scope changed.
- 05-machine-wiring: passed `vrun-c2660300-eab3-4d67-9dea-3c076afe777f`; requested scope changed, effective scope changed.
- 05-final-types: passed `vrun-1c2b765f-5568-4da7-8291-e5ce8d302801`; requested scope changed, effective scope full.
- 05-final-format: passed `vrun-03ce0293-7051-4e7b-b2f4-10794c8d5a5b`; requested scope changed, effective scope changed.
- 05-final-lint: passed `vrun-ce6759ad-9140-4852-8879-f717ecc690a1`; requested scope changed, effective scope changed.
- 05-final-seams: passed `vrun-eccff3fc-647f-4b5f-a739-2cf148e3fe33`; requested scope changed, effective scope full.

The broad affected checkpoint vrun-66026c7c-7b4c-47eb-9e71-09937df7b182 remains running; its result is not yet claimed. Final composed/live verification remains Change 10. Debug semantic completion remains Change 8, semantic runtime configuration remains Change 9, and public event/import guards remain Change 10.

Change 5 commit: `6a047028` (`refactor(conversation): compose one hosted runtime owner`). Broad affected run `vrun-66026c7c-7b4c-47eb-9e71-09937df7b182` finished: 966 files / 17,506 tests passed, 1 architecture test failed and 2 uncaught errors in the graph write-envelope fixture. The actor host now spreads its explicit target directly into publication, retired manager/actor sentinel classifications were removed, and the graph fixture uses the target contract. Explicit two-file check `vrun-2aaa970e-c00e-4007-8a50-88e504240dde` passed. Followup commit `e0469254` contains these corrections; formatter-only normalization follows in Change 6.

### Change 6 completion checkpoint

Implemented named prompt assembly and feature-owned notepad/memory/workflow receipts, required receipt failure retention, whole-preparation cleanup, smaller session-ticket-only task composition, and creation-time runtime instructions. Notepad references capture and render a revision plus open-comment marker, are recorded only on backend acceptance, and serve as a local notice baseline until then. Reference receipts precede notice advances. The in-turn queue adapter follows its own provider-consumption promise as the acceptance boundary. Overlapping queue acceptance callbacks join one transcript/queue commit; failed fork acknowledgement propagates. Required workflow/fork receipt failures survive execution, block reuse and reconcile without backend replay. Pending runtime notices still drain by subtracting only prepared occurrences; stored profiles replay unchanged.

Behavior regressions obtained before fixes: premature reference delivery, late comment loss, redundant notice from a rendered reference, overlapping queue append/ack, swallowed fork receipt failure, and failed live queue delivery incorrectly recording references. New composed-host tests prove isolated notepad watermarks and late-comment visibility, required workflow receipt reconciliation, claimed context cleanup on preparation failure, and notice arrival during runtime creation followed by runtime reuse. Existing memory telemetry/revision-race, profile, image, queue and ephemeral-database tests remain covered.

- 06-notepad-red: validation_failed `vrun-c30c6be6-808b-4ca8-bf0c-aa99eff585af`; matched files not reported.
- 06-queue-red: validation_failed `vrun-3201c905-86f7-4810-a311-a6d00430d985`; matched files not reported.
- 06-fork-red: validation_failed `vrun-7c8629e7-aa17-4349-8f93-054caac71d62`; matched files not reported.
- 06-acceptance-red: validation_failed `vrun-338be3d1-fa6f-4f6c-b5f7-a9fe81ff5f74`; matched files not reported.
- 06-live-queue-red: validation_failed `vrun-8efd6e03-e00f-48f7-901c-559d8d1a9021`; matched files not reported.
- 06-notepad-green2: passed `vrun-ae9f17a7-2911-4357-b4fe-73857382c858`; matched files 1.
- 06-queue-green: passed `vrun-2835b497-38ad-4a33-ad35-6ddfae3bba42`; matched files 1.
- 06-fork-green: passed `vrun-2c796596-a69b-4d4c-969d-a4d370177dca`; matched files 1.
- 06-live-queue-green: passed `vrun-9f208997-2f94-4432-b2b5-4a15bbbc08a2`; matched files 1.
- 06-context-delivery: passed `vrun-77dd3ab8-fb2f-4aef-9516-3b0e8f4c385c`; matched files 1.
- 06-checkpoint: validation_failed `vrun-ce7accd5-9233-4b21-ad86-df3a0d3a26ad`; matched files not reported.
- 06-actor-final2: passed `vrun-1d24705b-a9b7-4153-99c2-61589abbd8db`; matched files 1.
- 06-final2-typecheck: passed `vrun-f4ed72c2-7954-416e-8aa5-8ff650ad02ca`; matched files not reported.
- 06-final2-format: passed `vrun-10cc762a-e3ce-4034-b08d-99ca2d5ecbf3`; matched files not reported.
- 06-final2-lint: passed `vrun-9742e43b-e309-4ec3-81cb-7bec4d2edc15`; matched files not reported.
- 06-final-seams: passed `vrun-95d74055-4130-408f-8b6a-c04e88023f21`; matched files not reported.

The 14-file checkpoint passed 13 files and stopped on an old direct-actor test expecting required receipt failure to resolve. The corrected actor file passes all 193 tests (`06-actor-final2`); the other 13 files had passed. Two preceding fixture corrections and their failed runs are retained in the JSON evidence directory. Final format, typecheck, lint and seams pass. No snapshot version, schema or serialized fixture changes. Changes 7–10, including final full/live branch checks, remain required.

Change 6 commit: `23f1bff7` (`fix(conversation): acknowledge prepared context on input acceptance`).

### Change 7 work in progress (uncommitted)

New failing reproductions prove loss of schema issues/repair in central projection, unexpected paused outcome presented as success, fresh task bypassing schema validation/extraction, and cancelled fresh tasks losing partial output/classification. Red run IDs: 07-results-red `vrun-82fde302-415b-4ae4-a728-45a5d89d115c`; 07-results-paused-red `vrun-0355b0e5-92bf-4f82-aec8-e0767f01ac83`; 07-fresh-red `vrun-43a074a8-49c4-44ea-bce0-589a3460d359`; 07-fresh-partial-red `vrun-c43308b8-cfeb-4520-9b7c-e7b98c2e81e2`.

Fresh tasks now dispatch through AgentCall with existing permissions/cwd/identity and no resume. AgentCall task normalization retains partial failure text and classifies externally cancelled timedOut teardown as aborted. Focused greens before subsequent centralization: results `vrun-81f569ef-778b-44ba-88ac-16628b09c978`; fresh `vrun-6aa4ca4e-3f66-4a31-a354-99fc650266b6`.

Central turn-result now owns a common presentation fact projection, schema readers, task/stream/machine mappers, and transient interruption metadata. Streaming/task actor result branches and SDK/task facade use these mappers. TaskRunResult/TaskRunUsage definitions have just moved to turn-result with direct type import migration; usage derives from AgentCall metrics. Typecheck passed before that final type move: `vrun-29d8cbcf-090f-4f5c-8ded-ddfff4ecf2ed`. The old mapToTaskRunResult implementation still exists solely for tests and MUST be removed with all test consumers in this change. Graph implementer and validator adaptation remain untouched. No final 7 checkpoint yet.

Next: migrate direct graph test helpers to composed hosted task facade (they currently call actors then old mapper), retire old mapper/classifier, implement graph-local typed result adapter and direct implementer lifecycle call, preserve typed admission/timeout/schema metadata in validator adaptation without prose parsing, finish result/graph tests and required checks. Changes 8–10 remain entirely required, including full/live branch verification.

### Change 7 completion checkpoint

Turn outcomes retain the original AgentCall result. Shared result ownership covers machine, task and stream presentations, partial content/spend, typed failure/interruption, continuation, background waits and schema parse/repair evidence. Fresh tasks use AgentCall with explicit configured backend/worktree/permissions and no resume. Task/stream cancellation presentation differences remain intentional; owned task deadlines retain typed timeout classification. The old task mapper/classifier chain and prompt-facade graph dispatch are removed; all public result imports now point directly to the result owner.

The graph implementer submits an explicit durable binding and workflow context through executeConversationTurn. Graph-local adaptation preserves query admission pressure separately from failed execution; validator evidence and cost survive even without token counts. Transport recovery now consumes typed session-death classification, preserving its existing separate one-retry budget. Real hosted fixtures replace direct actor-to-mapper shortcuts. Ephemeral validator fixtures seed no fictitious conversation row, and the scripted Claude transport declares its trusted server URL so actual write-envelope enforcement runs.

Further red reproductions covered changed-wording query admission, independent transport/SDK budgets, unexpected paused graph result, refused text with a presentation field, and lost committed partial spend without content blocks. The last case uses the real host and isolated database. Required single-file and checkpoint evidence follows; complete JSON and stderr are retained under .cc/temp/conversation-validation.

- 07-validator-pressure-red: failed `vrun-780f724d-f165-4f2f-b5b3-a254e015a68a`; matched files not reported.
- 07-graph-recovery-red: failed `vrun-292941a6-e5d4-44a8-a58b-c48173ac5332`; matched files not reported.
- 07-graph-adapter-red: failed `vrun-163bc131-51ca-4ca7-a324-a6fdf8f90dd9`; matched files not reported.
- 07-field-refusal-red: failed `vrun-a5c87201-6dde-412f-a0c5-731e73a91e2c`; matched files not reported.
- 07-partial-accounting-red: failed `vrun-4761ef60-9ecb-4765-aa94-d9210c3f9257`; matched files not reported.
- 07-partial-accounting-green: passed `vrun-1c8aa8f7-428d-49ab-a6df-8297cff028bd`; matched files 1.
- 07-authority-green: passed `vrun-915c57af-3815-4a9a-8024-e88ce291bf6b`; matched files 1.
- 07-checkpoint-final: failed `vrun-6c6477bf-b26e-487a-9840-a69aa3d64cbd`; matched files not reported.
- 07-checkpoint-corrections: passed `vrun-c482b8c6-dfa6-4dc4-91ee-c8e1a3d905c1`; matched files 9.
- 07-adapter-commit: passed `vrun-41d5289a-8774-4b4e-afa2-b5af261f93da`; matched files 8.
- 07-format-commit: passed `vrun-3e57572c-68db-4da4-8bac-49c48a86efd7`; matched files not reported.
- 07-typecheck-commit: passed `vrun-c63fd8d4-73ea-4f32-b158-acb838d15146`; matched files not reported.
- 07-lint-commit: passed `vrun-491d390f-2e22-47e6-ac24-c82d186a8fe9`; matched files not reported.
- 07-seams-commit: passed `vrun-ee2bc158-d4d5-4025-82ac-3d37a53d515d`; matched files not reported.

The 21-file checkpoint passed 14 files and failed two fixture/presentation assertions (1,176 passed tests); two files were skipped and three did not finish before bail. The nine-file correction checkpoint passes the corrected task timeout/role fixture and the affected machine, graph recovery, parallel execution, runtime-edit, merge and projection tests. The final eight-file adapter checkpoint passes validator, cohort, iteration, capture, stream/project facade and committed partial-accounting coverage. No unresolved failures remain in Change 7. Full affected/full-suite and branch live checks remain Change 10; environment-gated provider tests were not claimed as live evidence.

Changes 8–10 remain required: debug ownership, semantic runtime configuration, final import/composition guards and full/live verification.

Change 7 commit: `6b3e082e` (`refactor(conversation): share execution outcomes with graph adapters`).

## Change 8 — debug ownership and durable verification

Moved schemas, model schema selection, prompt policy, and manifest verification into debug ownership. Verification completion uses the serialized durable command API; verifier disposal excludes downstream command delivery to avoid an exit-command deadlock. Stop/rebind drains and fences old-generation verification. Shared turn accounting and resource release run once before debug phase decisions.

Behavior reds: `vrun-2b16a55d-52d7-47b0-8f57-5b09f26e1330` exposed completion bypassing an earlier durable command; `vrun-18f2e2be-ac8e-4281-a1e5-fd00ea9c8622` exposed premature rebind refusal during pending verification. All four real-host verification scenarios passed in `vrun-c9dc0846-72ae-4775-a884-8c094dac1ec4`; actual manifest retention/deletion passed in `vrun-abe97d23-947a-471f-ac9b-50471c4b5018`.

Checkpoint `vrun-ed978c3f-86e4-4172-aaac-9dd5e326edf0`: 15/16 files passed; the manager fixture incorrectly labeled a parked debug phase as executing. It now holds a real admitted turn during preparation; entire manager file passed `vrun-1ea21939-4fc5-4a90-abfa-acb008c5f0da`. Final format `vrun-315602b0-7a56-4a1a-a97c-5ac0c0e74688`, lint `vrun-ce139edf-7d4b-4f16-b080-e4ebfc4fe2e1`, typecheck `vrun-d10cbf3c-4e9e-4284-ab69-ead558b8b4f1`, and seams `vrun-bce7dd0c-28ab-436a-a92c-8392c968c4a3` passed. Scoped test commands required matching files. No unresolved Change 8 failures.

Change 8 commit: `287e3795`.

## Change 9 — semantic creation configuration and instruction refresh

Managed runtime configuration now owns backend/model/schema/write policy, alignment version, and the actual ordered repeatable instruction text. Stable JSON comparison ignores object key allocation/order while retaining array order. CC alignment metadata is removed from provider interfaces, implementations and fixtures. Debug no longer caches wrappers to satisfy reference equality.

Execution selects instructions before reuse; focus registration precedes its reference snapshot. Pending notices are excluded from creation identity and consumed only after successful creation. Memory preview uses the same read-only instruction renderer and managed configuration projection, retaining the currently known dispatch selection rather than inventing future model/schema/envelope overrides. A stopped turn retains the applied charter version through accounting even after its backend metadata is retired.

Behavior reds: semantic schema `vrun-b9c418c3-14a0-4295-be22-8a4f819515a2`; actual two-turn TDD refresh `vrun-dd0191ff-d132-4456-8c68-994ac8cae982`; Stop losing committed seen-charter version `vrun-e76cafe3-d6ff-499a-8760-a2ba18a4b4ab`. Corresponding greens: pure semantics `vrun-e58d672c-acd4-4d64-920c-f61470df24c2`, complete actor file `vrun-c6ce69cb-6923-4b58-ab13-2761848c7e21`, six composed runtime/preview/Stop cases `vrun-3bad8abe-15e3-4120-80b6-aa83e7185c08`.

Checkpoint `vrun-808bb3d8-7804-4097-b352-158bb93c7f5b`: six files passed (notices, stored profile, managed lifetime, graph envelope, debug schema, memory route); preview fixture incorrectly inherited schema-default TDD and was corrected, then its entire file passed `vrun-9728efa5-c4c2-44fe-ab0d-472a6e442f63`. Twelve-file provider/policy/Stop checkpoint passed `vrun-07a64867-bef7-49d8-bda4-8c4eb9426400`. All scoped tests required matches. Final format `vrun-ee0d98be-8914-4ca9-87ff-7f7c0f0bc9ee`, typecheck `vrun-101bc320-6421-47be-a40a-6abc014fb83d`, lint `vrun-701444f2-e296-416a-ac7e-f224bf9ea325`, seams `vrun-404d3998-b1ae-46c3-afed-2cfec895a47a` passed. Intermediate fixture/type errors are retained under 09-*.json; none remain unresolved.

Change 9 commit: `d00c984b`.
## Change 10 — composed boundaries and terminal acknowledgement

Production callers now use durable, batch-matched question commands; the raw event sender and dead PROMPT_COMPLETED/PROMPT_FAILED events are removed. Queue draining enters semantic admission and fences the host runtime identity. Provider/backend registry readers retain their legitimate capability and live-input roles. Removed unused runtime lookup helpers, registry-owned signal-only abort API, and text-based semaphore classification. The project status observer uses its own semantic projection. Exact AST import checks cover static imports, re-exports, dynamic imports, require and import types. The sentinel importer inventory was reduced to actual importers; the existing architecture-seam ceilings remain valid. Steering describes the implemented ownership and durable barriers.

Composed coverage adds real hosted lifecycle plus SQLite for graph pause/cancel/resume with occupied capacity and stale generation fencing; graph ask/answer/resume; typed admission/schema/backend failures and independent transport/SDK recovery budgets with partial spending. Ordinary running and parked questions resume through atomic answer enqueue, with one transcript identity and no in-turn answer injection. The queue matrix retains uncertain claims through preparation, runtime readiness, transcript append and required receipt failure. Reconciliation never redispatches the accepted turn. Existing debug-generation and delayed/rejected durability cases are included explicitly.

Question stale-answer red: `vrun-80c12ac4-17df-455d-a133-19f5b08908c5`; green: `vrun-e3e93ed7-64d7-41fc-88e2-8fc92b87ddab`. Boundary detector red: `vrun-8801a9e8-5033-4bff-9060-3c9c430ba599`; green: `vrun-1eb2f4ce-8167-4a95-878b-ac1657f9b06d`. Fifteen caller/fixture files passed `vrun-554bad77-a6ab-451d-85fd-98be07aa62f2`. Final graph cases: `vrun-0ff76fd5-a071-45cc-8a58-ecd17079bebd`; queue matrix: `vrun-3a54f29d-d5ce-4751-968d-099aadb559f7`; ordinary question composition: `vrun-7a11722b-5e23-4ab5-acf7-72d53f2111f1`. Sixteen explicitly addressed composition/codec/AgentCall files passed `vrun-ee7d4042-8b2a-4130-a659-6b28c5810d30`.

Affected checkpoint `vrun-f28a7de3-b94a-45ff-b285-4eac62ab5816` had 15,397 passing tests and two fixture failures: a default Claude capability lookup in the synthetic result helper despite an explicitly selected test backend, and a retired sentinel importer still listed in the exact inventory. Both were corrected; complete files passed `vrun-fc96e582-eef0-44ac-8309-3f41e9d999ff` and `vrun-ac81a888-82ad-4b3c-89e2-bf4ca03fd4a0`.

Live verification exposed premature/duplicate SSE completion and a duplicate provider error at the executor/facade boundary. The composed stream test blocks the real store commit and proves no completion frame escapes. Red `vrun-cb48b3e7-4019-4181-a074-3676b7df885d`; green `vrun-c721eee4-0593-42d4-b72d-8dd169f62f3e`. The HTTP facade owns completion after the admitted handle settles and avoids replaying an already streamed identical error. The actor no longer emits an early done. Full SDK facade file passed `vrun-faa547b4-8588-4e9c-a14c-b6556d73b30f`; full actor file passed `vrun-f7cd9a31-efa0-4212-be48-52321ca053dd`.

Final source checks: format `vrun-764ada4a-7769-4053-9ff0-9615494708ae`, lint `vrun-099624cd-5ea1-4c5f-ad6c-62f6891a31c0`, typecheck `vrun-843f2bae-87b3-4c20-ac76-596353f37bbe`, seams `vrun-fe32b7f2-e4fa-4ece-a9a9-276daf7d8906` passed. The first full-suite attempt (`vrun-91556f46-2c47-4c32-8014-7e4920781914`) was superseded after the live stream fix changed production source; it is not cited as final-head evidence. A final full run and restarted-server smoke remain pending at this checkpoint.

Live preliminary evidence is isolated in this worktree .config and .cc/temp/conversation-validation/10-live-*; scratch project probe-repo, session fx-cairn. Claude Stop/resubmit, debug recording round-trip, one queued answer, graph pause/resume, and a supported Codex turn were observed. The default Codex gpt-5.4 selection is refused by this account; the advertised gpt-5.6-luna selection executes. The typecheck registration regenerates build-info and can desynchronize a running dev server from its published cctl; final verification restarts after source checks. No production database was used.

Change 10 commit: `c4899438`. The final full-suite run and restarted-server verification below target this commit.


## Final branch live verification

All source checks completed before restarting the isolated server. `10-live-final-doctor.json` identifies the assigned worktree, its own `.config/command-center.db`, and build `c4899438-2026-09-07T00:12:15.653Z`. The managing CLI's older build comparison is expected; branch workflow operations used the branch-published CLI. The branch server ran at the session-assigned URL `http://localhost:3001`. No production database was used.

- Claude conversation `a7d441ff-27bf-4bbc-9ef1-9798322b8897` and Codex conversation `c6fc11f8-74a1-416d-aff7-c93818bedd89` each reached actual provider dispatch and running state, accepted Stop, settled, and completed a subsequent turn. Both stopped and resumed requests emitted exactly one completion frame. The subsequent markers are `CMLIVE-FINAL-CLAUDE-683 437` and `CMLIVE-FINAL-CODEX-683 437`; fresh repository reads show awaiting state and persisted accounting. Evidence: `10-live-final-{claude,codex}-stop-resume.json` and corresponding SSE files.
- Codex uses the supported `gpt-5.6-luna` selection. This account refuses the configured `gpt-5.4` selection. The negative request emits exactly one error followed by exactly one completion frame (`10-live-final-provider-refusal.sse`), verifying the live-discovered terminal emission fix. Cursor was not exercised with a real provider account.
- Final-build debug enter, recording on, recording off, and exit all returned HTTP 200. An immediate repository read after recording-on shows active and recording; subsequent reads show recording-off and cleared debug state (`10-live-final-debug.json`).
- Ordinary live `cctl ask` produced batch `q_b4d74754-0dff-4b7c-ab91-9cbff4151a7e`; the existing answer API accepted Cedar-829 and drained the answer as the next turn. A final-build read after server restart retains exactly one user transcript row with ID `73d28456-fcea-489b-8f17-10f1edeaeaa3`, the assistant marker, no pending batch, and an empty queue (`10-live-final-queued-answer-readback.json`). The browser rendered the question and option selection; delivery was driven through the real answer API after the browser submit locator failed, so no claim is made about a fully click-driven answer submission.
- Real one-context graph execution `cd245e8e-b3a1-4947-92e1-3bf83d8abd2b` was paused and resumed, including a persisted pause across the final server restart. It is archived with status completed and mergeStatus merged-success (`10-live-final-graph-archived.json`). The joined scratch-session `probe.txt` contains exactly `CMLIVE-GRAPH-947\n`. The active execution is null. The graph was launched through the actual fixture agent's verified capability.
- The final browser displays the Claude result marker. Next.js `get_errors` returned empty configuration and session error arrays after the final flows. Scoped structured logs contain admitted attempts, cancellation, owned runtime closure, turn settlement, Stop settlement and committed commands (`10-live-final-lifecycle-logs.json`).

The scratch session had seven idle conversations and no active graph execution before teardown. Fixture deletion returned `ok: true, worktreeRemoved: true`; filesystem inspection confirmed the scratch session worktree was gone (`10-live-final-cleanup.json`). The named browser session was closed. The worktree-local evidence files remain available. Source working tree was clean after the final live checks.

The final full test suite is `vrun-96afb748-22db-4482-adb7-d32b5bcb4662`, started at the final implementation head; its verdict remains pending at this entry. Intermediate failures above are chronological evidence, not unresolved final failures; the final verdict below supersedes them.

## Final validation disposition

Implementation is complete through Change 10. Final commit: `f3099065`. It changes only the source-location guard in `src/lib/project-conversations/system-prompt.test.ts`; production source is identical to `c4899438`, the full-suite and live-verification source head. The guard follows `runtime-instructions.ts`, where the unchanged project-only spawn gate is now owned. No test-first exception was needed: the full run exposed the failing assertion before this mechanical test migration.

Full run `vrun-96afb748-22db-4482-adb7-d32b5bcb4662` finished in 1,006.30 seconds: **1,918 files passed, 6 failed, 3 skipped; 28,622 tests passed, 6 failed, 8 skipped** (1,927 files and 28,636 tests executed/collected in the runner summary). This is a failed full-suite verdict, not a passing one. The project-instruction guard was the one failure introduced by this extraction; its complete single file then passed with one required match in `vrun-255ceeef-3519-4e88-9dd0-37732e254337`. Final format and lint also passed: `vrun-be9a6efa-841c-4829-b544-1b3ab2de52d0` and `vrun-24553ada-11ee-42da-bc6c-3bf7bef08a1f`.

Five unrelated baseline failures remain:

| Test file | Failing existing contract |
| --- | --- |
| `scripts/validate-cursor-acceptance.test.ts` | Expects a cursor-acceptance command absent from CommandCenter.json. |
| `scripts/validation-gate-composition.test.ts` | Expects a build command absent from CommandCenter.json. |
| `src/lib/shared/tailwind-utility-collisions.test.ts` | Flags 76 utility tokens in existing memory/session/UI components not covered by its migration inventory. |
| `src/lib/workflow-graph/route-consumers.arch.test.ts` | WorkflowBuilderCanvas reads authored edges without an inventory entry. |
| `src/lib/workflow-graph/spec-graph-boundary.arch.test.ts` | Reports ten existing graph imports in native spec delivery modules. |

Baseline attribution uses byte comparisons through `git show 8489cd68:<path>`, not an assertion that baseline tests were executed. All five tests, CommandCenter.json, validation schema, each reported UI/graph/spec offender, and all CSS/package inputs are unchanged from the reviewed baseline. The sole changed TSX file has an import-path-only edit in DebugStructuredCard. The entire scanned native spec roots are unchanged. Exact file hashes and equality results are retained in `.cc/temp/conversation-validation/10-full-baseline-failure-inputs.json`. These failures are outside the conversation lifecycle implementation and were not bypassed, weakened, or silently marked passing. The plan's all-green full-suite condition is therefore not established; there are no unresolved failures attributable to this implementation.

The full suite was not repeated after the source-location-only test correction: its complete file passed, production source did not change, and another full run would retain the five demonstrated baseline failures. All required conversation composition and affected checks have passing evidence above; no snapshot artifacts were rewritten by the final run. The branch remains unmerged. The scratch server also returned `ok: true` on stop (`10-live-final-server-stopped.json`).
