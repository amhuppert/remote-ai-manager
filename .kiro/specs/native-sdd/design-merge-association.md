# Design addendum: merge association policy (delivery-gate closure)

**Status:** Decision points resolved by Alex 2026-07-19 (DP1 mainline · DP2 refuse at dispatch · DP3 gate every target) — awaiting design approval to begin implementation
**Remediates:** R18 / R11 delivery-gate bypass (live-test report `.cc/temp/native-sdd-live-test-report.md`, "Unfixed release blocker: merge provenance")
**Extends:** `design.md` D12 (delivery gate), the "Delivered" transition row, and the composition-wiring section. On approval, fold the decisions here into those sections and append the tasks to `tasks.md`.
**Date:** 2026-07-19

The [delivery-flexibility contract](design-delivery-flexibility.md) extends this association design. A running session-delivery execution carries `specExecutionId` independently of a workflow id. Merge initiation assesses its readiness before preparation and opens the pinned delivery review; dispatch persists the association, and publication rechecks it. The successful mainline merge remains the basis for CC-observed delivery. A separately attributed external-delivery execution records work the human reports as already shipped.

## 1. The defect and the design gap

The live round merged unproven spec-execution work into `plc-test-lab` main: user `/merge` created job `9ad7aa0f` with `execution_id = NULL`, the delivery gate never evaluated, and spec execution `9767e2b2` stayed `running` with no proof and no `delivered_at`.

This is a **design gap, not an implementation deviation**. D12 deliberately specified the gate to "no-op without a linked execution," and the rollout plan shipped the merge-machine change "dark (no executionId callers) before the execution path activates it." The activation only ever covered one caller — graph `final_publish` joins (`join-runner.ts:197-202`). No owner was ever assigned for stamping provenance on user-initiated merges. The result is six entry points into the shared merge machinery, five of them permanently unlinked:

| Entry point | Site | Provenance today |
|---|---|---|
| Conversation `/merge` | `conversation-commands/service.ts:420` | none |
| HTTP session merge | `git/route-handlers.ts:407` | none |
| Conflict retry | `git/route-handlers.ts:449` → `dispatchResolveConflictsJob` (no fields exist) | dropped |
| Optimistic auto-merge | `shared/optimistic.ts:108` | none |
| Legacy direct fan-in | `workflow-graph/execution-loop.ts:1123` (`runFanInMerge`) | none |
| Graph `final_publish` join | `workflow-graph/join-runner.ts:197` | `executionId` + `finalPublish` ✓ |

Land/discard re-entry of a parked candidate is already correct: it copies `executionId`, `finalPublish`, and `candidateValidation` from the registered job (`git/route-handlers.ts:526-528`). It is the model for MA5 below.

Two concrete holes compose into the observed failure:

- **H1 — the workflow can complete with zero gated publish.** The compiled single-context execution resolved to the *legacy* worktree path (`executionTargetResolver` returned `laneId: null`), so `runFanInMerge` merged the lane straight into the session on context completion. At quiescence, `planFinalPublishJoin` found no unmerged lanes and returned null — the synthesized `final_publish` join (the only provenance-carrying merge) was vacuously skipped.
- **H2 — user merges carry no provenance.** Every user-facing entry dispatches without `executionId`; `delivery-gate.ts:114-123` then passes through silently. Unproven work reaches main through an ordinary `/merge`.

Everything downstream of the stamp already works: the machine evaluates the gate on every entry into publishing (`machine.ts:494-536`), refuses into a typed `deliveryGateFailed` state, synthesizes deterministic proof from the merge's own validation fact (`issueCandidateProof`, `delivery-gate.ts:599`), enforces the per-criterion proof/waiver/delivered-elsewhere floor (`transitions.ts:561-652`), and read-path reconciliation marks Delivered from the persisted published-merge job (`execution-service.ts:1003`, `findLatestPublishedMergeByExecutionId`). The missing piece is exclusively *who stamps the job, and when*.

## 2. Governing requirements

- **R18.2** — "When merge is requested, the delivery gate shall evaluate exactly the criteria selected by the pinned scope." Any merge request of execution work, not only workflow-internal joins.
- **R18.3/18.4** — per-criterion acceptance floor; refuse otherwise.
- **R18.6** — Delivered only after *its merge* succeeds.
- **R11.2** — delivery dial is never Off; a Gate dial demands human approval, Notify records an admission. Neither can run if the gate is never invoked.
- **R21.3** — the release evidence must demonstrate the server refusing "a merge with a selected criterion in no acceptable state."
- Charter sharpened floor — "every in-scope criterion reaches merge with valid proof or a human-recorded waiver"; the gate is "never trained around."

## 3. The policy invariant

> A merge job resolves its delivery association exactly once, at dispatch, from durable state. A merge that would publish work of a live spec execution cannot be created without that execution's provenance; only a gate-passed merge whose target is the project's delivery target marks the execution Delivered. Merges with no associated execution remain pass-through, unchanged.

## 4. Design decisions

### MA1 — Association resolves at the shared job boundary, behind a registered port

`dispatchMergeJob` and `dispatchResolveConflictsJob` consult a registered **merge-association resolver** whenever the caller supplies no explicit `executionId`. Explicit provenance (graph joins, land re-entry, retry carry-over) is authoritative and skips resolution.

- New port module `src/lib/workflows/merge/association-port.ts`, following the exact pattern of `delivery-gate-port.ts` (`provideRegisteredDeliveryGate`) and the execution-lifecycle registered callbacks: the jobs domain stays specs-free; `specs/service-factory.ts` registers the implementation at composition time; an unregistered resolver means pass-through, so tests and non-spec deployments are byte-for-byte unchanged (the "ships dark" property is preserved).
- Resolving at *dispatch* (not inside the machine) makes the association a durable fact on the job record — visible in the jobs UI, safe across process restarts, and automatically inherited by every job-record consumer (`persistTerminalState` already round-trips `executionId`; reconciliation already reads it).
- Rejected alternative: patching individual callers — the report's original objection stands; five call sites would each re-implement policy and new entry points would silently regress.

### MA2 — The resolution rule

Resolver input: `(projectPath, sessionName, targetBranch)`. Candidate set: **non-terminal spec executions whose `session_name` equals the merging session** (new repo finder `findActiveExecutionsBySessionName` on `spec-delivery-repo`; the column exists and is populated at execution creation, `execution-service.ts:1329`).

| Candidates | Outcome |
|---|---|
| none (or terminal only) | Pass-through. Log `merge.association` outcome `none`. Truly non-workflow merges are untouched. |
| exactly one, `running`, workflow linked | Stamp `executionId = workflow_execution_id`; `finalPublish` per MA3. Gate evaluates in the machine as designed. |
| exactly one, `definition_review` | **Typed dispatch refusal** (DP2 — decided 2026-07-19): the session hosts an execution that has not started; instruction names the execution and the two exits (start it, or abandon it). Rationale: `evaluateDeliveryGate` would refuse anyway ("Delivery requires a running execution"); refusing at dispatch gives the message before a merge job half-runs. |
| more than one active | **Typed dispatch refusal** (ambiguity): list the execution handles; V1 does not auto-deliver multiple executions in one merge. Matches the acceptance wording "persists provenance **when association is unambiguous**". Conjunction delivery is a recorded future extension. |

Dispatch refusals flow through the existing `JobDispatchResult` error channel — the conversation command and HTTP route already surface dispatch failures, and the structured-refusal client rendering fixed during the live round applies to them.

### MA3 — `finalPublish` means "target is the project's delivery target" *(DP1 — resolved: Option B)*

`finalPublish = (targetBranch === the branch resolveMergeTarget yields for the session)` — i.e. the mainline the session lands on. This is the decision about **where Delivered lives**:

- **Option A — session boundary (status quo stamp).** Graph `final_publish` joins into `__session__` keep `finalPublish: true`; Delivered marks when the last lane lands on the *session branch*. User merges gate pre-delivery and pass through post-delivery.
  - Pro: no change to `join-runner`'s stamp or existing graph tests; Delivered available the moment the workflow finishes.
  - Con: "Delivered" work may never reach main; R20.2/R21.2's navigable "merge result" ends at a session branch; the proof freshness chain does not cover the actual mainline candidate; `delivered-elsewhere` would satisfy later executions from work absent from main.
- **Option B — mainline boundary (decided 2026-07-19).** `final_publish` joins targeting `__session__` stamp `executionId` but `finalPublish: false` — the gate still evaluates there (early enforcement inside the workflow, where fix loops and halt UX live; design §"halt" table unchanged) but no longer marks Delivered. The delivering merge is the gated session→mainline merge (user `/merge`, HTTP, land, optimistic). The gate re-evaluates against the *actual* prepared mainline candidate with the designed freshness recheck, and `markDelivered` records the mainline merge hash.
  - Pro: Delivered unambiguously means "on main" — the natural reading of R18.6 and R21.1's "merged delivery"; the R20.2 navigation chain ends at the real merge; proof covers what actually landed (candidate-proof closure, design §testing "Candidate-proof closure", applies at the true boundary).
  - Con: after workflow completion the execution stays `running` until the human merges — Studio/Active Work copy must present "workflow complete, awaiting delivery" (already a facet the composite phase projection can carry); `join-runner.ts:200` flips one stamp and its tests.

**Option B is the decided semantics**; Option A is retained above as the considered-and-rejected alternative.

### MA4 — Egress guard *(DP3 — resolved: gate every target)*

An associated user merge is gated **regardless of target branch**; `finalPublish` is true only for the delivery target. Merging the hosting session into any other branch/session while criteria are unproven is refused by the same gate — otherwise unproven work launders through an intermediate session whose merges are unassociated, and reaches main one hop later. Escape hatches are the legitimate ones: prove, waive (human), or abandon the execution.

Alternative (looser): gate only delivery-target merges. **Rejected (decided 2026-07-19)** — it reopens the bypass the whole policy exists to close.

### MA5 — Retry and re-entry preserve provenance

- `dispatchResolveConflictsJob` gains `executionId` / `finalPublish` / `candidateValidation` params (schema + machine input already support them; the dispatch function simply never accepted them).
- The resolve-conflicts route copies all three from `priorJob` exactly as it already copies `resolutionContext` (`git/route-handlers.ts:449-460`); the MA1 resolver runs as fallback when `priorJob` predates this fix.
- Land/discard re-entry is already correct and gets a regression pin.

### MA6 — Every provisioned worktree is a lane (closes H1) *(implemented as a general engine invariant)*

Implementation found the precise mechanism: the scheduler only minted a lane for a provisioned worktree context when its lane plan had a **continuation** (`workflow-manager.ts`), so every *terminal* worktree context — single-context compiled executions included — fell into the legacy `laneId: null` path whose fan-in merge (`runFanInMerge`) bypasses the gate. The fix is the general invariant, stronger than the compiled-only assertion originally sketched here:

- **Every provisioned worktree context is assigned a lane**, terminal or not. Lane work publishes exclusively through `join-runner` (context joins + the quiescence-synthesized `final_publish` join), which carries the execution's provenance to the delivery gate.
- Consequences, pinned by the integration suite: terminal lanes publish at quiescence in deterministic sorted order (not per-completion); a failing lane publish halts as `join_failure` with the failed join recorded; a pending halt drains **before** the quiescence publish, so halted/aborted executions retain their unpublished lanes for resume/forensics; published lanes are cleaned through the lane-cleanup path on completion.
- The legacy fan-in path remains only for **resumed persisted executions** whose context states predate lanes (worktree with `laneId: null`) — migration-only per the workflows adoption matrix.
- No engine special-casing for SDD anywhere; compiled executions get the gated terminal merge for free.

### MA7 — Delivered promptness

On terminal job persistence with `executionId` + `finalPublish` + gate-passed + merged, invoke the registered execution-lifecycle `markDelivered` callback (same registered-callback family the graph runner uses, `execution-lifecycle-port.ts:80`). Read-path reconciliation (`reconcileStatus` → `getPublishedMerge`) remains the designed backstop for publish-then-crash; `markDelivered` is already idempotent by `(specExecutionId, mergeHash)`.

### MA8 — Observability and admissions seam

- One structured log event `merge.association` `{jobId, outcome: none|linked|refused_ambiguous|refused_not_started, executionId?, finalPublish?, basis}` at dispatch.
- `executionId`/`finalPublish` are already persisted job fields; extend the jobs round-trip contract fixture if any gap is found rather than adding new fields.
- Notify-dial delivery must record a gate admission and fire a notification — that wiring belongs to the attention/notification cluster (next work package), but the seam is fixed here: admissions hang off gate evaluation inside the machine, which after this design runs for every associated merge. Nothing in this addendum blocks or pre-empts that work.

## 5. Flows

**Golden delivery (Option B).** Workflow completes (lanes → session via gated `final_publish`, `finalPublish: false`). User runs `/merge`. Resolver finds one running execution for the session → stamps `executionId`, `finalPublish: true`. Machine validates the prepared candidate → `candidateValidation` fact → gate ingests evidence, issues deterministic proof from the fact (idempotent by `validationRef`), checks every pinned criterion → pass → CAS publish → terminal persistence → `markDelivered(specExecutionId, mainlineMergeHash)` → events, Studio shows Delivered with per-criterion proof.

**Refusal (R21.3 demonstration).** Same, with an unproven criterion → gate refuses → `deliveryGateFailed` terminal state with typed halt reason and instruction, **before** compare-and-swap; nothing merged; job record shows the refusal.

**Conflicts.** Merge hits conflicts → user retries → resolve-conflicts job carries the same `executionId`/`finalPublish`/`candidateValidation` → gate re-evaluates on the re-prepared candidate.

**Unrelated session.** `/merge` of a session hosting no active execution → resolver returns none → pass-through, byte-identical to today.

## 6. Module changes

| Module | Change |
|---|---|
| `src/lib/workflows/merge/association-port.ts` *(new)* | Resolver interface + register/provide, mirroring `delivery-gate-port.ts`. |
| `src/lib/specs/merge-association.ts` *(new)* | Resolver implementation (MA2 rule); pure decision function + thin repo adapter. |
| `src/lib/state-store/spec-delivery-repo.ts` | `findActiveExecutionsBySessionName(sessionName)`; extend contract round-trip test. |
| `src/lib/jobs/queue.ts` | Both dispatch functions: resolve when no explicit `executionId`; surface resolver refusals as dispatch errors; `dispatchResolveConflictsJob` gains the three params; terminal hook → registered lifecycle `markDelivered` (MA7). |
| `src/lib/git/route-handlers.ts` | Resolve-conflicts route copies provenance from `priorJob`. |
| `src/lib/workflow-graph/join-runner.ts` | DP1-B: `finalPublish` stamp only when the join target is the delivery target (false for `__session__`). |
| `src/lib/specs/service-factory.ts` | Register the resolver. |
| Spec compile path (site pinned by first red test) | MA6 lane-model assertion for compiled definitions. |
| `.kiro/steering/workflows.md` | Adoption matrix: legacy direct fan-in = migration-only; compiled definitions = lane model. |

Run `bun run seams:check` — the port keeps `jobs` → `specs` acyclic; no ceiling raises expected.

## 7. Red-green plan

Maps the report's six required coverages (†) plus the holes this design adds. Repo tests use `createPersistenceFixture()` and reload through the repository; machine tests inject fakes via `.provide()`/factory deps; no `vi.mock` of internal modules.

1. † Generic user merge persists `executionId` + `finalPublish` when exactly one running hosted execution exists — conversation command and HTTP route both land on a job record carrying them (reload from jobs repo).
2. † Unproven candidate → `deliveryGateFailed` before CAS: machine test, associated input, gate port refusing; assert no publish and typed halt reason.
3. † Passing candidate-validation fact → proof verdicts issued + Delivered transition + mainline merge hash recorded (integration through gate + `markDelivered`; idempotent on replay).
4. † Conflict retry preserves `executionId`/`finalPublish`/`candidateValidation` (route copies from priorJob; queue fallback resolves when priorJob has none).
5. † Non-workflow merge stays pass-through: no active execution → job has no `executionId`, gate port never invoked.
6. † Compiled single-context execution cannot complete through ungated fan-in: contexts resolve to lane-model targets; terminal merge is a `final_publish` join carrying `executionId`.
7. Ambiguous association (two active hosted executions) → typed dispatch refusal, no job created.
8. `definition_review` association → typed dispatch refusal naming the execution.
9. DP1-B stamp: `__session__`-target `final_publish` joins carry `executionId` with `finalPublish: false`; no `markDelivered` at session boundary; Delivered on the mainline merge (graph-runner + queue-hook pair).
10. Egress guard: associated merge to a non-delivery target is gated and never `finalPublish`.
11. Optimistic auto-merge of a hosting session resolves association (refuses when unproven).
12. Regression pin: land re-entry provenance (already green today).
13. Resolver unregistered → all dispatches pass through (ships-dark property).

## 8. Out of scope (deliberately)

- Notify-admission recording, notifications, Needs You routing (attention cluster — next package; seam fixed in MA8).
- Multi-execution conjunction delivery; auto-land after workflow completion; delivery from a non-hosting session.
- Screenshot evidence capture, `agent_validator` verdict production, assumption addressability (separate remediation clusters).

## 9. Decision points — resolved (Alex, 2026-07-19)

| # | Question | Decision |
|---|---|---|
| DP1 | Where does Delivered live: session boundary (A) or mainline (B)? | **B — mainline.** Delivered means on main; matches R18.6/R20.2/R21.1 and the live-test acceptance list. |
| DP2 | Merge of a session hosting a `definition_review` execution: refuse at dispatch, or pass through? | **Refuse at dispatch.** Conservative, self-explaining, cheap escape hatches; pass-through reopens a timing hole. |
| DP3 | Gate associated merges to *any* target, or only delivery-target merges? | **Any target.** Closes the session-laundering bypass; strictness is the point of the floor. |
