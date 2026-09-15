# Graph workflow implementation review

Date: 2026-09-15. Reviewed branch: `csm/graph-workflow-bug-hunt-8beaf6`.

## Summary

The review found correctness problems in routing, lifecycle ownership, document distribution, and validator input. Fixes were limited to changes that remove an exception or make an existing module own the decision. The remaining findings need a broader design change or a policy decision and are recorded below.

Severity: **P1** can corrupt execution ownership or cause work to proceed against the wrong code; **P2** causes a blocked workflow, a bypassed constraint, or materially misleading validation evidence. These are reliability findings for CC's single-operator model.

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| F1 | P1 | Delayed automatic release can archive a successor execution | Fixed |
| F2 | P2 | Skipped routers fail their own route-count constraint | Fixed |
| F3 | P2 | Session-lane contexts do not receive documents published by other lanes | Fixed |
| F4 | P2 | The first validator patch bypasses the inline size limits | Fixed |
| O1 | P1 | Historical lane joins imply visibility of later loop work | Deferred |
| O10 | P1 | Final publication can omit both lanes of a completed loop | Deferred |
| O2 | P1 | Launch completion can promote the wrong active execution | Deferred |
| O3 | P1 | Restart normalization can overwrite a resumed generation | Deferred |
| O4 | P2 | Rejected context resets still change history and stop servers | Deferred |
| O5 | P2 | Interrupted ordinary launches remain pending without a resume path | Deferred |
| O6 | P2 | Loop exits bypass routing cardinality | Deferred |
| O7 | P2 | Compatible integer/number guards are rejected | Deferred |
| O8 | P2 | Self-committed work is described as producing no file changes | Deferred |
| O9 | P2 | Failed document delivery can be reported as successful registration or ignored before dispatch | Policy decision needed |

## Fixed issues

### F1 — Automatic release archives whatever becomes active during cleanup

`lifecycle-service.ts` reads a settled execution, awaits lane-server cleanup, then archives by session. A new launch can replace the settled execution during that await. The old cleanup then archives the running successor and removes its active lease.

**Fix:** Pass the existing archive transaction guard, checking the captured execution ID and current lease eligibility. Use the archive result for the log outcome. Final admission now belongs to the existing repository seam; no lock, retry protocol, or persisted field was added.

**Evidence:** A regression using the real lifecycle service, execution repository, and SQLite fixture installs a running successor during cleanup and reloads the active record afterward. Before the fix it was `null`; afterward the successor survives. See `src/lib/workflow-graph/lifecycle-service.ts` and its adjacent test.

### F2 — A skipped router is incorrectly required to select a route

A context declaring `atLeastOne` or `exactlyOne` may itself be skipped by an upstream guard. Its outgoing routes become inactive, and the cardinality projection calls that under-selection. Runtime settlement then halts a valid conditional workflow.

**Fix:** Exclude skipped sources in the shared cardinality projection. One production condition removes this invalid case for all consumers; no runtime recovery exception was added.

**Evidence:** Four regressions cover both policies with both derived and persisted skips, asserting no halt, descendant skip propagation, and settled publication. See `src/lib/workflow-graph/route-projection.ts:514` and `route-runtime.test.ts`.

### F3 — Documents from forked lanes never reach session-lane readers

The iteration orchestrator only materialized documents for `isolation: "worktree"`, assuming the session worktree already contained them. A forked lane publishes to the central document store, not to the session filesystem. A subsequent session-lane reader therefore starts without the published document, or with its older local copy.

**Fix:** Materialize documents for every supplied execution target. This removes the isolation exception and uses the same central store for all readers. The `.cc/` namespace is git-ignored, and materialization precedes agent dispatch, so it does not require expanding the agent's write permissions. The existing rule that registered content replaces local unregistered edits now applies consistently to session targets too.

**Evidence:** The regression captures a document from a forked lane through the production store, invokes the production materializer through the orchestrator, and checks the session-target contents when its agent begins. It failed on missing contents before the fix and passed afterward. See `src/lib/workflow-graph/iteration-orchestrator.ts` and its adjacent test.

### F4 — One large first file bypasses validator patch limits

`renderDiffScopeSection` computes byte and line limits but accepts the first patch regardless of whether it fits. A single generated or large source file can therefore overflow the intended validator input budget.

**Fix:** Apply the same `fits` decision to every patch and retain the existing omitted-file disclosure. This removes an exception; no truncation mechanism or new output format is needed. These limits govern inline patches, not the total prompt or diff-stat length.

**Evidence:** Three regressions cover the hard byte ceiling, hard line ceiling, and context-window budget, and assert that omitted files remain discoverable. All failed before the fix and passed afterward. See `src/lib/workflow-graph/validation-diff-scope.test.ts`.

## Deferred findings

### O1 — Lane visibility treats historical joins as timeless

**Evidence:** `lane-readiness.ts` uses successful join reachability to decide whether an upstream context is visible in another lane. `lane-join.ts` consumes that decision when planning merges. A historical A→B join does not prove that B contains commits subsequently produced on A.

**Reproduction:** In the supported worker/judge loop, complete pass 1, merge judge→worker for pass 2, then merge worker→judge before pass 2 judge runs. After judge produces another failure and pass 3 is unrolled, the scheduler declares pass 3 worker ready because pass 2 judge is considered visible through the earlier judge→worker join. That join predates pass 2 judge's work. Loop lanes deliberately remain open between passes, so this is reachable without violating lane closure rules. The reproduction used production loop resolution, schedulability, join planning, and join progress functions.

**Impact:** A later loop pass can run against stale code and omit a required join. This undermines the code basis of subsequent implementation and validation.

**Recommended design:** Make the context membership or commit frontier captured at each fork/join the authority for visibility. Replace timeless reachability, including its transitive cases, with evidence of what was actually transferred. Pro: one factual visibility model. Con: requires coordinated changes to scheduling, joins, repeated passes, and publication.

**Alternative:** Add freshness checks to individual historical joins. Pro: narrower patch. Con: easy to get transitive visibility wrong and adds exceptions to the existing model. No partial fix was made.

### O10 — Final publication can omit a completed loop's implementation

**Evidence:** `lane-join.ts:419` builds an ever-consumed lane set from successful context joins; `449` excludes those lanes from final publication. Unlike an ordinary closed lane, a loop lane can accept more work after it was consumed by a prior join.

**Reproduction:** Complete a two-lane worker/judge loop with pass 1 failing and pass 2 passing, with a seed context and no downstream publish context. Exercise production loop materialization, join planning, and join progress. Disable validators in the fixture to rule out certification debt. All tasks are complete and the loop is concluded, but reciprocal historical joins mark both worker and judge consumed. `planFinalPublishJoin` selects only `["seed"]`, omitting both lanes containing the loop's work.

**Impact:** Successful task completion need not deliver the implementation to the session branch. This is a separate publication defect sharing the visibility-model problem in O1.

**Recommended design:** Use the captured context membership proposed in O1 to derive unpublished work at the destination, then select sources that actually carry it. Pro: scheduling and publication use one factual model. Con: requires coordinated fork, merge, and publication changes. A loop exception in the independent consumed-lane set would preserve competing authorities, so no local patch was made.

### O2 — Launch promotion is not bound to the execution it reserved

**Evidence:** `workflow-manager.ts:1446` reserves `pendingExecution`; source-locator linting awaits at approximately `1476`; the mutation at `1521` sets whichever execution is active to `running`. It does not compare the reserved ID or require the expected pending state. The approval check immediately before it reads the captured predecessor.

**Trigger:** Abort the pending launch while source linting is delayed; optionally launch another execution before linting returns. Depending on archive timing, promotion can revive the aborted record, promote a successor, or fail because no active row remains. A successor parked for approval can be promoted using the predecessor's approval decision.

**Recommended design:** Bind launch finalization and kickoff to the reserved execution and expected pending state, using the existing mutation refusal contract. A superseded launch must return a defined cancelled/superseded outcome without promoting or starting another run. Add abort-during-lint and successor-awaiting-approval regressions.

**Why deferred:** Correct refusal must carry through the launch result and lifecycle kickoff, including the approval-park branch and post-reservation artifact work. A condition on one assignment is not a complete lifecycle design. This finding is supported by code-path inspection, not a new end-to-end reproduction.

### O3 — Restart normalization is fenced only by an optional ID

**Evidence:** `workflow-manager.ts:2593` can await landing-evidence probes. The mutation at `2602` checks identity only when its caller supplied `expectedExecutionId`; it never checks the captured loop epoch. Production status and resume adapters omit the optional ID. The live-loop check occurs before the probe.

**Trigger:** Two recovery readers inspect an orphaned running execution. One finishes normalization and the operator resumes it, incrementing its loop epoch. The second returns from its probe and normalizes the now-running generation using old evidence. Replacement by another active execution is also possible when no expected ID was supplied.

**Recommended design:** Every recovery operation should use the captured execution ID and epoch at its mutation boundary, and recheck live-loop ownership there. Caller-supplied identity may narrow admission but should not determine whether internal stale-write protection exists.

**Why deferred:** The same recovery operation also repairs pending artifacts before status normalization. Establish the ownership boundary for the whole recovery operation and its callers, with blocked-probe/resume tests, rather than guarding one write while allowing stale pre-work. Code-path evidence; no new concurrency regression was committed.

### O4 — Reset refusal has already changed the execution's audit history

**Evidence:** `workflow-manager.ts:2989` marks context events pre-reset and stops lane servers before `resetExecutionContext` runs inside the mutation at `3019`. The latter rejects a running workflow or terminal context (`reset-context.ts:35`). Existing refusal tests only inspect the error.

**Trigger:** Request reset on an ineligible context. The API refuses, but old events have been relabeled and its lane servers may already have stopped.

**Recommended design:** Commit reset admission and the pre-reset history boundary in one repository transaction; capture the previous lane associations for post-commit server cleanup. Pro: refusal is side-effect free and reset events stay visible. Con: extends the focused repository mutation interface.

**Rejected shortcuts:** An early eligibility check still races with another mutation. Marking history after reset also marks the reset's own newly appended events as pre-reset. This needs an atomic boundary, not reordered awaits.

### O5 — Restart repairs pending launch artifacts without making the run resumable

**Evidence:** Ordinary launches reserve `pending` before artifact work and promotion. `normalizeAfterRestart` repairs pending artifacts but returns any non-running execution unchanged (`workflow-manager.ts:2577`). `resume` accepts paused/halted executions, not pending (`2116`).

**Trigger:** The process stops after reservation and before running promotion on a launch without an approval gate. After restart it still holds the execution lease but cannot resume. Abort and relaunch is the available recovery.

**Recommended design:** At startup recovery, convert an orphaned non-approval pending launch to paused after artifact repair. Preserve approval-gated pending runs. Pro: reuses the normal resume flow. Con: requires a reliable distinction between an orphaned reservation and a launch still progressing in this process; ordinary status reads must not pause legitimate launches.

### O6 — A loop exit's routing constraint is separated from its outgoing edges

**Evidence:** `loop-resolver.ts:888` clones body contexts into pass instances and replaces logical body contexts in the execution definition at `925`. External edges retain the logical exit as their source. `execution-routes.ts:46` exposes logical loop exits without routing policy. Cardinality iterates execution contexts and obtains policy from those same contexts (`route-projection.ts:514`). Thus the policy lives on the pass instance, while external edges belong to a logical ID excluded from cardinality.

**Reproduction:** A concluded logical exit with an effective completed pass exit declaring `exactlyOne` and two matching external guards yields two active routes and `cardinality: []` through the production projection. Zero matching routes similarly bypass `atLeastOne`. Existing loop routing tests do not declare exit cardinality.

**Recommended design:** One logical-source view should resolve both the effective execution source and its routing policy; compute cardinality over outgoing logical source groups. Pro: unifies edge and policy identity. Con: must cover unconcluded/skipped loops, edits, and browser consumers.

**Alternative:** Copy the policy into the loop projection adapter. Pro: bounded. Con: duplicates context configuration and creates another policy-resolution branch. Required tests cover under-selection, over-selection, skipped loops, and unconcluded loops.

### O7 — Numeric guard compatibility mistakes subtypes for disjoint types

**Evidence:** `edge-guard-validation.ts:447` tests type overlap using literal name equality. Runtime schema validation accepts an integer as both `integer` and `number` (`workflows/primitives/output-schema-subset.ts:133`).

**Reproduction:** A source property typed `integer` with a guard typed `number`, and the reverse pair, both report `incompatible-guard-schema`; `{ "score": 2 }` satisfies both production schemas. The compatibility checker also applies to loop terminal predicates.

**Recommended design:** Put schema-type overlap beside the schema subset owner and reuse it for guards. Pro: one owner of integer/number semantics. Con: requires a public compatibility contract and review of unions and keyword dispatch.

**Alternative/workaround:** Authors can use matching numeric type names. A local integer/number exception is a tiny code patch but adds a special case to duplicated semantics, so it was not implemented under this review's simplicity constraint.

### O8 — The validator's change summary loses self-committed work

**Evidence:** `computeValidationDiffScope` examines uncommitted changes and the candidate snapshot relative to HEAD. A clean status produces `kind: "empty"`; the renderer tells the validator that the context produced no file changes and to use stored task summaries. `lane-committer.ts` explicitly supports full-access implementers committing their own work.

**Trigger:** An implementer changes and commits a file before context validation. The working tree is clean, but the context has produced a real change. The validator input describes it as a no-change context and omits its patch. Validators can still inspect the repository; the defect is missing and misleading supplied evidence, not proof that every such change escapes review.

**Reproduction:** In a temporary Git repository under this worktree, commit a one-line implementation change, then call the production scope function and renderer. Git shows one insertion and one deletion against the pre-turn commit, while the validator scope is `empty` and its rendered text says no changes were produced. The temporary repository was removed.

**Recommended design:** Derive the context's review diff from its admitted baseline plus its owned paths, including both commits and uncommitted edits. Pro: matches the supported execution model. Con: must define the baseline across retries, shared lanes, and joins without including sibling work.

**Alternative:** Disallow implementer commits. Pro: simplifies HEAD-relative evidence. Con: removes currently supported behavior and requires a workflow policy change. No restriction was added.

### O9 — Document failures are deliberately best-effort, including contract documents

**Evidence:** `shared-documents.ts:253` catches content-capture errors without returning a warning result. `execution-tool-context.ts` commits registration before capture. `document-materialization.ts` reports missing stored documents and continues. `production.ts:513` discards that result, and `iteration-orchestrator.ts` catches materialization errors before continuing to agent dispatch.

**Trigger:** A shared-document update cannot be read/captured: registration succeeds while the central store retains old bytes. Or a registered/seeded document is absent or cannot be written into the target: the agent starts with a missing or stale local contract. Existing tests explicitly permit registration after failed capture, so this is an existing policy, not just an untested catch.

**Recommended option:** Require successful capture and materialization for documents advertised as the execution contract; return a recoverable failure before dispatch. Pro: the prompt's source of truth exists. Con: must define atomic registration/content ownership and a recovery path.

**Alternative:** Distinguish required seeded/charter documents from optional shared notes and carry warnings through the command and prompt surfaces. Pro: preserves best-effort notes. Con: adds another document policy and still needs explicit stale-content behavior.

**Disposition:** Alex's policy choice is needed before changing these semantics. No silent warning-to-halt change was made. The fixed session-target omission (F3) is independent of this policy.

## Validation and limits

All four implemented behavior fixes used a failing focused regression before production changes. An independent review of the final code and test diffs found no actionable correctness or simplicity concerns. Validation runs use registered commands with `--require-match --json` for explicit test paths.

| Area | Red run | Green run |
| --- | --- | --- |
| Archive successor race | `vrun-d79c9deb-c953-493c-b472-efc2aabc58c4` (1 failed, 13 passed) | `vrun-0224defb-154b-4dc3-a258-b52177272221` |
| Skipped router cardinality | `vrun-21013716-74b3-4cb6-bf86-b5d746b04ddc` (4 failed, 41 passed) | `vrun-0c05a929-929e-4ff2-a7fd-cc6a67e9a13e` |
| Session document delivery | `vrun-8e177d19-9bbc-4b1a-a66b-9dc4d913ef92` (1 failed, 107 passed) | `vrun-2ea91307-5d93-4858-9638-5926a9b68d13` |
| First-patch size limits | `vrun-cfde8f59-f9a0-447d-b668-a8d904884f35` (3 failed, 19 passed) | `vrun-e8de4778-3428-46c7-9c19-b3b3df14a092` |
| Related route projection suite | — | `vrun-641f10e4-5cf1-4e0f-b00e-8a4a6a5f17ee` |

Final checks passed:

| Check | Scope | Run |
| --- | --- | --- |
| Typecheck | Full project | `vrun-633321e5-170f-4c26-9543-073b057af109` |
| Lint | Changed files | `vrun-9b7b6c2c-5f3e-4288-9927-1a4163da6d2f` |
| Architecture seams | Full project | `vrun-9fc119d5-64b7-4bb1-b3ac-1eb61c37cbbd` |
| Related behavior/integration tests | Five explicit files matched | `vrun-12c2715c-bab1-4d30-b11a-240dfec9b4b8` |

The related test run covered `loop-routing.integration.test.ts`, `iteration-validation-integration.test.ts`, `document-materialization.test.ts`, `seeded-document-lifecycle.integration.test.ts`, and `execution-loop.test.ts`, all under `src/lib/workflow-graph/`. Formatting and `git diff --check` also passed. The full unit suite was not run.

Review scope included route projection/settlement, guard compatibility, dependency and lane visibility, loop joins, lifecycle recovery and mutations, shared-document storage/distribution, validator diff inputs, and selected Native SDD binding/prompt integration. Parameter substitution and expansion-budget code received a bounded inspection without another confirmed finding.

This is not an exhaustive proof of the graph engine. No live workflow, real model execution, or browser flow was run. Deferred races are labeled as code-path findings; direct production-function reproductions are identified separately. No live workflow/spec state was changed, no migration was added, and no existing approval was exercised on Alex's behalf.
