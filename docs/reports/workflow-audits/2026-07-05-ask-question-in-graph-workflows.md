# Workflow audit — Ask Question Tool in Graph Workflows (`7b35d37a-b065-44c8-a50c-f7f9ac723ffd`)

Session `Ask Question Tool in Graph Workflows` · definition `0ebeb5d3` rev 2 (global tier) ·
ran 2026-07-03 18:46Z → 2026-07-04 03:57Z · 2/2 contexts completed · merged to main as `8b3bb325`.

## Verdict

High-quality outcome at a defensible price. The workflow implemented the full `ask-question-in-graph-workflows`
spec (113 files, +11.5k lines) overnight with **zero human intervention**, and its live-verification tasks did
exactly what they were designed to do: they surfaced **four real integration bugs that the entire DI/fake-based
test suite could not catch** (three in the park/resume turn path, one in the conversation-view question panel),
all fixed with genuine failing-test-first discipline and an evidence trail (execution IDs, NDJSON log citations,
commit SHAs) preserved in `tasks.md`. True cost was **≈ $369** — the recorded $466.73 is inflated ~27% by a
conversation-cost accounting bug this audit found (first SDK result per session lineage double-counted whenever
follow-ups resumed a session). The one change that would most improve the next run: **stop killing armed
background tasks (watchers, dev servers, in-flight live executions) at lane turn ends** — that single mechanism
caused two orphaned live executions, a dev-instance rebuild, ~25 dead turns, and a discarded full-suite run,
and it is, ironically, the same defect class the feature itself was built to fix.

## What worked (preserve these)

- **Live-verification tasks in the spec (8.1/8.2)** — the DI/fake suite (including integration tasks 6.1/6.2)
  stayed green while the real wired ask→park→resume path was broken in three distinct ways. Only tasks that
  mandate "real LLM, Playwright, backend-state evidence" caught them. Evidence: `tasks.md` Implementation Notes,
  fixes `afe213b5`, `0e1da9fd`, `1c9cdaef`, plus the `PromptInputSlot` conv-view fix found in 8.2.
- **"Block honestly, remediate in the validate context" charter rule** — implement blocked 8.1/8.2 with a
  recorded root cause instead of forcing a workaround; the codex validator explicitly verified the block was
  real ("the live artifacts support the recorded block"); the validate context turned the block into 5
  remediation tasks and closed the loop to GO. The full chain worked as designed.
- **Context rotation (continuity)** — 8 fresh conversations across implement's 8 iterations; self-contained
  seed prompts that *shrank* as tasks completed (20.9k → 9.4k chars); zero compaction events anywhere in the
  execution; no prompt-growth pathology. Follow-up prompts carried forward accumulated learnings (the
  dev-harness gotcha, prior fix commits) into remediation task instructions.
- **Mutability + bootstrap enumeration** — 21 workflow tasks enumerated from tasks.md first-try (one per Kiro
  subtask); the validate context self-added its 5 remediation tasks first-try; `cctl` worked essentially
  friction-free (zero permission denials, no `task complete` fights across ~29+ calls per hot conversation).
- **TDD discipline held under pressure** — both live fixes in iteration 7 were verifiably red-green in the
  transcript (RED "1 failed" → fix → GREEN 69/69 and 75/75 + area sweeps), *at 400–500k context tokens, at 1am,
  mid live-debugging*. The validate context's park-loss fix and PromptInputSlot fix were likewise test-pinned.
- **Single-pass codex validation GO on both contexts** — acceptance criteria were precise enough to implement
  against and cheap to verify (structured-output parse path both times, no fallbacks; ~866k input tokens,
  mostly cached).
- **Fully autonomous timeline** — wall clock 9h 10m vs agent work 9h 3m: no human waits, no unexplained stalls,
  clean final publish with zero merge conflicts.

## Friction (ranked by quality impact)

1. **Turn-end kills armed background work in lane conversations.** In the validate conversation
   (`07afd581`), every time the agent armed a park-watcher/poll and ended its turn, the runner killed the
   watchers, the :3071 dev instance, and in-flight live workflow executions, then re-prompted cold. Evidence:
   `task_updated: killed` events at the 02:58:56 segment end; health check `000` on re-entry; live executions
   `5062b359` and `60e7e8` orphaned before the third (`1662d0bc`) succeeded; a full-suite run killed mid-run at
   03:31:54, forcing revalidation into a second conversation. Cost: ~25 dead turns (~$8–10), one dev rebuild,
   ~2 wasted live runs, a discarded ~7-min suite run. Root cause: lane turn lifecycle treats background tasks
   as turn-scoped. Fix: **[engine]** preserve background tasks across lane turn ends (or wake-on-completion),
   the same semantics the ask feature itself needed for pending questions.
2. **Dev-harness URL/env injection broke live verification twice.** `recordServerBaseUrl` derives
   `CC_SERVER_URL` from `process.env.PORT` (default :3000); `next dev -p 3071` does not export `PORT`, so the
   isolated instance injected `CC_SERVER_URL=http://127.0.0.1:3000` into every spawned agent, whose `cctl ask`
   then fought the wrong server/token (exit 3). Ambient prod `CC_*` vars also contaminated the orchestrating
   agent's own `cctl`, forcing an env-scrub wrapper on all ~29 calls. Cost in iteration 7: 3 of 7 live runs and
   3 of 6 server launches wasted, ~24 turns / ~13 min of diagnosis, and a 27-minute gap between first diagnosis
   and adopting the explicit-URL workaround (~$12–15). The validate context only avoided a repeat because the
   remediation task instructions carried the workaround forward. Fix: **[engine]** derive the recorded base URL
   from the actually-bound port (or explicit env) and inject the instance's own URL+token into spawned agents —
   aligns with improvement report §3.1 (pre-flight environment probe).
3. **Conversation cost accounting double-counts follow-up lineages.** For any conversation whose SDK session
   produced ≥2 `result` messages (i.e., follow-up prompts resumed the session), the DB `total_cost_usd` equals
   *final cumulative + first result* per lineage. Verified arithmetically: `07afd581` recorded $201.74 =
   64.85+50.79 (true lineage finals) + 42.37+43.73 (first results, double-counted) → true $115.64; `2d101024`
   recorded $35.29 = 23.50 (true) + 11.78 → true $23.50. All eight single-result conversations were exact.
   Impact: this execution's recorded spend is overstated 27%; every historical conversation with follow-ups is
   inflated. Fix: **[engine]** accrue deltas against the lineage's running cumulative from the *first* result
   (and consider a backfill); the audit extractor should cross-check against raw transcript result costs.
4. **Rotation cannot preempt a mega-turn.** Rotation was scheduled mid-turn at the 250k-token limit in every
   implement iteration, but only takes effect at the iteration boundary — iteration 7's single live-verification
   turn ran to **527k tokens** (2.1× the limit). Degradation was mild but real: late re-read churn (`machine.ts`
   read 11×, 5 within one 90-second window), wait-filler turns, and a hard "CONTEXT LIMIT REACHED" stop that cut
   off the wrap-up, leaving 8.2 as a bare annotation. Fix: **[engine]** aligns with improvement report §3.4
   (context-window budgets) — e.g., inject an agent-visible budget warning into tool results once the limit is
   crossed mid-turn, so the agent lands the turn instead of being guillotined.
5. **~1,600 lines of scratch debris shipped to main.** The final publish carried 14 `.cc/private-dev/` files
   (dev-server logs, poll logs, `wid.txt`, live-run plans) into the session branch and then into main via
   `8b3bb325`. The lane auto-commit sweeps untracked files indiscriminately. Fix: **[engine]** exclude a
   designated scratch path from lane commits, or **[planning-skill]** mandate a cleanup step before context
   completion (note: some of these logs *were* load-bearing evidence — fix #3's root cause was pinned from
   preserved live logs — so "preserve under a non-published path" is the right shape, not "don't write logs").
6. **Minor integrity/telemetry nits.**
   - Iteration 7's handoff claimed both live fixes were "independent code-reviewer APPROVED"; the transcript
     shows only fix #1 (`afe213b5`) got the reviewer — fix #2 (`0e1da9fd`) shipped on a regression sweep alone.
     Completion reports must not claim review that didn't happen.
   - Codex validator spend is invisible in the cost totals: 234.8k input/5.0k output (implement) + 631.0k
     input/5.7k output (validate), mostly cached — likely single-digit dollars, but unaccounted.
   - The shared `session.log` still contained the implement context's day-old events; a stale grep match cost
     the validate agent a re-orientation cycle.
   - One `model_refusal_fallback` (fable-5 → opus-4-8 retry) at 03:15:43 — recovered cleanly, one-off.

## Cost

| Scope | Recorded | Corrected | Notes |
|---|---|---|---|
| implement-tasks (Opus xhigh) | $240.22 | **$228.43** | 21 subtasks ≈ $10.9/subtask incl. per-task TDD + independent review |
| validate-tasks (Fable xhigh) | $226.51 | **$140.41** | `07afd581` $201.74 → $115.64; `96c0f82b` $24.76 exact |
| **Total (10 conversations)** | **$466.73** | **≈ $368.84** | +codex validator ~866k in / 10.7k out, uncounted |

Outliers: `07afd581` (validate round 1 + park-loss fix + both live verifications + revalidation start) true
$115.64 over ~312 SDK turns; `2be0b8b6` $57.29 for implement iteration 3 (7 subtasks in one 2-hour turn — the
*best* $/subtask of the run); `a1386460` $52.95 for iteration 7 (live verification + 2 bug fixes).

Identified waste ≈ **$20–25** (~6% of corrected spend): dev-harness env battle ~$12–15 (iteration 7) +
turn-end wake/kill churn ~$8–10 + one discarded full-suite run (validate). The rest of the "expensive" spend
bought real defect discovery and fixes.

## Time

Wall clock **9h 10m** · agent work **9h 3m** · human waits **0s** · no unexplained gaps.
implement-tasks 7h 25m (8 iterations; largest single turn 1h 57m for 7 subtasks) → validate-tasks 1h 44m →
final publish 2m 19s. The two *contexts* are correctly serial (validate needs implement's tree). But the run
was serial **all the way down** — and that, not per-unit inefficiency, is what made it a 9-hour calendar job.

### Where the ~9 hours went (tool/subagent timing, all 10 transcripts)

Reconstructed by pairing every `tool_use` with its `tool_result` across the transcripts. Sub-agent and
test/lint durations are direct interval measurements; the reasoning bucket is derived (conversation span minus
non-overlapping tool time), so treat it as ±10%. Combined serial wall clock ≈ **543 min**.

| Activity | Wall-clock min | Share | Notes |
|---|---|---|---|
| Lane-agent reasoning / authoring | ~241 | 44% | includes ~70 min of live-verification *orchestration* (iter7 ~50, val1 ~24) |
| Sub-agent chains | ~239 | 44% | independent code review ~174 · implement/explore/debug helper agents ~65 |
| Test runs (focused + full) | ~30–45 | 6–8% | 174 focused invocations + ~6 real full-suite runs; backgrounded suites undercounted |
| Typecheck + lint | ~27 | 5% | 79 typecheck + 24 lint calls |
| Playwright / live tool calls | ~2.5 | <1% | curl/cctl/playwright-cli are individually fast — live-verification cost lives in the reasoning bucket, not here |
| Misc (bash / git / io / dev-server) | ~13 | 2% | |

**Structural finding — a nested serial sub-agent tree.** `/kiro-impl`, driven by the orchestrating lane agent,
spawned *two* sub-agents per subtask — an implement agent (~10–15 min) then an independent review agent
(~5–13 min) — **serially**. iteration 3 (`2be0b8b6`) is the clearest case: a 118-min unbroken chain of
implement→review→implement→review across 7 subtasks with near-zero lane-agent idle. This is why ~44% of the
wall clock is sub-agent time and independent review alone is ~174 min (28 review dispatches).

### Necessary vs. wasteful

- **Genuinely wasteful (avoidable, ~zero quality cost): ~55–75 min (≈11–14%).** Dev-harness env battle
  ~15–20 min (friction 2); turn-end background-kill churn ~20–25 min (friction 1); redundant full-suite reruns
  ~10–12 min (iter1 ran the full suite **3× in 9 minutes**; val1's suite was killed mid-run and rerun in val2);
  cold val2 restart forced by the 527k guillotine ~5–10 min.
- **Structurally reducible (speed/quality tradeoff, not pure waste):** the serial execution itself — see below.
- **Necessary and well-spent:** TDD cycles, one review layer, and the live verification that caught 4 real
  integration bugs. *Per unit*, the run is efficient — ~21 min of lane time per subtask for real
  TDD-plus-review feature work; the 9 hours is not bloated relative to 11.5k LOC + 4 bugs found/fixed.

### The parallelism the plan left on the table

Work-size *was* congruent with time per unit — but **wall-clock ≠ work**, because the run was 100% serial on a
parallel-capable engine. `maxConcurrency` was **8**; the plan used exactly **one lane at a time**
(`batch_scheduled` shows only `[implement-tasks]` then `[validate-tasks]`). The spec itself flags **7 of 19
subtasks `(P)` parallel-eligible** (3.1, 3.2, 4.4, 7.1–7.4), yet the definition collapsed all 21 tasks into a
single serial `implement-tasks` context. The graph's core parallelism primitive was **entirely unused** — the
single biggest calendar-time lever, and a *planning* choice rather than engine waste.

### Redundant validation

- **Full-suite runs:** ~6 distinct real runs, ~3 redundant (iter1's 2 extras + the killed/rerun pair) ≈
  8–10 min. The 174 *focused* test invocations are the red-green TDD loop — granular but each pins a specific
  change, not redundant.
- **Three stacked review layers:** kiro-impl per-subtask reviewer (28 agents) → `/kiro-validate-impl` feature
  validation (3 subagents + full suite) → codex context-validator per context. The `/kiro-validate-impl` pass
  largely re-confirms what per-subtask tests + reviews already covered (~30–40 min in val1) — redundant by
  design, but it earned its keep this run (caught the `PromptInputSlot` bug, confirmed the live fixes). It is
  the first thing to thin if speed matters more than defense-in-depth.

### How to go faster without sacrificing (much) quality

1. **Parallelize the implement context — biggest lever.** Decompose into dependency-ordered lanes: a foundation
   lane (config/schema/gate — tasks 1–2, 3.1) → fan out independent slices (lane routing 3.2, park detection
   4.x, graph UI 7.1–7.3, config editors 7.4) across 3–4 concurrent lanes → join → validate. The spec already
   marks the `(P)` tasks. Plausible saving: **30–45% of the 7.4h implement phase (~130–200 min calendar).**
   `[planning-skill]`
2. **Fix the two pure-waste engine bugs** (turn-end background-kill; dev-harness URL injection) — reclaims
   ~40–50 min and removes the live-verification tax. Same as recommendations 1–2 below. `[engine]`
3. **Give live verification its own fresh, early context** rather than the tail of a 527k-token iteration —
   avoids the guillotine and the val1→val2 cold split. `[planning-skill]`
4. **Thin review granularity:** collapse 28 per-subtask reviews into ~6 slice-level reviews and/or run
   reviewers on a faster tier — the codex context-validator + validate context are a second net. Estimated
   ~60–100 min saved at modest quality risk. `[planning-skill/engine]`
5. **Stop ad-hoc full-suite runs mid-iteration** — rely on focused tests during TDD and one script-validated
   full run per context. ~8–10 min. `[planning-skill]`

Net: items 2, 3, 5 are near-free (~60–70 min, no quality cost); item 1 is where the real calendar compression
lives. The run was fundamentally paced by a serial plan on a parallel engine.

## Recommendations

1. **[engine]** Preserve lane-conversation background tasks across turn ends (or wake the conversation on
   background completion). Directly removes friction 1; same semantic family as the ask feature's own
   park-before-follow-up fix (`1c9cdaef`).
2. **[engine]** Fix `recordServerBaseUrl` port derivation + inject the isolated instance's own URL/token into
   spawned agents; add a pre-flight probe for live-verification contexts (improvement report §3.1).
3. **[engine]** Fix `total_cost_usd` accrual (delta from first result of each lineage; today the first result
   is double-counted when follow-ups exist). Audit extractor: cross-check DB costs against transcript raw
   result costs and flag divergence.
4. **[engine]** Mid-turn context budget signal (improvement report §3.4): once rotation is scheduled mid-turn,
   surface "wrap up now, rotation pending" to the agent instead of relying on the hard stop.
5. **[engine/planning-skill]** Keep lane scratch out of published history: an ignored scratch dir for live-run
   evidence, referenced (not committed) by tasks.md — while keeping the evidence-preservation habit itself.
6. **[planning-skill]** Codify two things this run proved: (a) specs for engine-touching features should always
   carry live-verification tasks with "backend-state evidence" done-whens — they are the only net that catches
   DI-suite blind spots; (b) schedule live-verification as the first work of a fresh context/iteration rather
   than the tail of a long one, so the context ceiling doesn't guillotine the endgame (iteration 7 hit both).
7. **[planning-skill]** Completion-report honesty rule: claims of independent review must name the reviewer
   evidence (agent invocation / commit trailer), so validators can verify rather than trust.

## Addendum — context-limit (rotation) quality impact, from transcript evidence

No A/B exists, but this run is a decent natural experiment: implement rotated 8× (fresh conversation per
iteration), validate held one conversation for 3 iterations, and one iteration overshot the limit 2.1×.

**Where quality wobbled, context was highest.** Every quality symptom in the run clusters at the two places
the limit failed to bind: iteration 7's in-turn overshoot to 527k (re-read churn — `machine.ts` 11×, 5 within
90s; wait-filler turns; the false "reviewer-approved" claim; the guillotined wrap-up) and the validate
conversation's sustained 280–364k across 3 iterations (standby churn, stale-log confusion, boundary
re-derivation, the run's most expensive conversation at a true ~$116). Conversely, no rotation boundary shows
a quality dip: zero cross-conversation contradictions, no task redone or reopened, no decision re-litigated,
first-pass GO from both validators. The cleanest, cheapest work happened in fresh/low-occupancy conversations
(iteration 3: 7 subtasks at ~$8.2 each in one turn; iteration 8: $2.64 wrap-up at 122k). Confound: iteration 7
was also intrinsically the hardest work — correlation, not proof.

**Rotation's rebuild tax is real but shallow.** Median ~5.5–7 min from fresh-conversation start to first edit
(range 3.7–14.2), ≈ 15–20% of iteration wall time. Spec files were re-read at almost every start (tasks.md by
all 8 conversations, design.md and requirements.md by 7, `schemas.ts` by 7, `iteration-orchestrator.ts` by 6).
Cross-conversation redundant read volume ≈ 738k tokens — 57% of all Read volume — though that is an upper
bound (agents also re-read files within a single conversation after edits). Order of magnitude: low tens of
dollars of the $228 implement spend, roughly offsetting the high-context churn it prevented. Crucially the
rebuilding was mechanical re-reading, never re-deriving decisions — which is why it cost money but not quality.

**The seed is lean; continuity rides on durable state, not the seed text.** Seeds ran 9.4–20.9k chars
(~2.5–5k tokens, 1–2% of the 250k budget): charter + remaining tasks + AC + protocol, shrinking monotonically
as tasks completed, with no feedback-injection bloat. Sufficiency was proven — every fresh conversation resumed
the correct next task unaided — but it comes from the external ledger (tasks.md checkboxes, `_Blocked:_` notes,
Implementation Notes, git history), not from any carried conversation memory. The one fragile link:
environmental learnings (the dev-harness gotcha, fix-commit references) crossed the rotation boundary only
because the iteration-7 agent volunteered them into tasks.md and the remediation task instructions. Nothing in
the protocol requires that; a less diligent agent's environment knowledge dies at rotation.

**Implications:** (a) keep the limit — the damage pattern supports its premise, and its cost is bounded and
mostly shallow; (b) the highest-leverage tweaks are making the limit actually bind (mid-turn budget signal,
fresh context for heavy endgame work — recommendations 4 and 6b) and adding a required "lessons for the next
conversation" slot to rotation seeds; (c) instead of A/B, instrument the natural experiment: per-conversation
occupancy-vs-outcome telemetry (context at each turn, $/subtask, validator verdicts, re-read counts) would
accumulate dose-response evidence across executions at near-zero cost.

---
*Sources: `workflow-logs/7b35d37a…/` (iterations, decisions, lifecycle, validation, prompts), CC DB
(read-only: executions, events incl. `reviewArtifact.usage`, conversation costs), transcripts `a1386460` and
`07afd581` (deep-read), merged commit `8b3bb325`, spec `tasks.md` final state.*
