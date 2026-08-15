# Workflow audit — Ephemeral workflows delivery (beb0da38-b499-410f-889a-e954ccc7bbc9), mid-flight

Audited 2026-08-14 while the execution is still running (3/12 contexts complete, `execution-addressed-lifecycle-acts` at iteration 9). Requested question: the validation-failure ratio is far above normal and three plan-repair rounds each concluded "no planning defect" — is there a deficiency anyway, and does it trace to the native SDD spec or the constraints of the native SDD feature?

## Verdict

Yes, there is a deficiency, and plan-repair was structurally unable to see it. The spec (rev 5) is not the problem — its criteria are scenario-scoped and testable — and the validators' individual NO-GOs were overwhelmingly *correct*. The churn comes from the pipeline between them:

1. **The compiled validator packs discard the plan's own cross-context ownership declarations** (native SDD materializer defect). The plan assigned signed-principal work to `verified-workflow-principals` and ambient lease projections to `lease-aware-consumers` in its machine-readable `wiring` table — but `contextPack` renders only the wiring *owned by the context being compiled*, and the validator rule honors a deferral only when "an acceptance-criteria clause names the downstream context." So validators were required to fail early contexts for work the plan had explicitly scheduled later.
2. **Globally-quantified charter invariants over a legacy codebase, with no inventory task.** Invariants like `one-canonical-lease` ("Every admission … ambient signal … delivery gate consumes holdsExecutionLease") and `serialized-state-and-publication-seams` bind every context via the "check every charter invariant" pack rule. Enforcing an end-state invariant mid-migration, with sites discovered one review round at a time, produces whack-a-mole convergence by construction.
3. **Breaker below natural convergence length.** The instance default `consecutiveFailureThreshold: 4` (config `workflowDefaults`; the plan dialect exposes no override) sits below the 5–7 rounds these invariant-sweep contexts actually need, so the breaker fires on *converging* loops — which is exactly why all three plan-repair rounds honestly answered "criteria coherent, convergence steady, not a planning defect" and declined. Plan-repair evaluates AC coherence, not cross-context scope routing or convergence cost, so the real defect was outside its lens. A decline also never auto-resumes, so each trip cost an operator wait (18m + 7m + 20m).

The work product itself is trending *better* than a low-failure run would have produced: the validator caught real concurrency defects every round (CAS outside the transaction, warmed-cache stale read admitting two winners, read-repair mutating on a refused launch, approval-saga ordering) and one genuine pinned-spec conflict it resolved correctly by source precedence.

## Trace: spec → plan → compiled pack → NO-GO

The clearest instance is `inline-one-off-launch` (4 NO-GOs, breaker trip #2):

- Spec D11 (`ephw-d-verified-identity-capability`) defines the signed conversation capability; criteria `ephw-c-principal-unforgeable` etc. are bound by the plan to the **later** `verified-workflow-principals` context.
- Plan attempt `9eb29cc9` wiring row: `server-verified-workflow-principal … call site → verified-workflow-principals @ execution/runtime-edit route principal guard at every mutation dispatch`.
- `materializeDeliveryPlan` → `contextPack` (`src/lib/specs/delivery-plan-materializer.ts:608`, `wiringBelongsToContext`) filters wiring to the current context, so the inline context's pack shows only its own rows under "Production wiring owned here."
- The pack's validator rules say: *"The only exemption is explicit deferral: an acceptance-criteria clause naming the downstream context that owns the wiring. … with no named owner, raise an issue"* and *"Check every charter invariant."* The charter carries the global `server-verified-principal` invariant.
- Validator round 2 (verbatim): "no owned acceptance-criteria clause names verified-workflow-principals as a downstream wiring owner" → NO-GO. Rounds 3–4 then forced the capability signing key, minting allowlist, and verifier to be built inside this context — two contexts ahead of plan — with the breaker firing after round 4.

The same mechanism drove `lease-admission-normalization` rounds 1–2 (validator demanded `sessions-repo.ts` ambient projection, `GATE_STANDING_EXECUTION_STATUSES`, the STATUS endpoint, and `evaluateGraphWorkflowSessionDelivery` be rewired — all inside the `lease-aware-session-consumers` wiring row owned by the pending `lease-aware-consumers` context) and `execution-addressed-lifecycle-acts` round 1 ("Abandon does not enforce agent mutation authority" — again `verified-workflow-principals` scope). Where the acceptance contract *did* carve out a surface (the CLI leaf), validators respected it every round — confirming the mechanism, not validator temperament, is the variable.

The second driver is visible in `lease-admission-normalization` rounds 3–6: the `serialized-state-and-publication-seams` invariant was closed one site per round (`timed()` logging → `sessions.findByKey` in the write queue → repository validation `logger.error`), and `reserve-before-side-effects` likewise (advisory `getActive` read-repair found at three adjacent call sites across rounds). No plan task enumerated the sites up front; review discovers incrementally.

## What worked (preserve these)

- **Scoped, testable acceptance contracts converge fast**: `execution-persistence-foundation` (schema/round-trip/migration work) went 1 NO-GO → GO in 3 iterations.
- **Validation quality was high**: verdicts consistently identified real, production-reachable races and test-adequacy gaps ("your two-connection test can't exercise the warmed-cache race" was correct and led to a materially stronger regression). Four of the round-4 lease findings were independently verified in the lane worktree during the first halt review.
- **Source-precedence machinery worked**: the null-haltReason lease conflict was resolved against the pinned rev-5 spec exactly as the hierarchy intends.
- **Honest deferral records**: the implementer recorded deferrals with named downstream contexts in completion summaries; advisories tracked them once validators accepted the boundary.
- Low context pressure overall (peaks ≤ 45% of window); merges succeeded on all three completed contexts.

## Friction (ranked by impact)

1. **Sibling wiring ownership invisible to validators** — evidence above — root cause `contextPack` filtering + AC-clause-only deferral rule — fix: [engine/native-sdd] render the full ownership map (or overlapping sibling rows) into every pack, or compile downstream-owner carve-outs into acceptance contracts automatically.
2. **Global charter invariants with no staging/scoping** — the plan-edit schema allows only `{id, statement}`; nothing can say "holds after context X" — fix: [native-sdd] scoped invariants, or [planning-skill] author invariants with explicit per-context applicability language and carve-outs in every acceptance contract they touch.
3. **No inventory task for invariant migrations** — whack-a-mole rounds 3–6 — fix: [planning-skill] a migration-shaped invariant gets a "enumerate all sites mechanically first" task or a runtime guard (e.g., assert-no-logging-inside-write-queue test) so round 1 is complete.
4. **Breaker (4) below convergence length (5–7); repair-decline never resumes** — 3 halts, 45m 27s operator wait, 3 repair invocations for zero operations — fix: [config] raise `workflowDefaults.circuitBreaker` for invariant-heavy plans; [engine] let a declining plan-repair that explicitly recommends resumption auto-resume, or expose the threshold in the plan dialect.
5. **Rank-2 source `.cc/session-alignment/charter.md` absent from every validation** — flagged in all 19 verdicts; it is a session-scoped document lanes never materialize; plan lint (0 findings) didn't catch the unresolvable locator — fix: [engine] materialize session charters into lane worktrees, plus [native-sdd lint] verify every `sourcesOfTruth` locator resolves under lane `accessPolicy`.
6. **Reliability noise, not churn-related**: three hung turns (~1h10m each, excluded from agent time) and one `rotation_overrun` (452,834 tokens = 1.8× the 250k rotation limit in inline iteration 1).

## Cost

$78.29 implementer (transcript-corrected; recorded $76.12) across 6 conversations, plus est. $51.39 context-validator usage (52.3M in / 48.2M cached / 224.6k out) — validators are ~40% of spend, the price of 19 review rounds where ~8–10 would have sufficed with correct scope routing. Largest conversations: execution-addressed `7cfda189` $20.97, inline `e4a777b9` $16.33, lease `ffc30a54` $15.24.

## Time

Started 2026-08-13T03:48Z, still running at audit time (~24h). Agent turns 12h 59m; hung turns 3h 39m (excluded); operator halt-recovery 45m 27s; the 3h 52m "unexplained" gap in the extractor is the answered ask-user pause (user_input.waiting → wait_exit). Iterations vs tasks: 12 iterations for 4 tasks (lease), 6 for 4 (inline), 9+ for 3 (lifecycle-acts) — vs 3 for 3 on the healthy persistence context.

## Implications for the rest of this run

The two contexts that own the contested surfaces (`verified-workflow-principals`, `lease-aware-consumers`) are still pending and much of their scope was force-built early — expect them to be validate-and-tighten rather than build, and cheap. The remaining invariant-heavy contexts (`durable-boundary-projection`, `origin-result-attachment`) own their invariants' surfaces outright, so the cross-context mechanism should not recur; residual risk is the whack-a-mole class and one more breaker trip on `execution-addressed-lifecycle-acts` (post-resume NO-GO count is 1 of 4).

## Numbers ledger

19 validation verdicts so far: 16 NO-GO / 3 GO (persistence 1/1, lease 6/1, inline 4/1, lifecycle-acts 5/0 pending). 3 circuit-breaker halts, 3 plan-repair rounds (`declined`, `planningDefect: false`, 0 operations each). All figures from `bun run workflow:audit -- --execution beb0da38…`, the execution's `workingDefinition`/charter, plan attempt `9eb29cc9` (`cctl spec plan get ephemeral-workflows --json`), the compiled validator pack `workflow-logs/…/contexts/inline-one-off-launch/validators/general/context-validator.md`, and the live instance `config.json`.
