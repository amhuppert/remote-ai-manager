# Workflow audit — Auto name conversations (`1beec403-eb2e-425d-bf68-60b675efb6dd`)

Definition `1cdc15c2` rev 10 · 7 contexts / 21 tasks · ran 2026-08-04 18:03:47 → 21:56:24 UTC
(wall clock 3h 52m) · completed clean, zero halts, zero human waits · final publish `a4e79157`
(97 files, +3389/−17, no scratch debris).

## Verdict

The produced work is solid: all 7 contexts completed, every NO-GO enforced a real defect, and
the validator caught one genuine production bug (stale active cache on session rename) that the
implementer had explicitly rationalized away. True cost is **≈ $69 implementer + ≈ $26 validator
(~$95 all-in)** — the recorded $93.08 implementer figure is inflated by a codex cost-accrual bug
(client-ui's $26.52 row is really ~$5.36 + unpriced merge sub-turns). The single change that
would most improve the next run is **join observability + join cost**: 52 minutes (22% of wall
clock) sat inside joins with zero telemetry, running serialized per-lane pre-merge validation
plus two invisible LLM conflict-resolution sub-turns that the extractor then mislabeled as
"merged without conflicts."

## What worked (preserve these)

- **Line-number-precise seed prompts → first-try GO on the hardest context.** The
  name-origin-persistence seed named exact files, line anchors, and a pre-empted fixture-harness
  trap; the agent "executed a spec, not a design": red-first TDD on all 3 tasks (transcript
  entries 190/203, 519, 612), a 49-site fixture migration done in one scripted 64-second batch
  pass, and two full-suite verifications — GO in one iteration.
- **Validators earned their keep, twice over.** The final-verification NO-GO 1 refuted the
  implementer's provenance argument ("listener is byte-identical to pre-workflow commit") with a
  concrete fire-and-forget timing race — a real user-visible bug (placeholder name stuck in
  sidebar/tabs) fixed with disciplined red-green in iteration 2. The naming-config validator
  *resolved* an ambiguous AC wording ("rejects the key") via the binding design instead of
  enforcing it literally — the AeroTrainer failure mode did not occur in any of the 4 NO-GOs.
- **TDD compliance was real, not self-reported.** Red runs before production edits verified in
  persistence (×3), client-ui, naming-config, and final-verification iteration 2.
- **Deterministic gates genuinely ran.** Full suite 2,590 files / 35,674 tests with `--bail=0`
  and file-count verification (final-verification entries 557–558), pre-merge script exit 0
  three times, typecheck/lint/seams clean each iteration.
- **Cross-session memory paid off.** The persistence agent reused the `.cc/temp` bun-patch-script
  technique and instantly diagnosed the known forkConversation flake instead of debugging it.
- **Smart-merge resolved a real conflict correctly.** The `schemas.ts` both-sides-added conflict
  was merged as complementary (request + shared response schema kept) with a clean rationale.
- **Background pipelining.** naming-config overlapped a 4m19s typecheck with continued
  implementation work.

## Friction (ranked by quality impact)

1. **No live verification anywhere in the plan — and the deferral chain dead-ends.** client-ui's
   GO deferred "live reachability" to final-verification, but final-verification's ACs only
   require static code tracing (file:line citations) plus the deterministic gate; its transcript
   has zero playwright/browser/`cctl dev` calls. The feature shipped never having named a real
   conversation end-to-end. Root cause: planning allowed a "deferred to X" claim where X's ACs
   don't contain the deferred obligation. Fix: [planning-skill] when a validator records
   "deferred to context X," X must carry a matching AC — otherwise the deferral is invalid.
2. **Charter type-escape invariant violated in new test code, twice → 2 of 4 NO-GOs.**
   naming-config copied `querySelector(...)!` / `as HTMLButtonElement` character-for-character
   from CompactionSection.test.tsx — which the task instructions said to mirror and which itself
   violates the invariant. final-verification wrote `as object` / `as unknown as` with the
   invariant verbatim in its seed, then fixed it using an existing `SseEventTarget` port whose
   docstring exists to prevent exactly that cast. Combined cost ≈ 35–40 min wall + ~$6 + two
   validator cycles. Fix: [template/definition] mandatory pre-completion grep of new/changed
   test code for `as unknown|as object|!\.|@ts-ignore` (the exact one-call check the
   final-verification agent ran only after being told); [planning-skill] "mirror file X" tasks
   must flag when X violates a charter invariant — faithful implementers copy precedent.
   (Aligns with improvement-report §1.6 shared rubric.)
3. **52 minutes of join time is telemetry-invisible and partly avoidable.** All three
   "unexplained" stall gaps are exactly the join windows (16m57s + 26m46s + 8m15s). Inside:
   serialized per-source-lane merges each followed by a pre-merge validation run (~8–9 min:
   scoped prettier/eslint/vitest + full tsc), and — in join 2's 19m30s client-ui merge — two LLM
   sub-turns (19:45 conflict resolution, 19:54 post-merge test fix) recorded nowhere in the join
   events. Fix: [engine] emit join sub-step events (per-lane merge start/end, pre-merge
   validation start/end, conflict sub-turn invoked) and have the extractor classify join windows
   as `join_compute`; [engine/config] consider one validation per join after all source lanes
   merge instead of per lane (~17 min saved here) — trade-off: per-lane runs isolate which lane
   broke the build.
4. **Codex cost accrual sums cumulative snapshots → recorded costs inflated up to ~4×.** Proof:
   regenerate-api's DB row $7.2597 = 3.186902 + 4.072798, the two *cumulative* per-thread
   `costUsd` result values exactly (contextTokens monotone 4.03M → 5.47M confirms cumulative
   semantics). Corrected: client-ui $5.36 (DB: $26.52, which also absorbed the unpriced join
   sub-turns), regenerate-api $4.07 (DB: $7.26). The extractor's transcript correction handles
   claude lineages but passes codex through unflagged. Fix: [engine] accrue codex cost as
   latest-cumulative-per-thread; [engine] extend `summarizeTranscriptTelemetry` +
   `cost_mismatch` detection to codex `raw.costUsd`.
5. **"clean_merges" positive is false.** The join-2 client-ui merge had a real `schemas.ts`
   conflict auto-resolved by a smart-merge sub-turn; the join event's `conflicts` field stayed
   null so the extractor reported "all 3 joins merged without conflicts." Fix: [engine] record
   sub-turn-resolved conflicts on the join event; the detector should distinguish
   "no conflicts" from "conflicts auto-resolved."
6. **Shared API schema assigned to one of two parallel siblings → NO-GO + merge conflict +
   post-merge test fix.** The binding design put `generateConversationNameResponseSchema`'s
   canonical home (schemas.ts) under regenerate-api (batch 3) while client-ui (batch 1) needed
   it; the client-ui agent found it absent, silently wrote a local copy, took a NO-GO, authored
   it canonically in remediation — and the predicted both-sides-add conflict then materialized at
   join 2. Fix: [planning-skill] cross-context contract schemas belong in a predecessor context
   both consumers depend on (aligns with improvement-report §1.3 contract artifacts / interface
   freeze).
7. **Background-wait mechanics burned prompt cycles.** final-verification's 741s suite was
   auto-backgrounded; the agent ended its turn twice expecting completion re-invocation and
   instead consumed both "incomplete task" follow-ups (cycle 2 was 28s of pure polling);
   naming-config's remediation similarly ended without task-complete and needed a nudge. Fix:
   [engine] re-invoke the implementer on background-task completion, or tell it in the prompt
   that turn-ending won't be triggered by background completion.
8. **Verification-mechanics waste in naming-config: ~10 min (31% of its iteration 1).** Lint #1's
   `| tail -6` piped the exit code away, so the agent re-ran the 7-minute lint *twice* in a
   compound command, hit the 600s background timeout, killed it, and declared "all verification
   green" without the confirmation it sought. Fix: [template/definition] prompt guidance — never
   pipe a gate's verdict away; `bun run lint; echo EXIT=$?`.
9. **Known forkConversation flake taxed the run twice** (isolation rerun + ~3 redundant re-runs,
   ~5 min in persistence). Fix: [config] fix the flake or give workflows a known-flake allowlist.
10. **Next-field-like-this costs 49 edits.** The schema `.default()` did not prevent the fixture
    break (z.infer output type still requires the field). Fix: [config] shared conversation
    fixture factory so the next `ConversationState` field costs one edit.

## Cost

Recorded: **$93.08** implementer (7 conversations) + **est. $25.98** validator
(24.9M tokens in / 22.9M cached / 147.3k out — codex task-runner path, no conversation rows).

Corrected implementer spend (codex = final cumulative `costUsd` per thread):

| Context | Recorded | Corrected | Notes |
|---|---|---|---|
| name-origin-persistence (claude) | $17.81 | $17.81 | ~25% waste: 5.5m cold typecheck + flake re-runs |
| final-verification (claude) | $21.17 | $21.17 | iteration 3 (~1/3 of spend) fully avoidable |
| naming-config (claude) | $11.20 | $11.20 | ~$3.11 = NO-GO remediation; 10m double-lint |
| client-ui (codex) | $26.52 | ~$5.36 + sub-turns | DB summed cumulative snapshots + unpriced join sub-turns |
| regenerate-api (codex) | $7.26 | $4.07 | exact sum-of-cumulatives proof |
| naming-service (codex) | $5.62 | $5.62 | single result — unaffected |
| auto-trigger-wiring (codex) | $3.49 | $3.49 | single result — unaffected |
| **Total** | **$93.08** | **≈ $68.7** | + unpriced merge sub-turns (bounded by client-ui's $16.8 accrual residue) |

All-in ≈ **$95 (floor)** — validator line undercounts pre-usage-reporting events, and the two
join sub-turns have no per-turn price. Identified waste ≈ $10–14: final-verification iteration 3
(~$6–7 incl. validator cycle), naming-config NO-GO + double lint (~$4), client-ui NO-GO cycle
(~$1–2), persistence flake/cold-start minutes.

## Time

Wall clock **3h 52m** · agent turns **2h 49m** · human waits **0** · joins **~52m (22%)** —
previously reported as "unexplained" gaps.

Critical path (nearly serial after batch 1): persistence 42m ∥ (config 34m, client-ui 17m) →
join 17m → naming-service 20m → (api 12m ∥ trigger 8m) → join 27m → **final-verification 1h46m
(45% of wall)** → publish 8m. The three-iteration final-verification is the dominant term: its
iteration 3 (~30m) was avoidable (friction #2), and ~17m of join time was serialized re-validation
(friction #3). Realistic floor for this same plan with those fixes: ~3h05m.

## Recommendations

1. [engine] Fix codex cost accrual (latest-cumulative-per-thread) and extend transcript cost
   correction + `cost_mismatch` to codex threads. (Friction 4)
2. [engine] Join sub-step telemetry: per-lane merge and pre-merge-validation events, sub-turn
   conflict records; extractor `join_compute` gap class; fix the `clean_merges` detector.
   (Frictions 3, 5)
3. [engine/config] Evaluate single post-merge validation per join vs per-lane; or scope
   intermediate-merge validation and keep the full gate for final publish. (Friction 3)
4. [planning-skill] Deferral integrity rule: "deferred to context X" is only valid if X carries
   the matching AC — and live end-to-end verification needs an owner (a live-test task in
   final-verification, per `cc-live-feature-test`). (Friction 1)
5. [planning-skill] Contract schemas used by parallel siblings go in a predecessor context
   (improvement-report §1.3). (Friction 6)
6. [template/definition] Pre-completion type-escape grep on new/changed test code; warn when a
   "mirror X" exemplar violates the charter (improvement-report §1.6). (Friction 2)
7. [engine] Re-invoke implementers on background-task completion instead of burning follow-up
   nudges. (Friction 7)
8. [config] Kill the forkConversation flake; add a shared conversation fixture factory.
   (Frictions 9, 10)

## Telemetry confidence

- Codex occupancy unmeasurable (cumulative counters, no window max) — occupancy conclusions for
  client-ui / naming-service / regenerate-api / auto-trigger-wiring are inconclusive.
- Validator cost is an estimate from `reviewArtifact.usage`; events pre-dating usage reporting
  may undercount.
- Join sub-turn spend is unrecorded at per-turn granularity; the corrected total is a floor.
- Corrected codex costs assume `costUsd` is cumulative per thread — proven exactly for
  regenerate-api (sum identity) and consistent with per-token deltas for client-ui; not
  independently priceable from token counts (no cached/uncached split in codex results).

## Primary sources

- Extractor: `bun run workflow:audit -- --execution 1beec403-eb2e-425d-bf68-60b675efb6dd`
- Logs: `~/Library/Application Support/cc/workflow-logs/1beec403-…/` (lifecycle.jsonl for the
  join timeline; decisions.jsonl for rotation/engine choices)
- Transcripts: `d1e86e9e` (persistence), `c4d2c87a` (client-ui, incl. join sub-turns at entries
  133–134), `d4469a7b` (final-verification), `d766bb15` (naming-config) under
  `~/Library/Application Support/cc/transcripts/`
- DB: `graph_workflow_events` join-status rows; `conversations.total_cost_usd` rows
- Final publish: `git show a4e79157`
