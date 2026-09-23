# Workflow audit — Implement skill-sync in ReScript (beac065a-6731-42eb-96ab-57a5e169c1ac)

Companion: [2026-09-20-skill-sync-complexity-origins.md](2026-09-20-skill-sync-complexity-origins.md) traces where the scope came from. This report covers how the execution itself performed. A separately authored audit of the same execution, [2026-09-20-skill-sync-execution.md](2026-09-20-skill-sync-execution.md), was written in parallel; the two agree on the headline figures and the breaker, gate, prompt-volume and file-split findings. This report adds the round-by-round NO-GO classification, an independent run of the landed test suite, the validator dribble and over-correction analysis, and the context-accretion estimates.

Sources: `bun run workflow:audit -- --execution beac065a…` (markdown and JSON), `workflow-logs/beac065a…/{lifecycle,decisions}.jsonl` and `contexts/<id>/{iterations,tasks,validation}.jsonl`, the execution row in `command-center.db` (definition, runtime, 483 events), the seven implementer transcripts, the `bounded-store` validator transcript, the lane branch in the skill-sync repository (`902ad58..5bd90c1`), and a clean clone of lane HEAD on which the landed test suite was run. Three transcript deep-reads (bounded-store implementer, bounded-store validator, sync-policies implementer) were delegated; every number quoted from them was re-derived against `iterations.jsonl` or the transcript itself.

## Verdict

The six landed contexts are real, tested and honest about their platform coverage: lane HEAD builds and passes all 285 behaviour tests across 19 files, every evidence document states that only macOS was exercised, and the validators found genuine data-loss-class defects (a case-only rename silently replaced, a destination symlink escape, gitignore precedence errors) that the implementers then reproduced through the production CLI before fixing. The engine itself ran clean for nine hours: no infrastructure halt, no hung turn, no compaction, no parse fallback, no merge conflict, and roughly one percent dead air.

The cost of that quality was high. $297 and 9h 02m bought 6 of 17 contexts, and 48% of implementer spend went to validator-driven rework rounds. Two contexts needed six rounds each, tripped the circuit breaker, and were rescued by automated plan repair whose diagnosis was correct: a one-sentence plan-authored criterion, a validator reporting one sibling instance per round, an implementer patching the named site, and a breaker of 4 set against an iteration budget of 20. The single change that would most improve the next run is making the validator state the rule it is enforcing and sweep every sibling instance in the round it first raises the class, and filing the rule as a plan defect when the criterion text does not contain it.

## Shape of the run

| Fact | Value |
| --- | --- |
| Origin | Native spec delivery, spec `claude-codex-sync` revision 8, definition `3454f6ea` revision 2 |
| Graph | 17 contexts, 52 tasks, 135 acceptance criteria, 16 edges forming one strict chain, one lane (`implementation`, every context `mode: full`) |
| Implementer | Claude `opus`, effort `xhigh`, one conversation per context reused across iterations |
| Context validator | Codex `gpt-5.6-sol`, reasoning `xhigh`, single `general` assignment, session reused across rounds, static review only |
| Script validator | `commands: []` on all 17 contexts (charter: "No commands were registered at planning time") |
| Budgets | `maxIterations` 20, `consecutiveFailureThreshold` 4 (raised to 8 on two contexts by plan repair), no approval gates |
| Started / paused | 07:06:07Z / 16:08:01Z by the operator, with `instructions` mid-iteration 3 |
| Progress | 6 of 17 contexts landed (commits `d2edf95` → `5bd90c1`), `instructions` at 2 of 3 tasks, 10 contexts untouched |
| Shared documents | 33 (25 seeded at launch, one evidence pointer per completed context) |

Per-context outcome, with agent time from `iteration.prompt_sent → iteration.agent_turn_completed` and validator time from `context_validator.started → validator.result_parsed`:

| Context | Iterations | Rounds (NO-GO) | Agent min | Validator min | Implementer $ | Validator $ |
| --- | --- | --- | --- | --- | --- | --- |
| toolchain-contracts | 1 | 2 (0) | 28.1 | 4.3 | 13.99 | 1.73 |
| bounded-store | 6 | 6 (5) | 79.0 | 34.7 | 50.13 | 8.44 |
| skill-spine | 2 | 3 (1) | 41.0 | 10.6 | 25.18 | 4.25 |
| skill-compatibility | 3 | 3 (2) | 44.8 | 9.9 | 33.90 | 3.02 |
| sync-policies | 6 | 6 (5) | 77.1 | 25.5 | 43.41 | 8.20 |
| agents | 4 | 5 (3) | 84.7 | 25.5 | 59.07 | 11.19 |
| instructions | 3 (third interrupted) | 2 (2) | 53.2 | 11.4 | 31.50 | 3.34 |
| **Total** | **25** | **27 (18)** | **407.9** | **121.8** | **257.19** | **40.17** |

The three "extra" GO rounds (toolchain-contracts, skill-spine, agents) were re-validations after the implementer marked a validator advisory as `addressed`; together they cost 2.6 validator minutes.

## What worked (preserve these)

- **Engine reliability.** Zero infrastructure halts, hung turns, compactions, background-task kills, merge failures or cost mismatches; 27 of 27 validator responses parsed via `structured_output`; tool errors across seven implementer transcripts total one (a shared-doc path refusal, self-corrected). Wall clock decomposes into agent turns 75%, validator rounds 22%, plan repair 1%, everything else 1% (`lifecycle.jsonl`, `iterations.jsonl`, `validation.jsonl`).
- **Automated plan repair.** Both circuit-breaker trips (`09:09:44Z`, `12:39:26Z`) were diagnosed and repaired without a human in 2m 01s and 3m 42s (`graph-workflow-plan-repair` events, `outcome: repaired`, `planningDefect: true`). Each diagnosis named the real causes: monotonic convergence (7→2→2→1 and 3→3→1→1 findings), a one-sentence criterion the two agents read differently, a task that never named the structural model, and a breaker foreclosing 80% of the iteration budget. Each repair rewrote the criterion to the validator's stricter reading, redirected or added a task at the concept, and raised the breaker. Both contexts passed two rounds later.
- **Validator session reuse.** Rounds 2 and later opened by re-checking the previously reported findings and took 0.3 to 7.2 minutes against 6 to 12 minutes for round 1; every summary certified prior repairs ("Most reported defects are repaired") so the implementer knew what was closed.
- **Static validators found real defects cheaply.** Average $1.49 per round. The findings that mattered were data-loss class: `skill-spine` round 1 (renaming `review` to `Review` on macOS made the next sync delete and recreate it without `--override`), `bounded-store` round 1 (a `project/.agents/skills -> /outside` symlink became an accepted mutation boundary), `instructions` round 1 (a lower `.gitignore` re-including a file its excluded parent forbids). This repeats the 2026-09-18 audit's conclusion that read-only inspection earns its cost.
- **Implementers reproduced before fixing and kept evidence honest.** Every follow-up iteration in the two deep-read transcripts starts with a production-CLI reproduction of the finding (sync-policies entries 5044, 11412, 11592; bounded-store revert-verified non-vacuity runs each round). Evidence documents open with "executed on macOS 15.7.7 … No Linux execution has happened in this context" (`docs/evidence/{bounded-store,skill-spine,agents}.md`), which is exactly what the `honest-runtime-evidence` invariant asks for.
- **Advisory channel with one-line declines.** Validators separated blocking issues from `out_of_scope` and `implementation` advisories; implementers acted on wording advisories and declined the fault-seam advisory with a reason each time. No advisory ever reopened a task.
- **Landed work is green.** `npm test` at lane HEAD `5bd90c1` in a clean clone: 19 files, 285 tests, exit 0, 59 s (Node 24.16.0, macOS). Nothing in the workflow had run this; see friction 5.

## Friction (ranked by quality impact)

1. **One-sentence plan-authored criteria plus one-sibling-per-round validation produced four rounds of same-family patches in two contexts.** Evidence: `bounded-store` rounds 2 to 5 raised six issues of which five are `[effect-outcome]` accounting under indeterminate evidence, one per round, with two already present in round-1 code and unreported (validator transcript items 81, 116, 165, 192; `Store.res` reuse at line 561 in round 1). `sync-policies` rounds 1 to 5 raised destination path identity at successively finer granularity (case folding, Unicode normalisation, fresh targets, images inside one tree, image-pair asymmetry). The original criteria were "truthful publication state" and "override does not bypass malformed input or path-boundary errors"; the repaired versions run to roughly 150 words each and are what the contexts then passed against. Root cause: the four contexts that claim no spec criteria (`bounded-store`, `hook-conversion`, `failure-recovery`, `journey-closeout`) were given one-line criteria without a stated rule, and the validator prompt asks for issues, not for the rule and its sibling instances. Cost: bounded-store iterations 3 to 6 $24.19 and sync-policies iterations 3 to 6 $23.80 (`iterations.jsonl` `costUsdDelta`), plus 18 validator minutes. Fix: [engine] validator prompt obligation to state the general rule, sweep every site in the changed files, and file a `planDefect` when the rule is not in the criterion text; [planning-skill] plan-authored criteria for spec-free contexts must carry the rule (the repaired `effect-outcome` text is the model).
2. **Breaker of 4 against a budget of 20 halted converging work twice.** Evidence: `decisions.jsonl` `circuit_breaker.tripped` at `consecutiveFailureCount: 4, threshold: 4` while `iterationPolicy.maxIterations` was 20; both repair diagnoses call this out; both contexts passed at iteration 6. Fix: [engine] trip the breaker on a non-decreasing issue count rather than on consecutive failures alone, or validate at definition-accept time that the breaker is at least half the iteration budget; [planning-skill] state the relationship explicitly.
3. **Round-2 over-corrections.** In three of six validated contexts the round-2 finding was a defect the round-1 fix introduced: `sync-policies` normalised every path to NFC unconditionally (agent-originated; thinking at transcript entry 5593 notes "the pinned design specifically calls out case-awareness but not normalization", entry 6216 names the ext4 counter-case, the policy was chosen anyway), `agents` trimmed Claude descriptions with Codex-only semantics, `instructions` pruned every real directory named `CLAUDE.md` to exclude directory symlinks. Each cost one extra round. Fix: [template] the follow-up prompt should say: repair by evidence the destination filesystem or loader can answer, never by an assumed policy; enumerate sibling cases of the finding's class; do not extend a fix to the other ecosystem or direction without a verified source.
4. **Prompt redundancy and context accretion.** Every one of the 25 implementer prompts begins with an identical 65,342-byte block (spec-ownership table for all 135 criteria plus a context index); it is 82% of a follow-up prompt and was re-sent 18 times into conversations that never restarted. For `bounded-store` the block's own row reads "No selected spec criteria are claimed by this context." Cost per SDK turn rose from $0.17 to $0.38 in `bounded-store` and from $0.15 to $0.37 in `sync-policies` as cache-read context grew from about 190K to 640K tokens per turn (`result` entries; per-iteration cost and turn counts from `iterations.jsonl`). Holding iterations 2 to 6 at iteration-1 cost per turn would have saved an estimated $16 in each of those two contexts. The 2026-09-18 audit reported the same table at 69% of every prompt as its P1 engine recommendation. Fix: [engine] send the table once per conversation, then only the context's own rows; omit it for contexts claiming no criteria; consider a fresh conversation per validation round seeded with the handoff and findings.
5. **No deterministic gate anywhere in the run.** `scriptValidator.commands` is empty on all 17 contexts, and the validator prompt says "Do not attempt to run those checks yourself." The first context built `npm test` and a heap-pinned harness, yet no later context registered it as a `cctl validate` command, so every GO was a static reading and the only test evidence in the loop was the implementer's stored summary. The suite is green (285 tests), but the workflow could not know that. Fix: [planning-skill] when the first context creates the test harness, its tasks should register the command and later contexts should select it as the script gate; [engine] §3.5 of the improvement report (default the script validator, confirm before disabling).
6. **Validator inputs were the wrong shape.** The diff was truncated in 27 of 27 rounds (`diff_scope.computed truncated: true`; `Store.res` +1,724 lines never inline; `agents` omitted 12 of 12 files from round 2; `instructions` 16 to 17 of 17), and the pinned spec excerpt ranked as authority number 2 for `bounded-store` is a one-line stub ("No spec criteria are covered by this context"), so the validator read the full 82 KB spec instead (validator transcript items 9 and 13). In the two rounds where the validator read only the delta around the previous fix (rounds 4 and 5) it produced exactly one new sibling each. Fix: [engine] rank source files ahead of tests and evidence in the inline budget (§2.5); for spec-free contexts pin the design sections the tasks cite instead of a stub.
7. **A recurring out-of-scope advisory had no owner for five rounds.** The `SKILL_SYNC_TEST_FAULTS` environment seam was the implementer's choice (first written at transcript entry 2757; the task asked only for "a narrow private filesystem-operation seam"), was flagged `out_of_scope` in every `bounded-store` round and again in `skill-spine`, was declined five times with a reason, and only became a task when plan repair appended one to `failure-recovery`. It is still in the production module at lane HEAD (`src/Store.res:50-61`). Fix: [engine] when the same `out_of_scope` advisory recurs, route it as a task to the downstream owner it names instead of re-delivering it.
8. **Zero parallelism by construction.** The chain is strict because every content-type context edits `src/Native.res` (3,371 lines at lane HEAD; +823, +1,195, +115, +1,541 across four contexts) and `src/Sync.res`. `agents`, `instructions` and the hook contexts have no semantic dependency on each other. Fix: [planning-skill] split `Native` by content type so content contexts can be parallel lanes with a serial spine for shared contracts (§5.1, §5.2).
9. **Telemetry labels.** `execution.resumed` is logged with `actor: "operator"` even when plan repair auto-resumes (`workflow-manager.ts:2445` hardcodes it; the live-edit landed 150 ms before the resume), so the extractor reports 5m 42s of "operator recovery" that was automated repair. The extractor also reports occupancy as unknown for all seven contexts although `iterations.jsonl` records `backend: claude`, `contextWindowMax: 1000000`, `occupancyMeasurable: true` (peak 65% in `bounded-store`). Fix: [engine] log the resume actor as `plan-repair`; [audit] treat Claude counters as measurable.
10. **Self-reports overclaimed once.** The `bounded-store` iteration-1 handoff (transcript entry 8177) reported all three tasks complete with 77 tests green and asserted the boundary and no-unlink guarantees that round 1 then refuted with seven issues. The validator caught it, so the cost was one round, not a defect.

## Every NO-GO: was the acceptance criterion wrong?

| Context, round | Finding class | Criterion status | Judgement |
| --- | --- | --- | --- |
| bounded-store 1 | 7 issues: reserved-path links, destination symlink escape, metadata failure as absence, collision graph, pre-publication unlink, mode lookup, deletion outcome | Mixed: symlink and unlink findings against explicit spec text; `.git` exclusion an inference | Real defects; handoff overclaimed |
| bounded-store 2 | Prepared batch reusable; Complete downgraded to Partial | Reuse is explicit spec text ("cannot be … reused") and was present in round-1 code | Real, but listable in round 1 |
| bounded-store 3, 4, 5 | Publication state under indeterminate evidence, one site per round | "truthful publication state" was one sentence until repair rewrote it | Criterion ambiguity; validator dribble |
| skill-spine 1 | Case-only destination path replaced without override | Explicit ("repeat/conflict safety") | Real, data-loss class |
| skill-compatibility 1, 2 | Feature-specific omission consequences; reference-style links; direction-specific semantics | Pinned rule "same-name fields do not establish equivalent semantics" | Real; round 2 is the implementer's deliberate `EitherDirection` choice reversed |
| sync-policies 1 | Case-folded nested boundaries; nested unrecognised directories | Explicit (`unmatched-skill-retention`) | Real, data-loss class |
| sync-policies 2 | Unconditional NFC invents aliases | Not asked; implementer's own policy | Over-correction |
| sync-policies 3, 4 | Unicode collisions on fresh targets; inside one tree | `selection-preflight` was one sentence until repair | Criterion ambiguity plus the implementer recording a "residual" instead of fixing (entry 8171) |
| sync-policies 5 | Image-containment asymmetry | Explicit after repair | Implementer-introduced in the structural fix |
| agents 1 | MCP stdio shapes, Codex identity trimming, effective descriptions, restriction diagnostics | Pinned mapping and loader evidence | Real |
| agents 2 | Codex normalisation applied to Claude; literal MCP ids trimmed | `approved-native-contract` | Over-correction of round 1 |
| agents 3 | Codex-normalised collisions not preflighted; negative coverage | `agents-duplicate` | Sibling of round 1 |
| instructions 1 | Ignore precedence, `ignorecase`, symlink traversal, pruned counterparts bypass conflict protection | Pinned design rules | Real, data-loss class (silent replace) |
| instructions 2 | Real directories named `CLAUDE.md` pruned | Pinned design excludes symlinks only | Over-correction of round 1 |

Of 18 NO-GO rounds, 8 rest on findings with explicit criterion or pinned-design text, 5 on a criterion that was ambiguous until plan repair rewrote it, 3 on over-corrections introduced by the previous fix, and 2 on sibling instances the validator could have listed earlier.

## Outcome quality (what validators could not judge)

- **The suite passes.** Verified independently: 285 tests, 19 files, exit 0 at `5bd90c1`. No validator or script gate ever ran it.
- **Platform claims are honest and narrow.** Every evidence document states macOS-only execution; `skill-spine` records Claude Code 2.1.278 loader checks and `agents` records `codex doctor --json` startup-warning checks; `bounded-store` states no native loader was run. Linux is owned by `docs-distribution`, which has not started.
- **Proportionality is unjudged.** Validators enforce the pinned design; nothing in the loop asks whether a four-state publication ledger, a three-valued Unicode identity model or a fault seam is proportionate to one operator on a local disk. The companion report covers that question. Size at lane HEAD: 8,255 lines of ReScript source in 15 files, 9,521 lines of tests in 24 files, 2,070 lines of evidence prose.
- **Deferred debt is visible.** The fault-injection environment variable is still read by the production `Store` module; `failure-recovery` now owns its removal. The `instructions` context was paused mid-iteration, so its lane worktree may hold uncommitted iteration-3 work.

## Cost

Total $297.35 across 14 conversations (transcript-corrected total equals the recorded total; no `cost_gap` or `cost_mismatch`).

| Slice | $ | Share |
| --- | --- | --- |
| Implementer seed iterations (7) | 133.12 | 45% |
| Implementer follow-up iterations (18) | 124.07 | 42% |
| Context validators (27 rounds) | 40.17 | 13% |

Identified avoidable spend, all from `iterations.jsonl` `costUsdDelta` unless marked as an estimate:

- Same-family rounds after the class was first raised: bounded-store iterations 3 to 6 $24.19; sync-policies iterations 3 to 6 $23.80; agents iterations 3 to 4 $18.47.
- Over-correction rounds: sync-policies iteration 3 $5.56, agents iteration 3 $14.17, instructions iteration 3 (interrupted, unpriced).
- Context accretion (estimate: follow-up turns priced at the seed iteration's cost per turn): about $16 in bounded-store and $16 in sync-policies.
- Prompt redundancy: 18 × 65 KB of identical prefix, cache-read on every turn; small in dollars, large in context growth.

Largest conversations: agents implementer $59.07 (258 SDK turns, iteration 1 alone 49m 53s and $32.14), bounded-store implementer $50.13 (201 turns), sync-policies implementer $43.41 (186 turns).

## Time

| Component | Duration | Share |
| --- | --- | --- |
| Wall clock (07:06:07Z to 16:08:01Z pause) | 9h 01m 53s | 100% |
| Agent turns | 6h 47m 52s | 75% |
| Validator rounds | 2h 01m 48s | 22% |
| Automated plan repair (two halts) | 5m 42s | 1% |
| Everything else (advisory-response turns, lane commits, prompt assembly) | about 6m 30s | 1% |
| Human waits (gates, questions) | 0 | 0% |

No context ran in parallel because the plan is a chain; see friction 8. Completed contexts averaged 80 minutes and $44 each including validation. At that rate the remaining 11 contexts would need on the order of 15 hours and $480; that is an extrapolation, not a measurement.

## Agents context (largest conversation)

The `agents` implementer (`f74d294a`, $59.07, 258 SDK turns, 9,045 transcript entries, zero compactions) is the run's most expensive conversation and the clearest example of rework seeded by an unmeasured claim.

- **Iteration 1 was legitimate heavy lifting: 49.9 minutes, $32.14, 54% of the conversation.** Time split from the transcript: about 10 minutes probing the native loaders (`codex doctor`, app-server schema, `claude --help`, two web fetches) because the handoff demands loader evidence; about 10 minutes implementing `NodeToml.res` and roughly 700 lines of `Native.res` plus five test files; eight full-suite runs totalling 8 minutes; a 20 KB evidence document. It also dumped whole bodies of `Sync.res`, `Native.res` and `Command.res` up front (about 124K tokens of tool results), which then rode along as cache-read context on all 175 turns of the iteration.
- **Iteration 2 accepted an unmeasurable validator claim and generalised it.** The round-1 finding asserted "the pinned Codex loader trims descriptions". The implementer measured name trimming, could not measure description trimming, and wrote at entry 6718 that it would "settle on normalizing both the comparison and the rendered output by trimming name and description for both ecosystems". That decision is the whole of round 2's NO-GO (Claude descriptions altered; literal MCP ids trimmed). At entry 7634 in iteration 3 it wrote "I realize I overgeneralized: I only actually measured trimming for Codex role names". The implementer did contest one round-1 claim (that Codex rejects `type = "stdio"`) and correctly declined to implement it, but the only channel for that was prose in the task summary.
- **Iterations 3 and 4 were the narrowing and the sibling it exposed.** Iteration 3 cost $14.17 and 13 minutes, including a 23-call detour instrumenting compiled JavaScript to discover its own test expectation was wrong. Iteration 4 ($4.30) reproduced the collision finding through the production CLI before fixing it (entry 8936).
- **Cost per turn rose from $0.18 to $0.39** as cached context per turn grew from about 267K to 638K tokens; thinking shrank from 62K to 3K characters per iteration.
- **Waste specific to this transcript:** 8 of 15 full-suite commands ran the suite two or three times in one command to obtain counts the wrapper does not print (about 11 of 15 suite minutes); `timeout` missing on macOS; PATH resolving Codex 0.153.3 instead of the pinned 0.155.1 until the explicit binary was used.

Highest-leverage change for this context: require any loader-behaviour finding, from validator or implementer, to cite the measurement it rests on, and give the implementer a first-class "contested, not implemented" disposition before repair. That removes round 3 and most likely round 4 (about $18 and 24 agent minutes plus 12 validator minutes).

## Recommendations

| Priority / owner | Change | Evidence | Existing proposal |
| --- | --- | --- | --- |
| P1 [engine] | Validator prompt: when raising an issue, state the rule being applied, sweep every sibling site in the changed files (full file, not delta), and file a `planDefect` when the rule is not in the criterion text | friction 1, 6 | §2.1 ESCALATE, §2.2 adversarial verify |
| P1 [planning-skill] | Plan-authored criteria for contexts claiming no spec criteria must state the rule (use the repaired `effect-outcome` and `selection-preflight` texts as exemplars); lint one-sentence criteria on `full`-mode contexts | friction 1 | §2.7 spec lint |
| P1 [engine] | Send the spec-ownership table once per conversation; follow-ups carry only the context's own rows; omit it entirely for contexts with no claims | friction 4 (18 × 65 KB) | §3.4; 2026-09-18 audit P1 (still open) |
| P1 [engine] | Breaker semantics: trip on non-decreasing issue count, or validate breaker ≥ half of `maxIterations` at accept time | friction 2 | §3.2 failure taxonomy |
| P2 [template] | Follow-up prompt: repair by verifiable evidence not policy; enumerate the finding's sibling cases; never extend a fix across ecosystem or direction without a verified source | friction 3 (3 of 6 contexts) | §1.6 shared rubric |
| P2 [engine] | Loader-behaviour findings must cite their measurement; add a "contested, not implemented" disposition the implementer can return before repair, routed to a judge or plan repair | agents rounds 2 to 3 (about $18) | §2.1 validator appeal |
| P2 [planning-skill] | The context that builds the test harness registers it as a `cctl validate` command; later contexts select it as the script gate | friction 5 | §3.5 |
| P2 [engine] | Diff inline budget ranks `src/` first; pin cited design sections for spec-free contexts instead of a stub excerpt | friction 6 (27/27 truncated) | §2.5 |
| P2 [engine] | Recurring `out_of_scope` advisories become a task on the named downstream owner after the second occurrence | friction 7 (declined 5×) | §4.5 remediation |
| P3 [planning-skill] | Split `Native` by content type so `agents`, `instructions` and hooks can run as parallel lanes behind a contracts spine | friction 8 | §5.1, §5.2 |
| P3 [engine/audit] | Log plan-repair resumes with their own actor; treat Claude context counters as measurable occupancy | friction 9 | prior audit 2026-09-18 extractor items |

Not recommended: giving validators command access. Static review found the data-loss class defects at $1.49 per round and the landed suite is green; the gap is a deterministic script gate, not validator execution.
