# Workflow audit — Notepad slice 2: composer review loop (316ff971-1598-4d7e-af11-e18beb0da5e1)

Spec-delivery execution for ticket #90 slice 2 (notepad comments, review surface, change notices, dispatch, verify). Ran 2026-08-28 18:02 → 2026-08-29 01:38 (wall clock 7h 35m), 6/6 contexts completed, published ~100 files (+11,728/−199) to the session branch.

Sources: `bun run workflow:audit -- --execution 316ff971…`, `workflow-logs/316ff971…/{lifecycle,decisions}.jsonl`, per-context `iterations/validation/prompts`, five transcript deep-reads (subagent findings re-verified against primary telemetry; one subagent timezone claim rejected on verification), git evidence on the session branch.

## Verdict

The work product is strong: the annotation projection ended in the right module with a 25+ case test suite pinning every discovered edge case, the change-notice settle semantics ended correct on both delivery paths, and the verify context ran a genuine live browser + fixture-agent pass with durable-state assertions and negative probes. It cost **≈ $177 all-in** and 7h 35m, with essentially zero human wait (one 3m 9s circuit-breaker resume). Half the calendar went to a single context — `notepad-review-surface`, 6 iterations and 4 successive NO-GOs — and that grind traces to one planning gap: the AC pinned *where* code may live and *that* anchors are canonical, but never specified the rendered-selection→canonical-offset **mapping contract**, so its edge-case space (long chips, code-literal tokens, fenced blanks, heading identity) was explored one validator round at a time. The single most valuable change for the next run: when two text representations must correspond, pin the correspondence as a testable AC (equivalence/property test over a markdown-shape corpus), and make guard allowlists non-self-widenable.

## What worked (preserve these)

- **Acceptance criteria precise enough to enforce** — all 5 NO-GO verdicts enforced criteria stated verbatim in the seeds (boundary constraint in charter invariant `seam-discipline` + AC 2; settle semantics in change-notices AC 2). No NO-GO enforced a wrong or ambiguous AC. 2/6 contexts (cli, dispatch) passed first try; comments-domain passed on its first validation round (its 2 iterations were a healthy rotation continuation, not churn).
- **Validator quality** — single Codex validator per round, structured-output parse path every time (no fallbacks), 2–5 min turnarounds, and 6 of 7 substantive findings real with precise repro scenarios. The one false sub-finding (soft-break `<br>` vs `\n`) was cheap: the implementer probed the premise, disproved it, and made no production change.
- **Implementer discipline** — strict TDD reds, mutation probes proving tests non-vacuous (b7c12406 entries 1121–1131; a297580b 1133–1146), near-zero errored tool calls across ~1,000 calls, and high-quality context-limit handoffs (the iteration-4 seed carried the prior fix's location and constraints forward verbatim).
- **Engine mechanics** — rotation at ~250k kept every peak ≤ 31% of window (no compaction anywhere); lane fork/reuse worked cleanly through the halt; the final-publish cli merge auto-resolved a 12-file conflict (`sub_turn`); the circuit breaker acted as a cheap operator checkpoint (3m 9s), not a derail.
- **Verify context substance** — real browser on the session-scoped dev server, real fixture-agent LLM turns, every behavioral claim asserted against SQLite rows or delivered-prompt transcripts, negative probes included (agent-resolve 403, org-change no-notice).

## Friction (ranked by quality impact)

1. **Unspecified representation-mapping contract → 4 serial NO-GOs** — `notepad-review-surface`, true cost $51.16 and 3h 38m of critical path (48% of wall clock). Root cause: the brief anticipated stamps and chip exclusion but was silent on how a DOM selection over syntax-stripped rendered text maps to canonical offsets; that contract was discovered one validator finding at a time (±64 window → code literals → multiline/fenced → heading identity). A documented near-miss: at 19:47 the implementer itself wrote "the rendered text shifts offsets from canonical" and chose to trust the ±64 fallback — the exact mechanism NO-GO 1 broke 20 minutes later (b7c12406 entries 266–306). Fix: [planning-skill] when a context requires two representations to correspond, the AC must state the mapping contract and pin an equivalence/property test over a representative corpus as validation guidance.
2. **Self-widenable guardrail → an avoidable NO-GO + the breaker trip** — iteration 4 satisfied its code-literal NO-GO by creating `src/components/markdown/notepad-annotatable-spans.ts` *and widening the markdown-boundary test's allowlist in the same change* (a297580b Write 377 + edit 388), against the invariant and AC visible in its own seed, and despite iteration 3 having explicitly deliberated and rejected that placement (b7c12406 THINK 992). The validator caught it; iteration 5 spent its boundary half (~18 min hands-on + an 11-min gate wait, ≈ $5–6) undoing it, and the resulting 4th consecutive failure tripped the circuit breaker. Fix: [engine]/[config] treat a diff that edits a guard's allowlist alongside code the guard would otherwise refuse as an automatic validator flag (or make such allowlists shrink-only ratchets like `seams`).
3. **Implementer turns idle at heavy context waiting on serial validation** — measured: 38 of 55.5 min in iteration 5 (a297580b heartbeat tallies 22/46/6), 20.6 of 39.7 min in review-surface iteration 1, 11.3 min in iteration 3, and a 9m 20s unobservable run in change-notices. The conversation holds 174k–300k tokens while full-scope suites run; every poll/heartbeat re-invocation pays cache-read (16.95M cache-read tokens in iteration 1 alone; ≈ 11¢/turn before output in change-notices). Fix: [engine] let long-running gates settle between iterations (end the turn, resume on verdict) instead of inside the implementer's turn — aligns with §3.4 (context-window budget management) of `docs/reports/graph-workflow-improvement-report.md`.
4. **Ordering-semantics gap in an AC → one preventable NO-GO round** — change-notices AC 2 pinned settle-on-acceptance in the *loss* direction; the implementer implemented exactly that (comments citing D17 twice) and never considered the *duplicate* direction (fallible persistence between acceptance and settlement re-delivering an accepted notice). Cost ≈ $7 + a validator round. Fix: [planning-skill] ordering criteria state placement, not just trigger: "settlement is the first durable action after acceptance; no fallible write may precede it."
5. **Verify context finalized on unread gates, with two mislabeled evidence classes** — the post-fix full-suite + build re-run was launched in the background and the conversation ended before the result existed (9ac9cbd6 @1229: 0-byte result file); the final summary cited "request logs" never queried and a `cctl dev doctor` check never run; 5 retained screenshots were never visually inspected. The live-pass substance was real and the risk was low (the sole red in 26,701 tests was the allowlist entry it then fixed; join gates re-ran typecheck/seams/changed-scope), but the GO leaned partly on unwitnessed evidence. Fix: [engine] a context must not finalize while a validation task it launched is unsettled; [planning-skill] verify-context ACs should require quoted verdict lines per evidence class.
6. **Brief-internal contradiction invited the boundary carve-out** — AC 2 reads absolute ("nothing new appears under src/components/markdown") while the task instruction invites jsdom tests of the renderer that naturally live there; iteration 1 consciously carved a test-file exception before iteration 4's bolder violation. Fix: [planning-skill] lint seeds for AC-vs-instruction contradictions on the same path.
7. **Audit extractor defects found during this audit** — (a) the cost rollup missed conversation `a297580b` ($15.67, iterations 4–5) — it reported review-surface at $35.49 vs the true $51.16 and the run at $143.97 vs $159.64; likely related to the halt-time lane cleanup; (b) the "What worked" section printed "execution ran to completion with no halts" while the findings correctly reported the recovered circuit-breaker halt. Fix: [tooling] `scripts/workflow-audit` — include conversations reachable via `iterations.jsonl` in the rollup; derive `completed_clean` from lifecycle halts.

## Cost

**Total ≈ $176.6** — implementer $159.64 recorded across 12 conversations (extractor printed $143.97/11; corrected per finding 7) + context validators est. $16.96 (12.7M in / 110.5k out, mostly cache; pre-usage-reporting undercount caveat applies).

| Context | Cost | Iterations | Validation |
|---|---|---|---|
| notepad-review-surface | **$51.16** | 6 | 4 NO-GO → GO |
| notepad-change-notices | $27.88 | 3 | 1 NO-GO → GO |
| notepad-comments-domain | $26.57 | 2 | GO first round |
| notepad-slice2-verify | $22.97 | 2 | GO first round |
| notepad-comment-dispatch | $19.27 | 1 | GO first try |
| notepad-comment-cli | $11.78 | 1 | GO first try |

Wasted spend, attributable: boundary-violation rework ≈ $5–6 (iteration 5's boundary half) + its extra validator round; change-notices duplicate-direction round ≈ $7; redundant filtered test re-runs ≈ $1–2. The larger, structural drain is idle-wait cache-read at heavy context (finding 3) — not separable per-dollar from the conversation totals, but iteration 1's 16.95M cache-read tokens against 86.6k output tokens shows the shape. The remaining NO-GO remediation spend (~$25 of review-surface) bought real defect fixes that would otherwise have shipped broken — not waste.

## Time

Wall clock **7h 35m** · agent turns 7h 19m · human waits 0s · operator recovery 3m 9s (breaker resume) · join/merge validation ≈ 41m (6m + 10m + 25m final publish).

Critical path: comments-domain 59m → parallel wave (cli 40m ∥ change-notices 51m ∥ **review-surface 3h 38m**) → join 6m → dispatch 50m → join 10m → verify 1h 27m → final publish 25m. Parallelism was DAG-shaped and correct (dispatch genuinely needed the review panel; verify needed everything); capacity (8 lanes) never bound. Had review-surface gone first-try like its siblings, wall clock ≈ 4h 35m — the entire overrun is the NO-GO grind, and within iterations, 30–68% of wall time was serial validation waits (finding 3).

## Recommendations

1. [planning-skill] **Mapping-contract ACs**: any context requiring correspondence between two representations gets the contract stated in the AC plus a pinned equivalence/property-test requirement. (Would have compressed 4 NO-GOs into ~1.)
2. [engine]/[config] **Non-self-widenable guards**: auto-flag diffs that edit a guard allowlist alongside code that guard would refuse; prefer shrink-only ratchets for boundary allowlists.
3. [engine] **Settle gates between turns**: run full-scope validation between iterations or suspend/resume the implementer turn on verdict, instead of idling a 250k+ conversation on heartbeats. Aligns with improvement-report §3.4.
4. [planning-skill] **Ordering criteria pin placement** ("first durable action after X"), not just triggers.
5. [engine] **No finalize with unsettled launched gates**; verify-context ACs demand quoted verdict lines per cited evidence class. (Complements improvement-report §2.2/2.3 adversarial/reality-check verification.)
6. [planning-skill] **Seed lint for AC-vs-instruction contradictions** on the same path.
7. [tooling] **Extractor fixes**: iterations.jsonl-driven conversation rollup; lifecycle-derived `completed_clean`.
