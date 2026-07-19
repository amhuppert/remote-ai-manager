# Workflow audit — Command Center-Native SDD (`1b8d9120-c62a-4102-b9ff-0cc2b39bf51a`)

> **Status at time of writing (2026-07-19):** execution **halted on circuit breaker** (`retry_exhaustion`, `failureCount: 4`) in the `final-verification` context after four consecutive context-validation FAILs (see the addendum, §Circuit breaker). 20/21 contexts complete. Cost/time figures below are from the ~06:10 UTC live snapshot and are floors; re-run `bun run workflow:audit -- --execution 1b8d9120-c62a-4102-b9ff-0cc2b39bf51a` after the execution reaches a terminal state and refresh this report.
>
> Provenance: produced by a two-agent collaboration audit (both agents ran the deterministic extractor independently; all load-bearing claims cross-verified against `workflow-logs/`, `lifecycle.jsonl`, `decisions.jsonl`, the DB event log, and extractor source). The circuit-breaker addendum was added after the breaker fired.

## Verdict

The workflow is producing a substantially stronger result than its first-pass implementations — but expensively, with too much late integration repair, and it is **not yet proven complete**. All 20 completed slice contexts eventually earned GO and every join eventually merged, at a cost of **at least $817.43 transcript-corrected implementer spend over 22+ hours wall clock** (validator dollars and one missing conversation cost are on top). Validators found real semantic defects and converged without feedback accumulation; yet the **10% first-try pass rate** and **three late production-path blockers** show that context briefs and acceptance evidence did not prove runtime reachability upstream. The worst reliability incident was a **9h37m silent codex turn**, including 2h59m of complete scheduler starvation and ~4.5 hours of critical-path delay; three halts added **2h30m14s of operator recovery wait** that the extractor reported as zero human wait.

Two top fixes, one per axis (they address different objectives — no forced global ranking):

- **Top quality/definition fix:** make terminal verification a **frozen, read-only integration audit** that emits structured findings; spin findings into separately-owned remediation contexts; rejoin; certify with a fresh, non-mutating terminal validator against a known tree SHA.
- **Top reliability/calendar fix:** a **per-turn liveness watchdog** — bounded first-output/progress deadline, active cancellation of stuck SDK turns, epoch fencing before retry.

## Scorecard

| Measure | Observed |
|---|---:|
| Execution state | halted (circuit breaker) after 4 consecutive terminal-context validation FAILs; 20/21 contexts complete |
| Elapsed wall time | >22h19m at the cost snapshot; >25h at the breaker |
| Corrected implementer cost | **≥$817.43** across 26 conversations at the snapshot (a floor — see Cost) |
| Context-validator decisions (slice contexts) | 44: 20 GO, 24 NO-GO — all via structured output, no parse fallbacks |
| First-try pass rate | **2/20 (10%)** |
| Repair iterations (completed slice contexts) | 24; none needed more than 3 iterations — `final-verification` reached 11 |
| Validator usage (unpriced) | 142.7M input (130.3M cached) / 877.6K output tokens across the 44 decisions, `costUsd` null |
| Reliability incidents | two final-publish join halts, one final-verifier SDK halt, one 9h37m hung implementer turn, one circuit breaker |
| Final merge commit (1 of 3 lane merges) | `204eb57e`: 32 files, +1,192/−87 — the delivered branch is far larger (~310 files) |

## What worked — preserve these

- **Validators caught consequential semantic defects.** The 24 slice NO-GOs were not cosmetic: wildcard locked-region bypass, historical-alias shadowing breaking durable references, cross-execution evidence spoofing, incorrect delivery-gate ownership, an API route shadowing a legal spec slug, mutable pinned scope, fabricated traceability edges, stale ticket read-through. Weakening review to save money would have shipped defects.
- **Validators exercised real judgment.** Two source-of-truth precedence conflicts resolved correctly (`transition-spine`: Requirement 18.3 over the AC shorthand; `http-routes`: design-assigned lifecycle ownership over a literal criterion) instead of mechanically failing faithful implementations.
- **The remediation loop converged without bloat.** Remediation seeds stayed small (3–8k tokens vs 10–16k initial); no `prompt_growth`, no slice circuit breakers — feedback resolved rather than compounded.
- **The integration sweep justified its existence.** Its real-service golden-path test, refusal demonstrations, and runtime wiring review exposed three release blockers after all contributing slices had GO — and recorded them as durable, dynamically-added tasks (`delivery-approval-grant`, `execution-evidence-sse`, `spec-attention-runtime-wiring`).
- **Early fan-out delivered genuine speed.** The first eight foundation/domain contexts were implemented, validated, and joined in ~69 minutes; the first five intermediate joins were clean.
- **Read-only subagent review was cost-effective.** Four parallel read-only sweeps in final verification covered broad runtime wiring for ~$1.38 and found the final remediation task.

## Friction — ranked by quality impact

### 1. Local GO did not establish runtime reachability

The three production-path omissions found by final verification were release blockers: no production delivery-approval grant path, no production publication of execution/evidence SSE events, and dead notification/Active Work composition for spec approvals and executions. Their contexts had green unit/adapter tests, but no acceptance criterion forced a real production composition to call those adapters. Remedy: every context that creates a runtime capability needs a production-composition smoke test or typed wiring deliverable, with the global integration sweep retained as defense in depth.

### 2. The terminal verifier became a mutating implementation megacontext

`final-verification` accumulated 11 iterations, 5+ conversations, ~$151+ corrected spend (≈18.5% of known implementer cost at the snapshot, still growing), and a 60+-path dirty tree. It discovered gaps, implemented fixes, repaired unrelated failures, and repeatedly ran global gates while the tree was still changing; one truncated handoff forced re-derivation; checklist truth temporarily ran ahead of runtime truth (checkboxes ticked while its own remediation findings were open). A terminal auditor should not certify its own broad repair. Parallel audit slices are useful *inside* a read-only audit design — not as parallel self-certifying editors.

### 3. First-pass precision was poor, and the misses were systematic

Only 2 of 20 completed contexts passed first try. The dominant NO-GO classes recurred *across* contexts: server-side enforcement missing (gates bypassable outside the UI), evidence not bound to its producing execution, latest-revision targeted instead of pinned/approved revision, approval carry-forward mishandled, and fixtures shaped to the implementation instead of production event shapes. These are upstream briefing/decomposition problems, not evidence for weakening review. Remedies: split broad, high-entropy contexts at stable contract boundaries; show implementers the exact validator checklist; add a **charter-level recurring-invariants checklist** covering the classes above.

### 4. A hung turn had no liveness guard

The `liveness-attention` repair turn produced no output from 10:15:02Z until Alex paused the execution at 19:51:45Z — 9h37m. From 16:52:43 (when `cli-family` finished) to the pause, `inFlight` was 1 and it was only the dead turn: **2h59m of zero productive work anywhere**. The failure surfaced only as `parallel.pending_halt_rejected_non_running` after the manual pause; once reset, the repair took **6m15s**. Because Studio depended on this lane, the hang added ~4.5h to the critical path. First-output/progress timeout, automatic abort, fresh-conversation retry, epoch fencing — a "now" item (improvement report §4.0). Root cause and landed remediation: see the RCA addendum at the end of this report.

### 5. Final publish took ~3h51m and two human interventions to cross

The `final_publish` join failed pre-merge validation twice on real cross-lane regressions (12 failing tests, then 1), succeeded on the third attempt in 4m16s. Three distinct time categories (they need different remedies): **active-but-unsuccessful validation compute** (~40m17s + ~52m32s failed attempts — the extractor's 35m/31m "stall gaps" were mostly this, not dead air), **operator recovery wait** (2h30m14s across the three halts: 1:57:52 + 0:15:48 + 0:16:34), and **scheduler starvation** (the 2h59m above — the only demonstrated dead air). Root cause: overlapping terminal-lane ownership of central spec/Studio files plus full revalidation after each merge/fix attempt at fan-in.

### 6. Terminal certification hygiene churned

From transcript deep-reads (figures per conversation): typecheck run 11× in ~2 minutes with shifting `tail`/`grep` filters; one refusal test run 7× through different output filters; the full suite started 3× with the third stale because files changed mid-run; two 10-minute background-wait timeouts. All tool errors in the deep-read conversations were agent/tooling errors, not product failures. Canonical validators should run once per frozen tree with complete retained output — never certified through lossy `tail`/`grep`.

### 7. Audit telemetry misleads in both directions

- The high-severity `rotation_overrun` findings are **arithmetically invalid as stated**: codex records carry a cumulative processed-token counter (up to 56M) with `contextWindowMax: null`, which cannot be divided by the 250K rotation limit. That does **not** demonstrate occupancy was healthy — actual codex window occupancy is *unmeasurable* with current telemetry and should be reported as inconclusive. The one measured context (Claude terminal) peaked at 305,054 tokens (31%); zero compaction events is weak corroboration, not proof.
- `decisions.jsonl` shows **47 `rotation.scheduled` but only 26 `implementer.rotation`** events — scheduled rotations were not verifiably applied; the CLI context reused one conversation across three iterations after over-limit schedules.
- The 28h+ aggregate "agent turns" figure **includes ~9h37m of the hung turn** (`scripts/workflow-audit/core.ts:997-1008` sums each `prompt_sent` to the next iteration record), and the gap classifier labels that window `agent_work`; it is not productive labor.
- Attempt history is invisible: because the run recovered, the report says "all 6 joins merged without conflicts" and 0s human waits, despite two join halts, one SDK halt, and 2h30m of recovery wait in `lifecycle.jsonl`.
- Cost gaps: all 44 validator decisions unpriced; `picker-chips` recorded $0.00 despite ~40 minutes and ~100 tool calls.

## Cost

**≥$817.43 transcript-corrected implementer spend** ($810.23 recorded) across 26 conversations at the snapshot — a floor: it excludes all 44 validator decisions (142.7M input / 877.6K output tokens, `costUsd` null), the $0.00 `picker-chips` gap, and the terminal context's continued spend through iteration 11. Do not use a speculative grossed-up total.

| Context | Corrected cost (snapshot) | Share |
|---|---:|---:|
| final verification | ~$151.24 (still growing) | 18.5% |
| CLI family | $99.21 | 12.1% |
| Studio core | $82.12 | 10.0% |
| Studio panels | $81.33 | 9.9% |
| authoring/review/entry | $60.63 | 7.4% |
| ticket read-through | $59.85 | 7.3% |
| execution/delivery | $57.19 | 7.0% |
| activation/closure | $53.59 | 6.6% |
| all other contexts | ~$172.27 | 21.1% |

Measured avoidable-spend hotspots, in order: the mutating terminal context; repeated full gates on changing trees; lossy-output reruns; repeated pre-merge validation during final fan-in; truncated-handoff re-derivation. Not all retry cost was waste — the validators bought real defect fixes.

**Re-hydration hypothesis (unpriced).** `cli-family` is a $99.21 reused codex conversation whose final remediation took ~7 minutes while cumulative processed-token telemetry kept rising sharply (31.7M → 51.6M → 56.1M across re-entries); combined with the 47-vs-26 rotation gap, this is evidence of a continuity/rotation efficiency risk. Conversation-grained accounting **cannot** assign dollars to individual iterations or prove savings from fresh threads. Instrument per-turn billing (cached/uncached input, output, billed cost, lineage, rotation-applied flag), then A/B small validator repairs between resumed and distilled-fresh conversations before treating this as a cost lever.

## Time

- **07:51–09:00Z (Jul 18):** healthy 4-wide parallel waves; eight contexts through implement→validate→join in ~69 minutes.
- **10:15–19:51Z:** the hung liveness turn; from 16:52 onward, complete starvation (2h59m).
- **23:10–03:01Z:** final publish — three attempts, two real validation failures, ~2h14m of halt-wait between them.
- **03:01Z (Jul 19) onward:** final verification — three added remediation tasks, one SDK halt, then four validation rounds ending in the circuit breaker at 09:23Z.

Aggregate agent-turn time (28h+) includes overlapping lanes and ~9h37m of hung time — not productive labor. Formal human-gate wait was zero because no gates were configured; **operator recovery wait was 2h30m14s** and should be reported as such.

## Addendum — circuit breaker analysis (`final-verification`, 09:23:38Z)

**Mechanics.** `retry_exhaustion`, `failureCount: 4`: four consecutive context-validation FAILs (06:26, 07:34, 08:31, 09:23Z), each reopening `cross-wiring-review`. Script validation (full gate) passed before every round; the failures were all from the codex context validator via structured output.

**The four rounds.**

| Round | Issues | Reopened | Headline finding |
|---|---:|---:|---|
| 1 (06:26Z) | 10 | 6 tasks | Fixture masks a missing production handoff: `ExecutionService.linkWorkflowExecution` has **no production caller**; fixture called it directly; `isAncestor` stub returned true for any two existing SHAs |
| 2 (07:34Z) | 6 | 6 | Prior fixes "materially improved" — but the fixture "approves" the compiled definition with an **empty, unauthenticated POST** (no human actor, no admission, no event) |
| 3 (08:31Z) | 3 | 2 | Execution-start still bypassable via the browser route; Notify/Off admissions write no `spec_gate_admissions` rows (Reqs 10.2/11.2) |
| 4 (09:23Z) | 2 | 1 | Notify admissions write rows but publish no gate/approval event and never notify for post-hoc review (delivery inserts directly through the repository, bypassing the service seam); `buildStatus` scopes admissions to the latest revision, hiding active-run admissions during concurrent authoring |

Diff scope grew 59 files/+4,233 → 73 files/+7,516 across the four rounds — the "verification" context was implementing substantial new product surface the whole time.

**Is the validator finding legitimate issues?** Yes. Every finding is requirement- or AC-anchored and precisely located; the validator never re-litigates closed items, credits progress each round ("otherwise satisfactorily remediated"), records "no source-of-truth conflict," and the issue counts are strictly monotone (10→6→3→2). The round-4 leftovers are real product defects, not polish: a Notify-dial admission that never notifies defeats the dial's post-hoc-review contract, and the revision-scoping bug is another instance of the run's recurring pinned-vs-latest class.

**Is it wrongly increasing scope?** No — **the task's AC is unbounded by design**, and the validator is faithfully enforcing it. `cross-wiring-review`'s instructions: *"verify every implemented surface is actually reachable on the runtime path… check honest representation… for every gap found, add a remediation task."* Under that predicate, later-round findings are in-scope by construction, and every remediation adds new production surface (endpoints, Studio controls, notification paths, admission rows) to which the same standard then applies — a structural scope ratchet. A validator faithfully enforcing an unbounded AC is a **planning defect**, not a validator defect. A fixed 4-failure breaker assumes a bounded deliverable; for an audit-and-remediate context it is effectively a cap on onion layers, and it fired on a loop that was two narrow findings from done.

**Is there an implementer↔validator alignment issue?** Yes, on one axis: **evidence legality**. The validator's consistent standard is "production-legal, human-attributed, machine-checkable evidence." The implementer twice built the cheapest bridge that made tests pass: round 1's direct fixture wiring + tautological ancestry check, and — after round 1 explicitly required going "through the real workflow-definition gate" — round 2's unauthenticated empty-POST approval. Four of round 2's six issues re-taught that one lesson (~2 of the 4 strikes). Once internalized, attempt-3/4 work was substantive (real lifecycle callbacks via `admitDefinitionApproval`, human-only grants, transactional admission rows) and convergence became genuine.

**Disposition recommendation.** Resume for one more iteration rather than accept-with-gaps: the two remaining findings are narrow and mechanical (publish the gate/approval event + post-hoc notification for `notify_policy` admissions through the events seam and route the delivery admission through the review service; resolve `buildStatus` admissions against the active execution's pinned revision). The trajectory says one round closes it. Both leftovers would ship real governance-loop defects if waived.

## Recommendations

1. **[definition] Frozen read-only terminal audit** → structured findings → separately-owned remediation contexts → rejoin → fresh non-mutating terminal certification keyed to a tree SHA. Also directly fixes the circuit-breaker failure mode: bounded remediation ACs give the breaker a bounded deliverable to count against. (Advances improvement-report §2.4/§4.5.)
2. **[planning-skill] Production-path evidence and ownership.** A composition-level test or typed wiring deliverable in every context that introduces a runtime capability; declared ownership for central files; split high-entropy contexts. (§2.7/§5.1.)
3. **[planning-skill] Charter-level recurring-invariants checklist:** server-side gate enforcement, evidence bound to its producing execution, pinned/approved-revision targeting, approval carry-forward, production-shaped fixtures.
4. **[planning-skill] State the evidence-legality standard in implementer briefs:** integration-test approvals/attributions must flow through production-legal, human-attributed paths — no fixture shortcuts through service internals. Would likely have saved a full validation round here.
5. **[engine] Turn liveness policy now:** bounded first-output/progress deadline, active cancellation, epoch fencing, fresh-conversation retry with preserved durable state. (§4.0.)
6. **[engine] Progress-aware circuit breaker:** distinguish "same finding unfixed N times" (true grinding) from "strictly shrinking, mostly-new findings each round" (converging audit) — e.g., track distinct-issue closure rate or issue-count slope alongside the failure count.
7. **[engine/config] Tree-addressed, non-lossy validation:** key results by `(tree SHA, command identity)`; retain full stdout/stderr and exit status; run the expensive full gate once on the frozen aggregate candidate; never certify from `tail`/`grep`.
8. **[engine] Instrument re-hydration, then pilot:** per-turn billing telemetry and a rotation-applied flag; A/B resumed vs distilled-fresh remediation conversations on cost, re-reads, duration, re-open rate, correctness.
9. **[engine/audit] Repair telemetry contracts:** distinguish occupancy from cumulative tokens; record scheduled-vs-applied rotation; price or explicitly mark every invocation; surface recovered halts, failed join attempts, and operator recovery wait; cap agent-turn intervals at failure/reset boundaries.
10. **[template] Tie checklist completion to accepted runtime evidence:** no checkbox ticked while its own remediation finding is open; completion reports cite the passing validator artifact/tree SHA.
11. **[process] Cross-check deep-read numbers.** Two subagent transcript deep-reads in this audit returned quantifications that failed verification against primary telemetry (a per-iteration dollar split; an errored-call count). Deep-read numeric claims must be grounded in extractor/DB/log evidence before publication.

## Addendum — RCA of the 9h37m hung codex turn (added 2026-07-19)

**What hung.** Iteration 2 of `liveness-attention` (the repair follow-up after the first validation FAIL) on codex conversation `ca9cdc0f`, thread `019f7495-be8c-…`, dispatched at 10:15:02.6Z.

**Evidence chain (all timestamps Jul 18):**

1. CC dispatched the follow-up prompt and logged `codex-runtime.turn_start` at 10:15:04.420 — no matching `turn_end` ever followed (session log).
2. The conversation transcript recorded the user prompt (10:15:02.657) and a system init entry (10:15:04.713), then **zero items for 9h37m** until the abort result at 19:51:45.909.
3. Codex's own rollout file for the thread shows the subprocess was alive and received the resume: `thread_settings_applied` (10:15:04.721) and `task_started` (10:15:04.728) — then **no further records of any kind**. The model turn never produced a first event, and codex's internal retry/timeout machinery never fired (codex-cli 0.144.1).
4. When Alex paused, the abort reached the process and it answered the interrupt within ~20 ms (`turn.failed` "Aborted: user") — the process was healthy and responsive the whole time; only the model-stream await was dead.

**Why nothing bounded it, layer by layer:**

- **Codex-internal:** the turn stalled between `task_started` and the first thread event — a phase codex 0.144.1 left unbounded (no effective idle/read timeout, no retry, no error).
- **CC conversation layer:** `CodexConversationRuntime.sendTurn` awaits the first `ThreadEvent` of a lazy `runStreamed` generator with no deadline, and the per-turn safety-net timeout resolves to **0 (disabled) for codex by default** (`codex.timeoutMs` unset → `resolveConfiguredTimeoutMs(null)` → 0). Claude turns get a 1h default (`claudeTimeoutMs`); codex turns had no bound at all.
- **Graph engine:** the implementer runner awaits the turn with no liveness policy; the scheduler counts the lane as in-flight indefinitely. A side defect made the eventual abort surface as `cause: "sdk_error"` instead of an abort: codex answers an interrupt with a graceful `turn.failed` ("Aborted: user") and a clean stream end, which the runtime classified as a provider error.

**Remediation landed (branch `csm/review-sdd-workflow-58414c`):**

- **Per-turn inactivity watchdog** (`src/lib/agent-backends/stall-watchdog.ts`): every backend event resets a stall deadline; dead air beyond it aborts the turn and closes the runtime. Wired into the conversation actor's turn path (fed by the backend event stream) and both task runners (validators). Codex declares a 20-minute default (`defaultStallTimeoutMs` descriptor metadata, ~2x the longest observed legitimate quiet gap); `codex.stallTimeoutMs` in config.json overrides, `null` disables. Claude keeps its 1h whole-turn net (background-task waits legitimately go quiet). Under this bound the incident would have cost ~20 minutes, not 9h37m.
- **Distinct classification:** a stall-aborted turn reports `abortReason: "stalled"` → `AgentTurnFailedError cause: "stall"` → halt reason `agent_turn_failed/stall`, and the codex runtime now reports signal-aborted turns as aborted rather than `sdk_error`.
- **Automatic engine recovery:** on a stall-caused turn failure the execution loop grants one automatic recovery via `recoverRetryableIterationError` — context back to ready, rotation scheduled, retry on a **fresh conversation** (the same path that recovered this incident in 6m15s after the manual pause, now with no operator in the loop). A second consecutive stall halts with the stall cause. Recovery is visible in `decisions.jsonl` as `iteration.retryable_error_detected` with `recoveryKind: "stall"`.

## Residual uncertainty

The execution is halted, not terminal: final cost, wall time, terminal verdicts, and commit state will change on resume. The cost total is a floor. This audit examined the final diff shape, workflow evidence, selected transcripts, validator findings, and integration summaries; it is not an independent line-by-line review of the full ~310-file branch. After the execution reaches a terminal state, re-run the extractor and refresh the scorecard/cost/time sections.
