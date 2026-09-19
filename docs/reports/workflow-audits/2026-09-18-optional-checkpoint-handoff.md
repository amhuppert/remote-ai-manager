# Workflow audit — Optional checkpoint handoff, implementation (bf9eca70-c1aa-45d5-a844-f7866bfe784b)

Execution `bf9eca70` · definition `b8628039` rev 5 · native spec `cc-checkpoint-compaction` (origin `spec_delivery`) · session "Ticket: Manual conversation compaction with CC checkpoints (2)" · audited 2026-09-18.

Sources: `bun run workflow:audit -- --execution bf9eca70…`, `workflow-logs/bf9eca70…/{lifecycle,decisions}.jsonl` and `contexts/<id>/{iterations,validation}.jsonl`, `graph_workflow_events` (read-only), the 14 conversation transcripts (Codex app-server JSONL, tallied with python3), `git show c3a19709`, and three delegated transcript deep-reads whose numbers were re-derived from the transcripts before use.

## Verdict

The workflow completed 12/12 contexts and 40/40 tasks and published a large, honestly reported candidate (`c3a19709`: 249 files, +39,303/−362). Every one of the six NO-GO rounds surfaced a real defect that the implementer reproduced red-first and fixed; 7 of 12 contexts passed first try. The three published certification reports keep their semantic grades as **failed** (fact loss across all eight comparison cells) and say "not release approval" — the validators could not fail that because the acceptance criteria ask for reported retention, not a retention threshold, so the open quality question belongs to the spec, not to this run.

Wall clock was 16h 57m for 8h 51m of summed agent time (≈7h 46m on the critical path). **41% of the wall clock (6h 59m) was human or operator wait**, dominated by a 4h 53m halt after the Codex account hit its usage limit and 1h 33m of user-question wait in `live-codex` caused by an installed-CLI bug on session names with spaces. Implementer spend was $304 (transcript-corrected) plus ≈$22 of Codex validator spend.

The single change with the most leverage: treat provider quota/rate-limit exceptions as a distinct halt class with a retry-after wait or validator-engine fallback, and surface the `account/rateLimits/updated` telemetry Codex already streams as an at-risk warning before it becomes a multi-hour halt.

## Shape of the run

- Graph: a linear chain with one three-way fan-out (`evidence-seed`, `claude-capture`, `codex-capture`) after `capture-contracts-storage`, then eight contexts in series on one reused `handoff` lane. `maxConcurrency` 8 was never approached.
- Engines: all 12 implementers Codex `gpt-6-astra` (reasoning medium); all context validators Codex `gpt-6-astra` (reasoning xhigh), read-only with **no validation commands enabled** (`agentValidation.contextValidator: mode only, commands []`); `release-verification` added a Claude `general-reviewer`. Script gate per context: `typecheck`+`seams`; `release-verification`: `typecheck`, `seams`, `lint`, `test`.
- 34 shared documents (charter, pinned spec excerpts, claims, 13 agent-created handoff docs with 8 updates), 3 advisories, 2 live edits (one agent-added task `report-attestation-effect` in `cli-controls`; one UI edit to `release-verification` at 15:58Z), 2 joins with 0 conflicts.

## What worked (preserve these)

- **First-try GO on 7/12 contexts** (`evidence-seed`, `capture-lifecycle`, `receipts-http`, `cli-controls`, `ui-controls`, `live-claude`, `release-verification`): acceptance criteria were concrete enough to implement against, and the pinned spec excerpts plus claims table gave each context an unambiguous ownership boundary. No deep-read found scope wandering.
- **Every NO-GO bought a real fix.** Ten findings across six rounds (`capture-contracts-storage` 2, `claude-capture` 2+1+1, `codex-capture` 2, `capture-recovery` 2); task summaries cite red-reproduction run IDs for each, and the `claude-capture` transcript confirms red-first at entries 2696 (`3 failed | 25 passed`), 3711 and 4526 before each fix. The implementer never argued with a finding.
- **Validator continuity made recertification cheap**: fresh rounds took 2m 36s–6m 24s; re-validation rounds that reused the validator thread took 38–50s (`capture-contracts-storage` r2 0m50s, `codex-capture` r2 0m49s, `ui-controls` r2 0m38s).
- **Halt recovery resumed the round, not the context**: after the usage-limit halt the engine emitted `validation_round.resumed` against the same candidate tree hash and passed in 4 minutes; no implementer work was redone.
- **Shared-document chaining across contexts**: the probe harness built in `live-claude` was consumed by `live-codex` without re-running Claude cycles, and `live-codex` turn 3 resumed after a 66-minute pause without re-executing any of its turn-1 cycle runs (evidence dirs reused, new artifacts only).
- **Ask-user was used at a genuine fork** (installed CLI broken, fix requires the main checkout) and the agent collected all in-flight probes before ending its turn.
- **Honest deliverables**: all three certification reports preserve failed semantic grades verbatim ("mechanical success is not semantic approval"), and `verification.md` records the initial full-suite failures (3 of 2,100 files) alongside the fixes and passing run IDs.
- **Advisory loop**: one `ui-controls` advisory (Storybook eligibility) was addressed and recertified in under a minute; the other two were correctly declined as out of scope.

## Friction (ranked by quality and calendar impact)

1. **Codex usage-limit exhaustion halted the run for 4h 53m** — evidence: `decisions.jsonl` 09:29:58Z `iteration.retryable_error_detected` (implementer `ui-controls`, "You've hit your usage limit … try again at Sep 22nd"), then `validation.jsonl` three `context_validation.completed reason=exception` in 12 seconds (09:30:13/17/20Z), `execution.halted validator_infra_error`, resumed 14:23:23Z. Root cause: quota errors are retried like transient errors; three attempts 4s apart cannot succeed, and there is no pre-flight quota check even though the app-server streams `account/rateLimits/updated` (`usedPercent`, `resetsAt`) into every transcript. Classified infrastructure, not agent. Fix: [engine] quota/rate-limit exceptions → wait-until-`resetsAt` or validator-engine fallback (a Claude reviewer was already configured for `release-verification`); [engine] warn at a `usedPercent` threshold. Aligns with improvement report §3.2 (infrastructure ≠ agent failure).

2. **`live-codex` lost 2h 06m to an installed-CLI bug and a mis-framed question** — evidence: transcript `d2ef0886` entry 485 (16:43:20Z) `cctl dev ensure nextjs` → `KERNEL_HANDLER`; diagnosis sub-thread 31 commands 16:44:19–16:50:20Z found `cli-for-agents` rejecting recovery identifiers containing whitespace (this session's name has spaces); `iterations.jsonl` `user_input.waiting` 16:56:40Z→17:23:13Z (26m 33s) and 17:24:11Z→18:30:29Z (1h 06m 18s); operator pause 16:06:28Z→16:39:51Z (33m 23s, `execution.paused`/`resumed`). The lane could not use its own fix because the installed CLI is prebuilt from main (memory: `installed-cctl-build-skew-masks-branch-behavior`); the fix landed on main as `836161822` at 18:24Z and the run resumed six minutes later. Two defects compounded: question 1's recommended option was worded in Alex's voice ("I will update the running CC/CLI…"), so Alex answered "I authorize you to apply the fix to the main branch"; the agent then refused (entry 3187, quoting the CC system-prompt rule "Stay within your worktree — CC manages merging, dev servers, and session lifecycle") and asked again, costing $0.95 and a second wait. The refusal followed a real rule, but that rule should have been stated in the first question. Fix: [config] session names are now encoded (landed); [engine/template] ask-option text must name the actor and state hard boundaries the lane will not cross; [planning-skill] live-certification contexts should include a "dev-server reachable" preflight task. Aligns with §3.1 (pre-flight environment probe).

3. **`claude-capture` needed 4 iterations because the implementer replaced an SDK seam it had not read** — evidence: transcript `fa4394e7` entry 1286 (05:41:06Z) writes a custom `spawnClaudeCodeProcess` having read only the `.d.ts` signature; the SDK's default `spawnLocalProcess` body is first opened at entry 3719 (06:22:01Z, turn 3). Validator findings 2 (stderr never drained) and 3 (exit event before stderr close) are literally "the default spawner did X; yours doesn't"; finding 4 (stopped capture ignores diagnostics) is the same classification family. Cost: iterations 2–4 $13.73 implementer + ≈$3.5 validator, 31 minutes on the critical path. The validator (read-only, no test commands) was right every round and only over-broad on finding 4 (5 of 7 new cases already passed before the fix). Fix: [steering] `.kiro/steering/agent-backends.md`: replacing an SDK callback requires reading the default and listing each behavior it provided, with a test per behavior; [engine/profile] ask the reviewer to enumerate the whole family of a race once found instead of one instance per round.

4. **Prompt bloat: the spec-ownership claims table is 69% of every implementer prompt and is re-sent on every follow-up in the same thread** — evidence: 20 prompt files total 1,112,190 bytes, of which 772,761 bytes are the identical 38.6 KB table (all 48 criteria for all 12 contexts); follow-ups are 78–90% table (`claude-capture` iteration-4-followup: 38,726 of 48,098 bytes). Validator prompts carry it too (35,708 of 79,002 bytes for `claude-capture`). The table is also a registered shared document (`spec-bindings/…/claims.md`). Fix: [engine] send the full table once per conversation and only the context's own claim rows thereafter; link the rest. Aligns with §3.4 (context-window budget).

5. **Validator diff scope was truncated in 12/12 contexts** — evidence: `diff_scope.computed` `truncated: true` everywhere, e.g. `live-codex` 31 of 31 files omitted (+11,193), `live-claude` 40/40, `ui-controls` 22/56; the `claude-capture` validator prompt holds 4.7 KB of diff against 10.5 KB of implementer task self-reports. Validators compensated by reading the worktree (every verdict says "read-only inspection"), so quality held, but the prompt budget is spent on the wrong content. Fix: [engine] exclude evidence artifacts (`docs/reports/**/*.json`, screenshots) and rank source files first; [engine] diff-scoped validation (§2.5).

6. **Live probe harness bugs were discovered by burning live provider runs** — evidence: transcript `94975535` (`live-claude`) 40 commands invoking `run-checkpoint-handoff.sh`, 19 with nonzero exit; the deep-read attributes 10 of the 19 to harness defects (grader expecting the full memory index every follow-up, unsupported `effort` param, auto-naming consuming generation slots, an extra `backend` field rejected by the queue schema, an empty HTTP 405 body breaking JSON parsing) and 8 to real product findings preserved as failures; the daemon-restart case alone took five attempts (15:33–15:56Z). `live-codex` repeated the pattern at smaller scale (25 invocations, 9 nonzero, mostly probe verdict codes). Fix: [planning-skill] put a fake-backend dry-run of the harness (arg wiring, request schemas, response parsing) as its own task before any "certify" task; [template] budget live runs explicitly.

7. **Sub-agent fan-out inside Codex implementers multiplied orientation cost** — evidence: `live-claude` ran three threads (root, `harness`, `failures`); `thread/tokenUsage/updated` totals 79.3 M input tokens (78.1 M cached), 229 k output, of which the two sub-threads account for 41.2 M; 13 paths were read by two or more threads. `live-codex` ran four threads. This is the cost driver for the two most expensive conversations ($48.78, $31.51). Fix: [config/profile] give sub-agents a shared orientation digest instead of re-reading `AGENTS.md`/skills per thread; consider a per-context sub-agent budget.

8. **Native Codex compaction happened 12 times across 8 conversations** (4 in `live-claude`, 2 in `live-codex`, 1 each in five others) — evidence: `contextCompaction` items. Each cost ≈2 minutes of re-orientation (re-reading `AGENTS.md`, re-running `--help`); one lost detail (a wrong shared-doc payload filename at `94975535` entry 6381) was self-recovered. No dropped deliverable was found. The extractor does not detect Codex compaction. Fix: [engine/audit] count `contextCompaction` items in the transcript scan.

9. **15,229 lines of evidence JSON and 40 screenshots were committed under `docs/reports/checkpoint-handoff/`** — evidence: `git show --numstat c3a19709` (`codex-evidence.json` 8,983, `claude-evidence.json` 3,362, `verification-evidence.json` 2,884). These are required by the `*-evidence` acceptance criteria, so they are deliverables, not debris; but they are 42% of the publish diff and the reason every validator diff was truncated. Decision for Alex: whether hash-bound evidence belongs in git or in a registered artifact store.

10. **Extractor misreports on this run** (engine/audit, all corrected in this report):
    - `hung_turn` ×3 (3h 40m "excluded from agent work") are real single-turn Codex iterations with continuous activity: `capture-contracts-storage` 04:00–05:08Z (max internal gap 304 s), `live-claude` 14:30–16:00Z (116 s), `release-verification` 19:05–20:06Z (71 s). The detector treats "turn start with no next workflow-log record for >60 min" as hung; Codex iterations write no intermediate records. The prior audit (2026-09-09) already flagged hung-time accuracy.
    - Human wait reported as 0 s and both questions as "never resolved": the engine emits `graph-workflow-user-input-pending` but no `-resolved` event (none exist in the whole DB), so the pairing fails; `iterations.jsonl` has `user_input.waiting`/`wait_exit` pairs that would give the answer. The operator pause window is likewise `unexplained`.
    - Validator cost "$36.42" double counts: usage is emitted on both `graph-workflow-validation-specialist-result` and `graph-workflow-validation-result` for the same round; the de-duplicated Codex validator spend is $22.14.

## Every NO-GO: was the acceptance criterion wrong?

| Context (round) | Finding | AC judgement |
| --- | --- | --- |
| `capture-contracts-storage` (r1) | submitted metadata accepted without `startedAt`/bound mode; `seed_budget` omission breaks identical freeze retry | AC `durable-handoff-record` / `capture-transition-fences` were right; genuine repository defects, reproduced in real SQLite before the fix |
| `claude-capture` (r1) | pending hook suppression reported settled; custom spawner drops stderr | AC `preclose-hook-control` / `claude-settlement` right; both genuine (old code returned with the control request pending; stderr never drained) |
| `claude-capture` (r2) | exit event precedes stderr close | genuine and subtle; the round-2 test waited on `close` and masked it |
| `claude-capture` (r3) | stopped capture ignores diagnostics collected during cleanup | genuine for deadline/cancel; over-broad for the other five stop kinds |
| `codex-capture` (r1) | activity matcher misses `local_shell_call`/`tool_search_call`/`image_generation_call`; rejected transcript writes become settled omissions | AC `native-activity-outcomes` / `codex-settlement` right; implementer reproduced all three variants |
| `capture-recovery` (r1) | cancellation reason replaced by `capture_continuation_lost`; reconcile reclassifies cancelled candidates | AC `terminal-candidate-outcome` right; red reproduction `vrun-462fa81b` / `vrun-a42081c7` |

No NO-GO enforced a wrong or ambiguous criterion. The validator profile's "verify the cited evidence proves it" instruction is doing its job with read-only inspection alone.

## Outcome quality (what validators could not judge)

- The candidate is mechanically complete and gate-green (final registered format/typecheck/seams/lint/full-test runs passed; the initial full suite failed 3 of 2,100 files, all fixed and re-run).
- **Semantic retention failed in all eight backend×scope comparison cells**: all four Codex runs lose direct recall of `shard-07` by cycle 3; Claude session/project runs lose the scheduler identifier and shard, with the project-off run inferring capture restrictions from the `.handoff` worktree name (`verification.md` §Retention). The seeds come from the production Claude compaction path, so this is a generation-quality finding shared by both backends, which the reports state but do not draw out.
- `release-verification` rated `comparison-quality` as "Complete observations, mixed quality" and `baseline-continuation` as "Supported after remediation" (a real defect fixed in-context: Claude ordinary close returned before native child collection). Both verdicts are consistent with the evidence read for this audit.
- Self-report spot-checks: the "twelve completed checkpoint cycles" and "100 artifact hashes" claims in the `live-codex` GO map to 17 run records and the hash index in `codex-evidence.json`; the `claude-capture` "accepted finding, red reproduction" claims are confirmed in the transcript (entries 2660→2766, 3681→3787, 4475).

## Cost

| Conversation (context) | sdk turns | agent min | cost $ | commands | nonzero exit | compactions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `94975535` live-claude | 1 | 90.6 | 48.78 | 602 | 73 | 4 |
| `b92191a3` release-verification | 1 | 61.5 | 35.67 | 286 | 27 | 1 |
| `fa4394e7` claude-capture | 4 | 64.9 | 34.42 | 230 | 39 | 1 |
| `d2ef0886` live-codex | 3 | 46.3 | 31.51 | 373 | 46 | 2 |
| `ee6ea14d` capture-contracts-storage | 2 | 74.2 | 29.23 | 167 | 27 | 1 |
| `606248a2` capture-lifecycle | 1 | 37.1 | 21.09 | 166 | 29 | 1 |
| `fab395f0` ui-controls | 1 | 23.2 | 20.51 | 184 | 25 | 0 |
| `4673805c` codex-capture | 2 | 40.5 | 19.92 | 125 | 29 | 1 |
| `eedab665` capture-recovery | 2 | 28.2 | 18.72 | 140 | 19 | 0 |
| `60ea4451` receipts-http | 1 | 22.0 | 18.20 | 167 | 32 | 0 |
| `fd0712bc` evidence-seed | 1 | 24.8 | 14.45 | 100 | 19 | 0 |
| `44335d09` cli-controls | 1 | 17.6 | 11.56 | 80 | 14 | 0 |
| `1f6d8330` live-codex (aborted by pause) | 1 | 0.1 | 0.00 | 0 | 0 | 0 |
| **Implementers** | | **530.9** | **304.05** | **2,620** | **379 (14%)** | **12** |

- Recorded implementer total $309.81; transcript-corrected $304.05 (`cli-controls` row inflated: $14.52 recorded vs $11.56).
- Codex validators $22.14 (de-duplicated `validation-result` usage; 17 rounds; the `claude-capture` validator alone $4.65 over 4 rounds). The Claude `general-reviewer` for `release-verification` (`cad0b41d`) has no usage or cost row — the total is a floor.
- **Run total ≈ $326 (floor).**
- Retry spend after NO-GOs: $24.14 implementer (`claude-capture` $13.73, `capture-recovery` $4.27, `codex-capture` $3.63, `capture-contracts-storage` $2.51) — 8% of implementer spend for ten real fixes. Avoidable share: ≈$9–11 of `claude-capture` (rounds 2–3 trace to the unread SDK seam) and $0.95 for the `live-codex` refusal turn.
- Of the 379 nonzero-exit commands, the deep-reads classify the large majority as deliberate TDD red runs, probe verdict codes (1 = semantic fail, 2 = incomplete) and fixture-typing typecheck failures fixed in one edit; genuine usage errors were small (three `cctl validate run format -- <paths>` refusals, one shared-doc path outside `.cc/graph-workflow-docs`, ~13 glob misses).
- Token driver: `live-claude` alone processed 79.3 M input tokens (98.5% cached) over ≈734 steps at ≈120 k context per step; the claims-table bloat (item 4) and per-thread re-orientation (item 7) set that per-step baseline.

## Time

| Component | Duration | Share of 16h 57m |
| --- | ---: | ---: |
| Halt recovery (Codex usage limit, operator) | 4h 53m | 29% |
| Operator pause (16:06–16:39Z) | 33m | 3% |
| User questions in `live-codex` (2) | 1h 33m | 9% |
| Implementer agent time on the critical path (8h 51m summed; `evidence-seed` 25m and `codex-capture` 41m overlapped) | ≈7h 46m | 46% |
| Context validator rounds on the critical path | ≈1h 00m | 6% |
| Script gate `test` for `release-verification` (20:06–20:26Z) | 20m | 2% |
| Join validations (`capture-lifecycle` join 22m, final publish 21.5m) | 44m | 4% |
| Residual orchestration | ≈8m | 1% |

- Longest single iterations: `live-claude` 1h 36m (one turn, three threads), `capture-contracts-storage` 1h 13m, `release-verification` 1h 30m (61m agent + 29m gate/validators). These are the three the extractor mislabels as hung.
- Parallelism left on the table: after `capture-lifecycle`, `capture-recovery` → `receipts-http` → `cli-controls` → `ui-controls` ran strictly in series (2h 28m, 07:44–09:30Z incl. validation) on one lane; `receipts-http` and `cli-controls` own disjoint paths and could have forked. The two live certifications (`live-claude` 1h 36m, `live-codex` ≈50m active) were intentionally serial because `live-codex` consumes the harness `live-claude` builds; splitting "build harness" from "certify Claude" would let Codex certification start ≈1h earlier.
- Validation compute on the critical path (≈2h 04m) is legitimate but 44m of it is two full-project join validations; §6.2 (tiered validation) applies.

## Recommendations

| Priority / owner | Change | Evidence in this run | Existing proposal |
| --- | --- | --- | --- |
| P1 [engine] | Quota/rate-limit halt class: on a usage-limit exception, wait until `resetsAt` or fall back to the other configured validator engine instead of three 4-second retries; warn when `account/rateLimits/updated.usedPercent` crosses a threshold | friction 1 (4h 53m) | §3.2 failure taxonomy |
| P1 [engine/template] | Ask-question contract: options name the actor; the lane's hard boundaries (no main edits, no CC restart) are stated in the question; an explicit user direction in `cc-question-answers` satisfies the AGENTS.md carve-out or the template says why it cannot | friction 2 (1h 33m + $0.95) | §3.8 steering channel |
| P1 [engine] | Send the spec-ownership claims table once per conversation (seed) and only the context's own rows on follow-ups; drop it from validator prompts in favour of the `claims.md` shared doc | friction 4 (69% of 1.1 MB) | §3.4 context budget |
| P2 [steering] | `agent-backends.md`: replacing an SDK callback/seam requires reading the default implementation and testing each behavior it provided | friction 3 (3 rounds, ≈$16, 31m) | §1.6 shared rubric |
| P2 [engine] | Validator diff scope: exclude evidence artifacts and rank source first so the inline budget is not consumed by JSON | friction 5 (12/12 truncated) | §2.5 diff-scoped validation |
| P2 [planning-skill] | Live certification contexts: (a) a harness dry-run task with a fake backend before any live cycle; (b) a dev-server/CLI preflight task; (c) split "build harness" from "certify" so the second backend can start earlier | frictions 2, 6, time | §3.1 pre-flight probe, §5.1 ownership |
| P2 [engine/audit] | Extractor: derive turn activity from the transcript before declaring `hung_turn`; pair `user_input.waiting`/`wait_exit` from `iterations.jsonl` for human wait; classify `execution.paused` windows; de-duplicate validator usage across the two result events; count `contextCompaction` items | friction 10 | prior audit 2026-09-09 P2 |
| P3 [config/profile] | Sub-agent orientation digest for Codex implementers; per-context sub-agent budget | friction 7 (41 M of 79 M tokens) | §6.1 token budgets |
| P3 [decision] | Where hash-bound evidence JSON lives (git vs registered artifacts) | friction 9 (15 k lines) | — |

Not recommended: proving TDD order to validators (the run shows red-first without it), or adding validator command access — read-only inspection found ten real defects at ≈$1.30 per round.
