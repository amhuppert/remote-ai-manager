# Implementation validation — #112

Date: 2026-09-05. Independent synthetic forks and durable Cursor next-turn queueing are implemented using Alex's approved **Retain uncertain deliveries for review** recovery contract. Native anchored fork fidelity and automatic exactly-once replay remain provider limitations, detailed in [research.md](research.md).

## Acceptance status

| Ticket outcome | Status and evidence |
| --- | --- |
| Queue and cancel while Cursor runs; preserve model/images; FIFO delivery | Implemented. Authenticated session queue delivered two model-distinct messages once and in order, recognized the retained image, and omitted the cancelled message. |
| Recovery without silent loss or automatic duplicate execution | Implemented under the approved review contract. A real server process kill retained both in-flight messages and blocked the follower. Browser Retry/Discard then released the queue, preserving model/image data and stable provider continuity. Ambiguous execution is never automatically retried. |
| Independent anchored fork | Implemented. SQLite round trips cover immutable seed storage; authenticated source/fork turns and restart prove separate agent references, stores and histories. |
| Accurate labels and explicit native-fidelity blocker | Main, pane and peek show synthetic fork limitations. Queue rows distinguish next-turn, delivering, uncertain and failed states. No public Cursor anchored fork API exists in either inspected SDK version. |

## Registered validation

Behavior changes used failing assertion-level reproductions followed by registered file-scoped tests with `--require-match --json`. Display-only copy, badge wiring and stories used existing consumer checks and live visual inspection. No provider mock is used as evidence of SDK capability or absence.

| Check | Passing run |
| --- | --- |
| Fork service: exclusive user anchor and immutable seed separate from editable draft | `vrun-d182ddf6-b84f-4075-8491-34db35cdb04c` |
| Pre-turn seed persistence and first-turn selection | `vrun-1192f58f-1ca7-467e-86f1-d1ef8fed9f09` |
| Cursor first-turn seed composition | `vrun-dd054543-7479-4b71-a24c-13d0911c126a` |
| Cursor continuity: anchored seed, no source attach, empty-seed refusal | `vrun-7a5e3842-5af9-4eda-85ab-010e84483d51` |
| Synthetic seed bound and empty dialogue refusal | `vrun-f10463ea-fa98-4abd-8711-2504dba05fac` |
| Conversation repository maximal persisted-field round trip | `vrun-e5fb6c18-fdb1-4086-b12e-df4ceaf5fb26` |
| Queue claim ordering under competing model batches | `vrun-13a35410-d024-4bf3-8446-ce8209c46804` |
| Profile-admission race returns claim to pending in SQLite | `vrun-2c2f23f3-33b5-4d38-b2c1-81b7f8c4e7c5` |
| Durable failure recovery, retained images/model, retry identity and stale acknowledgements | `vrun-70b6b897-3f78-42b7-88ea-fbe6851c21f3` |
| Startup recovery and persisted idle status, both scopes | `vrun-798f67e3-88c8-45a0-97ec-4789ed56e293` |
| Actor startup is single-flight | `vrun-2e672c54-3289-4407-96fe-f53de272b7a1` |
| Queue waits for previous invocation teardown | `vrun-f63bc3a2-fde3-4f58-b703-b704362988e2` |
| Cursor cancellation and concurrent close wait for worker teardown | `vrun-c54316b5-530e-4d1f-abde-7ddbe50cf33c` |
| Queued finalization preserves prepare/execute failures | `vrun-0f99d29f-62d7-428f-8af1-2099e714c761` |
| Real session and project review routes persist before draining | `vrun-9b9e7fb5-b052-4b90-b444-d83eb5c498e2` |
| Composer Retry/Discard actions | `vrun-856c6bba-c445-418e-9691-bfc9da8f67bc` |
| Direct prompt refusal while review remains | `vrun-630bfe3e-73a5-4875-a6f7-7b918fc05f5e` |
| Workspace consumer with real conversation mutation hooks | `vrun-1137f8c1-09b0-459f-851d-55b3bc672762` |
| Backend consumer locality and queue error schema contracts | `vrun-8a6a375f-e618-4848-a9c4-b27e70bd582b` |
| Seed receipt: actual actor and SQLite retain history without acceptance and suppress it after acceptance | `vrun-0257b0e9-9f67-4685-8570-09f75b4e13b3` |
| Seed receipt is specific to the accepting agent | `vrun-c8b03b9b-1a2c-4656-ac1b-973021109cd1` |
| Cursor seed delivery after eager agent creation | `vrun-0eafe633-1afc-43a1-b983-d17716c2b569` |
| Codex consumer of the shared seed policy | `vrun-ebe14c82-e165-4083-a324-f49b85e046ff` |
| Both repository maximal round trips include the seed receipt | `vrun-824fca83-0842-4b23-8fd9-c98d69bdac98` |
| Cursor discarded-worker lifecycle behavior | `vrun-bc6bcae2-1945-4735-8dae-925c48e0f978` |
| Worker recovery permission across runtime, supervisor and IPC | `vrun-76016aa3-d9c8-4af6-b89e-80de881fb002` |
| Native run-record recovery, including successful resume with an active run | `vrun-5bfcfee3-d3ca-42a6-825a-b1858aac7a23` |
| Worker log ownership | `vrun-c33bfb7c-5ba5-4246-b991-efc88d37cc23` |

The broad checkpoints exposed a stale error-code expectation, an in-memory fixture reaching production recovery storage, and a workspace test mocking the entire mutation module. Those fixtures were corrected and the affected files passed. Their failed runs are not cited as overall passes. The broad run also exposed two fixtures that awaited turn completion before releasing worker teardown; these were corrected to exercise the teardown barrier. The final full-suite verdict and static checks are recorded below.

### Full repository suite

Run `vrun-eb82158a-952b-46e7-8526-d13d8fa89ed6` completed all 1,890 test files: **1,884 passed, 3 failed, 3 skipped**; **28,457 tests passed, 3 failed, 8 skipped**. This is a failed overall run. Its three failures are present in the unchanged branch baseline:

- `scripts/validate-cursor-acceptance.test.ts`: `CommandCenter.json` does not register `cursor-acceptance`.
- `scripts/validation-gate-composition.test.ts`: `CommandCenter.json` does not register `build`.
- `src/lib/shared/tailwind-utility-collisions.test.ts`: seven bare Tailwind classes in `CreateSessionModal.tsx` are missing from the test's utility-first classification.

The registration, both registration tests, collision test, modal and global stylesheet were verified byte-for-byte identical to HEAD `0f1a37f515a1526d1af44b6bc1b53ff75a6973fe`. That committed registration lacks both commands, and the committed modal contains all seven reported classes. No CSS files changed for #112; the queue review component is inside the collision test's existing utility-first prompt directory. These baseline issues were left unchanged. Evidence: `.cc/temp/cursor-112/final-test-full.json` and `full-baseline-proof.json`.

### Final checks

| Check | Passing run |
| --- | --- |
| Formatting | `vrun-9dd1cf5a-5606-4f7a-a16b-9bb50cdb59d3` |
| Lint | `vrun-c2bebc00-3758-45c0-a14f-c4877cd0e851` |
| Full TypeScript check | `vrun-03d369fe-04eb-4f35-89df-bb5b2b494f99` |
| Architecture seams | `vrun-0e8dacfb-4e2f-4022-a391-d84b694c278a` |

The live crash test also found a persisted `running` status despite successful queue recovery. Regression run `vrun-c2308ec5-fef6-4ea9-b7af-c13bd01459c6` failed specifically on `running` versus `awaiting` for both scopes. The passing startup run above verifies that recovery clears the stale status without discarding recorded costs; a second live restart confirmed working review controls.

## Authenticated live fork

The session-scoped dev server returned by `cctl dev ensure nextjs` served this branch at `http://localhost:3002`. Test state used this worktree's `.config/` database and a scratch project nested inside `.cc/temp/cursor-112/projects/`. No production datastore was used. Real Cursor calls used Composer 2.5 with its advertised `fast=true` model parameter.

| Identity | Source | Synthetic fork |
| --- | --- | --- |
| CC conversation | `3f50a675-1296-4758-bc04-1856ebad7019` | `27568dd8-c8be-4724-96ee-98a5c04731d2` |
| Cursor agent | `agent-672d85f3-45b3-486d-8f56-f423938087f8` | `agent-74f000c6-dc38-480e-9e06-c485c558ce88` |
| Store directory | `.config/cursor/agents/3f50a675-1296-4758-bc04-1856ebad7019/` | `.config/cursor/agents/27568dd8-c8be-4724-96ee-98a5c04731d2/` |

The source remembered `ORBIT112`. The fork endpoint returned `forkMode: synthetic` at assistant message index 1. The source then replaced its secret with `COMET112`; the fork independently answered `ORBIT112`. Its saved seed includes only the initial user/assistant exchange and its own transcript excludes the source update. The stores contain separate agent records, runs, events and checkpoints. Prompts requested no tool use or file changes.

Evidence: `.cc/temp/cursor-112/live-forks.mjs`, `source-initial.sse`, `source-update.sse`, `fork-recall.sse`, `fork.json` and `live-session.json`.

After stopping and restarting the managed dev server, both conversations resumed with their original references. The source answered `COMET112`; the fork answered `ORBIT112`. `fork-verification.json` records assertions over the response streams, stable independent references and separate store ownership. The probe establishes independent histories and references; it does not claim automatic replay of a failed first prompt.

Browser inspection confirmed the full conversation and pane display “synthetic fork” and permit Cursor fork actions. A screenshot was visually inspected. Next.js MCP `get_errors` returned empty configuration and session error arrays. PeekPopover's display wiring passed its existing consumer test; the live peek was not separately verified.

The fixture session was deleted through `cctl fixture session delete`, including its scratch git worktree. Its two provider stores and both standalone SDK probe stores were removed. The dev configuration's raw object was restored and checked for exact equality with the saved original. Evidence files remain under `.cc/temp/cursor-112/`; `cleanup.json` records completion. The server was subsequently reused for the queue tests below and stopped after cleanup.

## Authenticated live queue and recovery

The queue tests used the same session-scoped branch server and isolated worktree database. A session fixture and one project conversation exercised both actual API scopes with real Composer 2.5 calls.

### Session queue

Conversation `2eaf0c82-c3fe-4e1c-a5c1-baf7bd7ae037` ran a shell sleep while three messages were queued. One was cancelled. The two remaining rows carried different `fast` model settings; the first also carried a blue PNG. Durable readback before delivery preserved those settings and the image. The completed transcript contained each queue ID once, in order, and no cancelled ID. The responses were:

```
HEAD112
QUEUE_A112 blue
QUEUE_B112
```

Evidence: `.cc/temp/cursor-112/queue-live-normal.json`, `queue-before-drain.json`, `queue-after-drain.json`, `queue-messages.json`, and `live-queue.mjs`.

### Project crash and explicit review

Project conversation `f8870d23-4e3b-4dc0-aac5-119b9de62ffb` queued two same-model messages followed by a different-model follower. A SQLite observer saw both first messages claimed in one batch and killed only the verified Next.js process belonging to this worktree. At that instant the durable states were `delivering`, `delivering`, `pending`.

After restart they were `uncertain`, `uncertain`, `pending`, with the image, complete model settings and original attempt IDs preserved. No automatic turn ran. A direct prompt was refused with the delivery-review message. The recovered conversation became `awaiting`, making its review controls usable.

Using the real project composer at desktop and 390-pixel mobile widths:

1. Retry changed the first row to pending with a fresh ID, preserving its position, image and `fast=false` selection. The queue stayed paused because the second row remained uncertain.
2. Discard removed the second row. The retried first row and the `fast=true` follower drained automatically.
3. Durable transcript verification found each delivered queue ID once and in order, preserved model selections and the image, and no discarded or bypass-prompt execution. The replies were:

```
PROJECT_HEAD112
RETRY_A112 blue
AFTER_C112
```

The provider reference stayed `agent-4c81df1c-b0f5-4f60-a41a-9d0f2f4224d4` through restart and review. Evidence: `.cc/temp/cursor-112/queue-at-crash.json`, `queue-recovery-blocked.json`, `queue-after-review-retry.json`, `queue-recovered-messages.json`, `queue-live-recovery.json`, `live-queue-crash.mjs` and `verify-queue-recovered.mjs`.

Desktop/mobile screenshots were visually inspected. The recovery controls wrapped within the mobile width and were usable for both actions. Next.js MCP returned empty configuration and session error arrays before cleanup. The test does not prove a user-requested Retry cannot repeat previously accepted work; the UI explicitly describes that possibility.

### Cleanup

The session fixture was deleted through `cctl fixture session delete`. The completed project fixture was archived through its API, then its exact row was removed from this worktree's isolated database while the managed dev server was stopped. Both provider stores, fixture transcripts and images were removed. The raw dev configuration was restored and checked for exact equality with its saved original. The browser page was closed and the managed server was left stopped. Evidence: `.cc/temp/cursor-112/queue-cleanup.json` and `queue-config-restored.json`.


## First-fork interruption and native run recovery

A second isolated fixture used source conversation `7319e2b9-81ef-411e-89f3-55874e761800` and source agent `agent-0b579956-cd80-48d6-83e6-538585735410`. The source remembered `LANTERN112`. A SQLite observer killed the verified branch Next.js process as soon as fork conversation `aac870b3-3374-4884-bfb6-2de9b4a01f6d` persisted its fresh reference, before `syntheticSeedAcceptedRef` existed.

The abandoned provider run was `run-76aed975-7d13-4dbf-a12e-e70bb5c8396b`. A failed restart probe established that Cursor can return a generic `UnknownAgentError` on send even after resume succeeds. Regression `vrun-f2aa24e1-3a6b-4d88-87b5-a3ec76942ee8` failed on precisely that missing recovery behavior. CC now inspects native run records under the worker ownership guard before resuming.

On the subsequent application restart, CC's worker called the native cancellation API and recorded `cursor-worker.abandoned_run_cancelled` for that exact abandoned run. The provider store confirmed `cancelled`. The first successful fork prompt then answered `LANTERN112`, kept its original independent agent `agent-47fca7af-2ea2-4a51-9308-3cb76c7f80ac`, and persisted that same reference as the seed acceptance receipt. No manual cancellation was performed for this fork. The earlier separate manual cancellation probe was SDK research, not application recovery evidence.

Evidence under `.cc/temp/cursor-112/`: `live-fork-accept-crash.mjs`, `live-fork-accept-resume.mjs`, `fork-accept-at-crash.json`, `fork-automatic-before-native-recovery.json`, `fork-automatic-recovery-proof.json`, `fork-automatic-resume-result.json` and `fork-accept-live-result.json`.

The fixture session and its scratch worktree were deleted with `cctl fixture session delete`. All three fixture conversations were confirmed absent from the isolated database, and their provider stores, transcripts and images were removed. The original raw dev configuration was restored with an exact equality check. The managed server was left stopped. Cleanup evidence: `fork-accept-cleanup.json`, `fork-accept-config-restored.json` and `fork-accept-artifacts-removed.json`.
