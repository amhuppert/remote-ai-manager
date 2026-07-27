# RCA — graph-workflow engine plans `final_publish` while a ready lane has never started (ticket #28 / F25)

## Incident

Spec `project-conversation-parity` (spec `a84491d7`, spec execution `b3ed6004`,
graph workflow execution `1fa59425`, session "Parity between session level &
project level conversations"), verified live on 2026-07-26 against
`command-center.db`:

- 02:17:33.204 — the last implementation context (`context-lane-queue`)
  completed and lane-committed (event rows 9871–9873).
- 02:17:33.215 — `context-lane-sentinel-sweep` (task T16, covering criterion
  R1.3) transitioned `pending → ready` with `remainingTaskCount: 1` (event row
  9874).
- 02:17:33.237 — 33 ms later, the engine planned and started the
  `final_publish` join `31b0d708` with
  `sourceLaneIds: [context-lane-abort, context-lane-composer,
  context-lane-drafts, context-lane-scope-contract]` — the sweep lane absent,
  because the sweep context had never started and owned no lane (event rows
  9876–9877).
- The delivery gate refused the publish (`Delivery gate refused merge; unmet
  criteria…`), the workflow halted, and each subsequent resume repeated the
  identical cycle (04:26, 17:44, 23:22). T16 stayed `pending` with
  `startedAt: null` across all attempts.

Only the gate's evidence refusal stopped incomplete work from merging: R1.3's
`test_run` half WAS auto-satisfied by the whole-suite candidate validation, so
a fully machine-provable strategy — or a human waiver of R1.3 — would have
published a candidate that structurally excluded the sweep's work.

## Root cause

The graph shape: `context-lane-sentinel-sweep` is a **terminal** context (no
outgoing edges) fanning in from **all nine** other contexts, whose lanes never
converge to a common target on their own.

Mechanism chain, all in `src/lib/workflow-graph/`:

1. When the sweep became ready, `classifyContextSchedulability` correctly
   returned `wait-for-join` (≥2 upstream worktree lanes, no common reachable
   target). The scheduler therefore returned `scheduled: none`.
2. The loop's quiescent path (`runQuiescentJoinIfAny`) asked `planContextJoin`
   for a join candidate — and `planContextJoin` returned `null` **by design**
   for terminal downstreams (`if (!hasOutgoingEdge) return null`), per accepted
   design decision 9 of the May 2026 orchestration-optimization record
   (`.kiro/specs/parallel-execution-contexts/accepted-design-record.md`, now
   only in git history): *"Final verification runs after publish … execute
   against the post-publish session lane."*
3. With no candidate (`requiredCandidateExists === false`), the loop concluded
   the graph was quiescent and fell through to `planFinalPublishJoin`. The
   per-lane incomplete-work exclusion (`collectLanesWithIncompleteContextWork`)
   could not defend: the sweep had `laneId: null`, so no lane was excluded —
   the publish was planned around the missing work rather than blocked by it.
4. The task-based completion invariant ("refuse `completed` while any context
   has uncompleted tasks", the earlier premature-completion fix) sits **after**
   the quiescent join step, so it fires only once the publish has already run.
5. On resume, `findActiveJoin` skips `failed` joins, so each cycle planned a
   fresh `final_publish` and repeated the ordering.

The design premise broke, not the code: decision 9 predates the delivery gate
(native SDD, July 2026). The gate turned `final_publish` from a mere
lane-convergence mechanism into the **delivery certification point** (DP1-B
early enforcement — `join-runner.ts` passes `executionId` to the merge runner
only for `final_publish`). Under decision 9's ordering, a terminal
verification context can never produce its evidence before the gate that
guards the publish evaluates it — verification-after-publish became
verification-after-delivery-certification, which is a contradiction.

## Fix

Invariant implemented (ticket acceptance): **the terminal join is never
planned or claimed while any context still has unfinished tasks, including
across halt/resume cycles.** Three cooperating changes, one shared predicate:

1. **Terminal fan-ins get a `context_merge`** (`lane-join.ts`,
   `planContextJoin`): the `hasOutgoingEdge` early-return is removed. A
   terminal context's upstream lanes now converge onto a worktree target lane
   chosen by `pickJoinTarget`; the terminal context runs there **before**
   publish; `final_publish` then lands the converged lane. This supersedes
   design decision 9 and is what makes the invariant satisfiable rather than a
   deadlock — without it, refusing to publish would strand the sweep forever.
2. **`planFinalPublishJoin` refuses while unfinished task work exists**
   (`lane-join.ts`): new shared predicate `findContextsWithUnfinishedTasks`
   (`completedTaskCount < totalTaskCount` — task-based, matching the
   completion invariant, so status-lagging-but-finished contexts don't block).
   A stuck context now surfaces as the loop's `completion_blocked_incomplete`
   halt *without* first publishing partial work.
3. **Claim-time supersession across halt/resume** (`execution-loop.ts`,
   `executeJoin`): a `final_publish` join persisted as pending/running before
   a halt window is no longer claimable while unfinished task work exists —
   inside the claim transaction it is marked `failed` with an explanatory
   `errorMessage` (`stale_final_publish_superseded`), and the next pass
   re-plans from current state (context merge → run the work → fresh publish).

The completion invariant now uses the same predicate, so publish-safety and
completion-safety cannot drift.

### Why pre-publish convergence is safe now

Decision 9's rationale — verify the state that actually ships — is served
today by the delivery gate's pre-merge whole-suite candidate validation, which
validates the *actual merged candidate* at publish time for gated workflows.
For ungated workflows, pre-publish verification on the converged lane is no
weaker than every other context merge in the graph (nothing ever verified the
post-publish session merge for those either). Residual, accepted: a terminal
verifier no longer sees session-branch commits made *during* the run outside
the workflow.

## Regression coverage

- `lane-join.test.ts` — `planContextJoin` plans a `context_merge` for a
  terminal fan-in (flips the old decision-9 pin); `planFinalPublishJoin`
  returns `null` while a never-started context has unstarted tasks (the F25
  shape) and plans once all tasks are done even when a status lags.
- `execution-loop.test.ts` — the old "terminal fan-in reaches final publish
  with no context merge" pin is replaced by "converges a terminal fan-in
  through a context merge and publishes only after its work completes".
- `execution-loop-parallel.integration.test.ts` —
  - scenario 19: incident shape end-to-end; probe asserts no `final_publish`
    ever starts while any context has unfinished tasks; the sweep runs on the
    merged worktree lane; the publish lands the converged lane.
  - scenario 20: halt/resume half — a stale pending `final_publish` seeded in
    persisted state is superseded (failed, nothing merged), the sweep runs,
    and a fresh publish delivers the converged lane.

Full verification: `bun run test` (entire suite), `bun run typecheck`,
`bun run lint`, `bun run seams:check` — all green at the time of writing.

## Follow-ups (out of scope here, tracked in #24)

- Authoring-time lint for evidence kinds with no producer (F21) — the trap
  that made the gate refuse in the first place.
- Delivery-gate proof surfaces (attach-evidence / record-verdict UI, cctl
  verbs; F22–F23) and validation-evidence freshness stamping (F24).
