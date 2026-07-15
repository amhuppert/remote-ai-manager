# XState Machines Design Review

**Date:** 2026-07-11
**Commit:** `349a3f46`
**Scope:** All XState machines (`src/lib/workflows/`), their hosting/persistence layers, every hand-rolled lifecycle in `src/lib/` evaluated as a machine candidate, and every retry/fix-loop implementation.
**Method:** Three parallel review agents (machine deep-review, hand-rolled-lifecycle inventory, duplicate-instead-of-reuse inventory), evaluated with the *A Philosophy of Software Design* lens (deep vs shallow modules, information hiding, change amplification, one owner per decision). All consumer claims grep-verified, production vs test/catalog distinguished.
**Builds on:** `2026-07-11-composable-modules-architecture-audit.md` and `2026-07-11_composition-units-design-review.md` — this report verifies, quantifies, and extends their XState findings; it does not repeat their full context.

**Overall XState-layer score: 4.5/10** (machine cores are good; the layer around them — shared tier, hosting, persistence, steering docs — is half-finished and partly fictional).

---

## Executive summary — direct answers

**Does the design of our XState machines make sense?** For the two machines that carry real weight — yes. The conversation machine's turn spine and the merge machine are genuinely deep modules, and the merge machine being reused wholesale by graph fan-in joins is the layer's best composition win. The design problems are concentrated in everything *around* the cores: the commit machine is a ~90% transcription of merge's mid-pipeline, debug mode consumes roughly half the conversation machine, two of the five catalog-advertised machines orchestrate nothing, and hosting/persistence/steering each tell a different story than the code.

**How many features should be implemented using XState machines, but are not? Zero.** Twelve hand-rolled lifecycle candidates were inventoried (§3). The only one that hits every "should be a machine" criterion — the graph workflow execution lifecycle — has already converged, post-RCA, on an equivalent hand-rolled design (single event-dispatch funnel, guards, epoch-fenced serialized writes, rehydration, persisted lifecycle snapshot). Its actual production bug class (zombie cross-generation writes) required persistence-layer fencing that XState would not have provided. Two features need a **single transition owner** short of XState (§3.1, §3.2); the other nine are correctly-shaped explicit code, several of them exemplary.

**How many features should have reused an existing XState machine but introduced a duplicate implementation instead? Two clear cases, plus three systemic duplications one layer down.**

1. **Optimistic mode** — production (`src/lib/shared/optimistic.ts`) duplicates the optimistic machine's actor line-for-line, and a parity test exists to keep the two copies synchronized instead of eliminating one (§2.3).
2. **Commit** — duplicates the merge machine's validate → fix → revalidate topology and guards verbatim instead of sharing a state fragment; the duplication has already produced a real divergence (the validation-timeout fix landed only in merge) (§2.1).

The systemic ones: machine **hosting** is copy-pasted per machine across `jobs/queue.ts` and `graph-merge-runner.ts` (§2.2); machine-**snapshot persistence** has six-plus owners (§2.4); and **retry** — the shape `retry-machine.ts` was built to own — is hand-rolled 14 times in production while the generic machine has zero consumers (§2.5). The retry finding inverts the question: the dead machine is the duplicate, not the hand-rolled code.

The overall inversion worth internalizing: **Command Center does not under-use XState. It over-declared an aspirational XState tier that production never adopted, while the three real machines quietly duplicated each other's topology, hosting, and persistence.** The fix is deletion and consolidation, not more machines.

---

## 1. Machine-by-machine assessment

| Machine | Lines (machine+types+actors) | States | Events decl./handled | Actors | Guards | Context fields | Production host | Verdict |
|---|---|---|---|---|---|---|---|---|
| conversation | 1,377 + 422 + 67 (subsystem ≈ 8,000) | 17 | 22 / 20 | 4 | 11 | 23 (+11 debug, +5 totals) | `conversation/manager.ts` registry + startup rehydration | **Deep core, shallow assembly — 5/10** |
| merge | 772 + 198 + 662 | 23 | 1 / 0 (dead `ABORT`) | 11 | 19 (+2 dead) | 36 (3 dead) | `jobs/queue.ts` ×2 dispatchers + `graph-merge-runner.ts` | **Deep, fraying interface — 7/10** |
| commit | 278 + 79 + 0 (actors imported from `merge/actors`) | 8 | 0 / 0 | 4 (all merge's) | 3 (verbatim merge copies) | 18 (strict subset of merge's) | `jobs/queue.ts` | **Shallow by construction — 3/10** |
| optimistic | 173 + 62 + 107 | 4 | 1 / 0 | 2 | 0 | 15 | **none** | **Dead + duplicated + pinned — 1/10** |
| retry (factory) | 198 | 4 | 0 | 2 | 1 | 6 | **none** | **Well-shaped, unadopted — 2/10** |

Key per-machine notes (full evidence in the agent findings; representative anchors below):

- **conversation** — the turn spine (acquire resources → execute → finalize, backendRef durability, ask-question survival, queue-drain-on-settle) is real hidden complexity behind a small event vocabulary. But: debug mode occupies **8/17 state nodes (47%), 10/22 events (45%), 10/11 named guards (91%), and 7/9 `finalizingTurn` always-branches** (`machine.ts:684-1003`) — worse than the prior audit's estimate. The machine has **zero `final` states** (grep-confirmed), so its `output` block (`machine.ts:1369-1373`), `ConversationOutput` type, and the manager's terminal-flush subscriptions (`manager.ts:1020-1044`, `1420-1425`) are all dead code. The `SUBMIT_PROMPT` claim transition is triplicated (`machine.ts:300-312`, `1017-1029`, `1117-1129`); the codex-error preservation rule is copied verbatim in both `executing` branches (`592-597` vs `661-666`). External turns hollow the machine out: `externalExecuting` invokes nothing — the work happens in `external-turn-handler.ts:64-169` and the machine is a status mirror for that path. Graph-only flags (`waitForBackgroundTasks`, `askUserQuestionsEnabled`) leak into the general turn types (`types.ts:64-81`).
- **manager.ts (1,633 lines)** is four modules in one file — actor registry + `.provide()` bindings, a ~290-line message-queue drain engine, ~300 lines of rehydration policy, and project-conversation notification policy — with **five** separate DI seams, the classic signature of an over-absorbed module. Its `createProvidedMachine` (`732-749`) re-provides two actors with wrappers byte-equivalent to the defaults in `actors.ts`, so the stub/production distinction the steering pattern exists for is illusory here.
- **merge** — hides a lot (conflict resolution, agent fix loops, prepare/publish CAS, session finalization) behind a run-to-done actor, and `graph-merge-runner.ts:114` reuses it with a single input flag. Dead surface: unhandled `ABORT` event, 2 dead guards (`isMergeEntry`, `casRetriesRemaining` — the CAS logic is re-implemented inline at `machine.ts:619-626`), 3 dead context fields, and a vestigial `jobType: "merge" | "commit" | "resolve-conflicts"` (`merge/types.ts:42`) from when commit ran through this machine.
- **commit** — every one of its 6 working states has a structural twin in merge (§2.1). Functionality-per-new-interface is near zero.
- **optimistic / retry** — zero production consumers each; both exist in the catalog UI, whose header calls all five "the 5 XState machines orchestrating Command Center" (`machine-specs.ts:2`). Two of the five orchestrate nothing.

**Steering-convention compliance is zero-for-five.** No machine fully follows `.kiro/steering/workflows.md`: conversation has no final states/`finalStatus`/`onTerminal`; merge and commit's `onTerminal` stub is "overridden" in production with another no-op (`queue.ts:617-620`, `709-711`) — terminal side effects actually live in the job-queue subscriber; the actor stubs-are-production inversion holds for merge/commit/optimistic; the steering doc also documents the dead root tier (`runtime-state.ts`, `persistence.ts`, `actions.ts`) as live infrastructure and shows the dead root runtime-state's 2-part key as the pattern while the real one (`conversation/runtime-state.ts`) uses a 3-part key.

---

## 2. Duplication, quantified

### 2.1 Commit vs merge: ~90% topology transcription with a materialized divergence bug

All six of commit's working states recur in merge; of commit's ~165 lines of state config, ~85–90% transcribes merge lines 292–303 + 407–530:

| commit (`commit/machine.ts`) | merge (`merge/machine.ts`) | Duplication |
|---|---|---|
| `committing` (109-129) | `committingUncommitted`/`committingResolution` (292-303, 394-405) | same actor + `skipHooks` |
| `validating` (131-157) | `validating` (407-439) | same actor, identical 6-field input mapping |
| `fixingValidation` (159-193) | `fixingValidation` (441-468) | near byte-identical |
| `checkingFixChanges` (200-216) | `checkingFixChanges` (470-480) | semantically byte-identical incl. best-effort `onError` |
| `committingFix` (218-232) | `committingFix` (482-493) | identical incl. literal `"auto-fix: validation errors"` message |
| `revalidating` (234-268) | `revalidating` (495-530) | same actor + fix-retry loop |

The 3 commit guards are verbatim copies of merge's (`commit/machine.ts:69-78` vs `merge/machine.ts:126-148`); commit's context is a strict subset of merge's.

**The cost is no longer hypothetical.** After the pre-merge-timeout incident, `validationTimedOut` short-circuiting was added **only to merge** (`merge/machine.ts:420-427`, `511-518`). Commit's `validating.onError` (150-156) still unconditionally routes to `fixingValidation`: a commit job whose validation script is killed by timeout will burn LLM fix turns on an unfixable environment limit — exactly the failure mode the merge fix was written for.

**What's already shared, and what isn't:** actor sharing is done — commit imports all four actors from `merge/actors.ts` (`commit/machine.ts:28-33`), though they live under a `"smart-merge-actors"` logger, leaking the merge domain into commit. What's still duplicated is the **loop topology**. The right extraction is a state-fragment factory in the vein of the existing `createTerminalStates` (`utils.ts:111-122`) — e.g. `createValidationFixStates({ onValidated, onTimeout })` returning the 5-state validate→fix→check→commit-fix→revalidate fragment. Genuine invariant differences (merge's 5 finals with phase retention, `autoResolve` conditioning, CAS loop, session finalization) argue **against** merging the two machine topologies — two machines is defensible; two hand-copies of the fix loop and three copies of its guards are not.

### 2.2 Hosting is duplicated per machine — three times for merge alone

- `subscribeMergeActor` (`jobs/queue.ts:364-453`) vs `subscribeCommitActor` (`459-503`): identical structure (phase-diff broadcast, output→job mapping, identical defensive error handler including the same comment), differing only in output-field copying.
- Three near-identical dispatch implementations: `dispatchMergeJobImpl` (547-627), `dispatchCommitJobImpl` (652-719), `dispatchResolveConflictsJobImpl` (748-830).
- `graph-merge-runner.ts:117-130` re-implements `subscribeMergeActor`'s `lastPhase`-diffing loop as a third host.

One generic `subscribe<TOutput>(actor, job, mapOutput)` plus one dispatch harness parameterized by machine/input/jobType would collapse all five.

### 2.3 Optimistic mode: production duplicates the machine line-for-line, and a test pins the duplication

`shared/optimistic.ts:80-115` (production, called from `sessions/service.ts`) duplicates `optimistic/actors.ts:56-106` line-for-line — same autonomous-prompt string, same 500 ms sleep, same `` `Optimistic: ${instructions}` `` message — and `section-6-3-merge-optimistic-parity.test.ts` exists to keep the two copies in sync: a test that cements duplication instead of eliminating it. The machine itself is 4 states wrapping 2 function calls (classic shallow). **Resolution: delete the machine**, keep the procedural orchestrator (it is the production-proven one), and drop the parity test with it.

### 2.4 Machine-snapshot persistence has six-plus owners

1. `conversation/persistence.ts` (279 lines) — the only real implementation: debounce, `_schemaVersion` validation, legacy-shape coercion.
2. Root `workflows/persistence.ts:21-47` — an explicit no-op (comment admits the storage location no longer exists), still documented in steering as "Debounced snapshot writes".
3. Commit/merge — **no persistence at all**: jobs live in an in-memory globalThis map (`queue.ts:84-89`); a server restart mid-merge orphans the job until the 10-minute stale sweep force-fails it. No rehydration exists for either machine. (This may be an acceptable "jobs are ephemeral" decision — but it is nowhere decided or documented.)
4–7. `workflow-graph` has **four private `buildMachineSnapshot` copies** (`workflow-manager.ts:370`, `iteration-orchestrator.ts:355`, `execution-loop.ts:367`, `execution-tool-context.ts:123`), each hand-building the same 5-field `GraphWorkflowLifecycleSnapshot`, written from ~25 call sites — and these aren't XState snapshots at all, a third unrelated meaning of "machine snapshot" in the same codebase.

### 2.5 Retry: 14 hand-rolled production implementations vs one dead generic machine

`retry-machine.ts` models exactly attempt → fix → reattempt; consumers: catalog UI + its own test. Meanwhile production hand-rolls the pattern in four families:

- **A. Agent-fix-between-attempts loops (6):** commit fix loop, merge fix loop, graph context-validation reopen loop (`iteration-orchestrator.ts:843-923`), graph script-validator remediation loop (`940-1013`), compaction envelope retry (`context-artifacts/service.ts:422-510`), collab two-pass structured output (`agent-caller-production.ts:366-395`).
- **B. Stale-backend/infra single-retry recoveries (5):** the **JS Proxy retry** inside the conversation actor (`actor-implementations.ts:1048-1094` — a `get`-trap on `sendTurn` implementing exactly one retry with a runtime-replacement "fix", smuggling the raw result and original error out via closure mutation), `WorkflowAgentCaller` stale-ref retry (`workflow-agent-caller.ts:180-197`), `workflow-continuity-service` recovery (**5 sites**, self-documented in-source as the "legacy graph-only equivalent" of WorkflowAgentCaller), join-runner conflict clean-retry (`join-runner.ts:217-231`), execution-loop SDK-error recovery (`execution-loop.ts:1449-1487`).
- **C. Lock/probe polling (3):** `project-lock-retry.ts:38-62` and `session-git-lock.ts:44-99` are the **same loop with the same constants written independently** — despite `project-lock-retry.ts:5-8` saying it exists "so the two call sites can't drift"; plus the gateway URL probe.
- **D. Redelivery queues (2):** message-queue redelivery (uncapped `attemptCount` — see Appendix), graph merge retry queue.

**The verdict inverts the framing:** a generic retry *machine* is the wrong shared unit. The two XState retry loops are interleaved with domain states a child machine can't express without becoming a DSL; every non-XState retry lives in async service code where an actor is ceremony. The one retry-adjacent unit that genuinely took hold is a **pure policy function** — `runCircuitBreakerGate` (`circuit-breaker-gate.ts:37-65`), consumed by both graph failure paths. That's the pattern that composes here. Consolidations worth doing: delete `retry-machine.ts`; merge the two lock-poll twins; migrate `workflow-continuity-service`'s 5 recovery sites onto `WorkflowAgentCaller`; replace the Proxy with a named `withRuntimeReplacementRetry` wrapper.

### 2.6 The dead shared tier (verified current)

| Root module | Production consumers |
|---|---|
| `setup.ts` (`createWorkflowSetup`) | 0 — all five machines call raw `setup()` |
| `actions.ts` | 0 — and it is the sole importer of the no-op persistence |
| `persistence.ts` | 0 (self-documented no-op) |
| `runtime-state.ts` | 0 — `conversation/runtime-state.ts` is a copy-then-abandon duplicate with a different key shape |
| `types.ts` (`BaseWorkflowContext`) | merge/commit/optimistic extend it; **conversation does not** |
| `utils.ts` | the one live root module — but `createTerminalStates` is used only by commit; merge hand-writes its 5 terminals because the helper can't express phase retention |

---

## 3. Hand-rolled lifecycles: should any be XState machines?

Twelve candidates inventoried. Verdicts: **0 should-be-machine, 2 need a single transition owner, 9 fine as-is, 1 N/A** (tickets — absent on this branch).

### 3.1 Graph workflow execution lifecycle — SINGLE-TRANSITION-OWNER (context layer)

The one candidate that hits all five machine criteria (6 execution states / 7 context states / 5 task states, events from 8+ sources, persistence, guards, a real zombie-loop incident). But the picture has changed since the prior audits: **the execution-level status is now effectively single-owner.** Post-RCA, every write flows through `workflow-manager.ts` — an event-dispatch API literally named `send()` (`:536-555` funnel `transitionToNonRunningState`), resume with resumable-status guard + epoch bump (`:929-973`), restart normalization — and all writes are Zod-parsed and **loop-fence-asserted inside the serialized critical section** (`execution-repository.ts:362-386`; `StaleLoopFenceError` at `execution-loop.ts:2614-2641`). The zombie-loop bug was a cross-process persisted-write problem; the fix (epoch + AsyncLocalStorage fence at the write path) is orthogonal to statechart modeling and would still be needed under XState. Converting the most battle-hardened code in the repo would be a structural rewrite for marginal modeling benefit.

**The actionable gap is one level down: context-level status has 9 writer modules** (`workflow-manager.ts` ×8 sites, `execution-loop.ts:853`, `iteration-orchestrator.ts` ×3, `approval-gate.ts` ×2, `user-input-gate.ts` ×3, `graph-workflow-signal-halt.ts:44`, `workflow-collaboration-coordinator.ts:133`, `reset-context.ts`, `migrate-legacy-execution.ts`) with **no legality-checked `transitionContextStatus()` function** — nothing structurally prevents a future writer from flipping a `completed` context back to `running`. Consolidate the 9 writers into one guarded transition function and let it own `machineSnapshot` upkeep (absorbing the 4 duplicate builders of §2.4). Joins (4 writer modules) and `mergeStatus` (~5) would be absorbed by the same owner.

### 3.2 Dev server — SINGLE-TRANSITION-OWNER

`registry.ts` has a proper owner, `transitionTo()` (`:260-275`) — but `liveness.ts:110-128` and `reconciliation.ts:102,132` bypass it, writing `entry.status` directly and hand-duplicating its broadcast logic. Three writer modules, two duplicating the owner's broadcast: the drift pattern that precedes a state bug. Route both through the existing owner. XState per entry would be ceremony — each entry's status shadows an observable OS process 1:1, in-memory by design.

### 3.3 Fine as-is (9)

| Candidate | Why it's right as explicit code |
|---|---|
| Background job queue (`jobs/queue.ts`) | It *hosts* the machine actors; its own wrapper has exactly one non-machine transition, single-module writes, startup recovery. The pipeline complexity is already inside XState. |
| Conversation message queue | The codebase's exemplar hand-rolled machine: every transition a pure guarded transform (claim-by-`attemptId`, refusal reasons, orphan recovery). XState would *lose* the pure-function testability. |
| Codex runs | Strictly linear fire-and-forget; all transitions in one `terminal()` closure. (Missing startup sweep — see Appendix.) |
| Session alignment charter | 3 states, single service owner, supersede+version+activate in one repo transaction. The past banner bug was a missing broadcast, not a transition bug. |
| Collaboration round protocol | A linear async pipeline with a policy decision per round; the deliberate two-envelope duplication makes "workflow lanes can never pause for humans" a *construction* guarantee enforced by lint-forbidden imports. One unified machine would demote that to a runtime guard — strictly worse. |
| Prompt execution | Already machine-backed: `sdk-driver.ts` is explicitly a facade delegating to the conversation machine; single-flight is a binary lock; first-turn-dispatch is a synchronous exactly-once claim. |
| Approval / user-input gates | Atomic check-and-sets inside single mutations with typed failure reasons; races with pause/halt/abort resolved inside the mutation. Prior audit's "deep and healthy" holds. |
| Merge intents | Append-only records; no lifecycle exists. |
| Session/conversation status | The reference architecture: conversation status has exactly one writer (the machine), sessions derive status rather than store it. |

### 3.4 Entry points: no bypass duplicates the machine

All turns with conversation semantics enter through four machine doors — `SUBMIT_PROMPT` via `executePromptStream` (~8 producers), queue drain, `SUBMIT_TASK_RUN` via `executeWorkflowTaskRun` (~7 producers including both Claude and Codex graph validators), and `EXTERNAL_TURN_*`. The three paths that bypass the machine (collaboration lanes, Codex background runs, session-name generation) are genuinely different execution shapes — headless negotiation lanes and one-shot tasks with no conversation record. **Zero turn-execution paths were found that should reuse the machine but don't.** The real duplication sits one level down: three parallel stale-backend-recovery stacks (conversation-actor Proxy, `WorkflowAgentCaller`, `workflow-continuity-service`) behind those doors — §2.5 Family B. Client-side is clean: no mirror machine, flat presentation flags with server-derived authority.

---

## 4. Scorecard against the composition goals

| Goal | Score | Assessment |
|---|---:|---|
| Composability | 5/10 | Merge-machine reuse by graph joins and the shared merge actors in commit are real wins; but topology, hosting, and snapshot code don't compose — they're copied. |
| Testability | 7/10 | `.provide()` DI and zero-`vi.mock` machine tests are exemplary; deductions for the parity test that pins duplication, and dead output contracts that can't be tested because they're unreachable. |
| Flexibility | 5/10 | The conversation machine absorbs variation by growing (debug 47% of states, graph flags in general types) rather than by composition seams. |
| One way per problem | 3/10 | Retry ×14+1 dead machine; snapshot persistence ×6; hosting ×5 impls; optimistic ×2 pinned by a test; terminal-state construction ×2; runtime-state ×2. |
| Truthful architecture | 2/10 | Steering documents a dead tier as canonical; the catalog presents 5 machines when 3 orchestrate; conventions followed fully by zero machines. |

---

## 5. Recommendations, prioritized

Ordered by information-hiding return per unit of risk. Items 1–3 echo the prior reports' P0s with sharper scope; 4–7 are new to this review.

1. **Delete the dead tier and rewrite `.kiro/steering/workflows.md`** around what exists: remove root `setup.ts`, `actions.ts`, `persistence.ts`, `runtime-state.ts`, `optimistic/` (keep `shared/optimistic.ts` — it is production; drop the parity test), and `retry-machine.ts`. Re-point steering at `conversation/{persistence,runtime-state}.ts` as the real patterns, and fix the catalog's "5 machines orchestrating" framing. ~820 lines and, more importantly, the false map, gone. Every new contributor is currently being misdirected.
2. **Extract the validation-fix loop once** — `createValidationFixStates(...)` fragment (sibling of `createTerminalStates`) consumed by commit and merge; move the shared actors from `merge/actors.ts` to a neutral home. This fixes commit's missing timeout guard as a side effect (a live bug-in-waiting) and collapses ~120 duplicated lines + 3 duplicated guards. Keep the two machine topologies separate — their terminal/CAS/finalization invariants genuinely differ.
3. **Unify machine hosting in `jobs/queue.ts`** — one generic subscriber + one dispatch harness; reuse the phase-diff observer in `graph-merge-runner.ts`. Then decide `onTerminal`'s fate (it is dead in practice everywhere): use it or delete it from both machines and the steering doc.
4. **Add `transitionContextStatus()` to the graph engine** — one guarded, legality-checked transition function absorbing the 9 context-status writers, owning `machineSnapshot` upkeep (collapsing the 4 `buildMachineSnapshot` copies). This — not an XState conversion — is the right machine-shaped investment in the graph engine.
5. **Evict debug mode from the conversation machine** (target-doc step 8, re-confirmed with worse numbers: 47% of states, 91% of guards, 78% of finalize branches). Then resolve the machine's finality question: add final states or delete the dead `output`/terminal-flush path. Split `manager.ts` by knowledge (queue-drain → conversations domain, rehydration → own module).
6. **Consolidate the three stale-backend-recovery stacks** — migrate `workflow-continuity-service`'s 5 recovery sites onto `WorkflowAgentCaller` (in-source comments already call it the legacy twin); replace the conversation actor's Proxy retry with a named `withRuntimeReplacementRetry` wrapper sharing the classify → corrective-action → single-reattempt shape.
7. **Small unifications:** merge `project-lock-retry.ts` + `session-git-lock.ts` (verbatim twins that already drifted into existence against their own header comment); route dev-server `liveness.ts`/`reconciliation.ts` writes through `registry.transitionTo`.

### What not to do

- Do not convert the graph execution loop (or its lifecycle layer) to XState — the hand-rolled design has converged on machine-grade guarantees plus persistence-layer fencing XState can't provide.
- Do not merge the commit and merge machine topologies — share the fragment and actors, keep the machines.
- Do not build a more general retry machine — the proven composable unit here is the pure policy gate.
- Do not unify the two collaboration envelopes — the duplication is a construction guarantee.
- Do not add machines to the nine fine-as-is lifecycles; several (message queue, alignment, gates) are better designs than the machines themselves.

One boundary on this list: it forbids *drifting* into generality, not deciding on it. A deliberate workflow DSL may yet earn its place as workflows grow more sophisticated — if it does, its natural substrate is declarative configuration interpreted by the deterministic graph engine (the graph plan schema is already an embryonic DSL), not a generalized statechart. Nothing here takes that option off the table; it only says the retry/optimistic machines are evidence against reaching it by generalizing XState topologies.

---

## Appendix — side defects surfaced (not XState problems, worth filing)

- **Commit machine lacks merge's validation-timeout short-circuit** (`commit/machine.ts:150-156`) — will burn agent fix turns on environment timeouts. Fixed for free by Recommendation 2.
- **Message-queue `attemptCount` has no cap** (`message-queue-service.ts:178,232`) — a poison message can be re-claimed indefinitely. One-line policy guard.
- **Codex runs have no startup sweep** — a `running` row orphaned by server death stays `running` forever, and `cancelCodexRun` on it is a silent no-op (`codex-runs/service.ts:358-366`). Copy the ~15-line `recoverStaleJobs` pattern from jobs.
- **Commit/merge jobs are not restart-durable** (in-memory actor map, 10-minute stale force-fail) — acceptable only if "jobs are ephemeral" is decided and documented; currently it's accidental.
- **Dead machine surface:** conversation's `RESOURCES_ACQUIRED`/`RESOURCES_FAILED` events (declared, never handled); merge's `ABORT` event, `isMergeEntry`/`casRetriesRemaining` guards, `squashMerge`/`commitHash`/`targetWorktreePath` context fields (`commitHash` is output but never assigned — an always-null output field); optimistic's `ABORT`.
