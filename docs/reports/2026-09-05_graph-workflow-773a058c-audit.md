# Workflow audit: ticket #80 delivery, execution 773a058c

Written 2026-09-05. Execution: `773a058c-2e00-48fd-bd39-aa6182049bb9`. Scope: native-SDD planning simplification, design steps 1 to 3. Governing sources: [session charter](../../.cc/session-alignment/charter.md), [decided design](../designs/ticket80-native-sdd-planning-simplification.md), and [consolidated retrospective](2026-09-03_graph-workflow-planning-retrospective.md).

## Verdict

The delivery completed, and its scratch-instance verification demonstrates the intended managed-plan authoring, launch, pause/resume, and abandon/reopen behavior. Final verification found and repaired three gaps before accepting the integrated work. Preserve that verification context, its authority to add tasks, and its explicit baseline policy.

This execution is **not a before/after benchmark of planning under the delivered tooling**. Its recorded origin is an ordinary saved template, definition `4ceb1362-cbfd-4d06-b04e-d6a714f31ee6` revision 2. It implemented the tooling and telemetry during the run. The planner's transcript predates those changes, and its post-run message explicitly says the managing CC instance had not been rebuilt. S1–S3 exercised the changes on a scratch source server; they establish behavior, not a measured reduction in real planning cost.

The run reinforces the next instruction changes. Consecutive engine reviews found two instances of the same cross-route ownership problem. The telemetry review caught an unwired production launch emitter despite passing unit coverage. The final implementer converted its own discoveries into tasks and fixed them. None of this requires expanding the current work into #109 or adding lexical lints.

## Evidence and measurement boundary

This audit used read-only `cctl` exports and repository objects within the assigned worktree. Mechanical extraction preceded qualitative reading. It followed the local [workflow-audit method](../../.claude/skills/graph-workflow-audit/SKILL.md) and the consolidated retrospective's extraction-before-judgment discipline. The full audit extractor would directly read the live config directory outside this worktree; that access was not used. `cctl logs` offers offline file analysis, not a server-side execution-ledger export.

Primary evidence opened:

| Handle | Evidence and retrieval |
|---|---|
| E1 | Live full projection: `cctl workflow status 773a058c-2e00-48fd-bd39-aa6182049bb9 --full --json`. Snapshot SHA-256 `45301140b9522a0fb9d863e1abfe71f6af5033e523767b3d6cd8696248548197`; 954,205 bytes. Contains launch document, final definition, context/task states, current review artifacts, lane state, joins, and timestamps. |
| E2 | Captured primary SQLite query and output: `cctl conversation read 613a1183-e439-44b6-b4fd-b6415a703d62 --seq-range 3186:3188 --include-tools full`. Groups `graph-workflow-validation-result` events by context; counts failures from `event_json.pass`. Also shows five live-edit events and no rows for the queried halt/repair/breaker types. |
| E3 | Planning, launch, and lifecycle summary: `cctl conversation read dd6cf868-2605-4c0f-9c05-c9873f639991 --outline`; narrow to `3260:3295`, `4289:4307`, or `4347:4348`. The last window contains raw lifecycle event counts, including one execution start/completion and no matched halt/repair/circuit events. |
| E4 | Engine retry contracts: `cctl conversation read 6eed696e-d9f5-400d-a634-d957177004d2 --message 0`, then `--message 2`. Includes actual validator findings and the rotated predecessor's handoff. |
| E5 | Telemetry retry contract: `cctl conversation read 4fb6c5e2-53ad-4b60-a6bf-e91ab42da728 --message 0`. Includes the production reachability findings and original task instructions. |
| E6 | Final verification raw tools: `cctl conversation read 9c17192c-8641-4842-bffa-24ce945e6513 --seq-range 290:358 --include-tools full` for S1; `521:534` for S2; `540:580` for S3; `615:685` for reproductions; `830:882` for final gates and rationale rendering. |
| E7 | Guidance review: `cctl conversation read 0f541796-fc25-42c8-93b7-e44d2e618dd7 --message 2`; its outline also identifies the later typecheck catching an accidental test-file truncation. |

Exports and the mechanical tally are in `.cc/temp/audit-773a058c/`; `summarize.py` recomputes `counts.json`. These are session scratch evidence, not durable report dependencies. The commands and source handles above permit retrieval again. The first large final-transcript export was truncated; narrow follow-up windows were used for the cited tail evidence. A transcript-rendered SQL result is a preserved primary query result, not a fresh direct database query. E1 independently corroborates all eleven context round totals and final passes.

## Corrected run accounting

The implementation summary's **20 rounds / 11 failed** is an arithmetic error. E2 actually lists **21 rounds / 10 failed**: engine `4/3`, seven contexts `2/1`, and three contexts `1/0`. E1's final `validationRound.seq` values sum to 21 and retain eleven passing final cohorts.

| Context | Criteria records | Final tasks | Stored implementer iterations | Validation rounds | Failed |
|---|---:|---:|---:|---:|---:|
| engine-pause-before-provisioning | 4 | 3 | 4 | 4 | 3 |
| issue-locators | 4 | 3 | 2 | 2 | 1 |
| managed-replace | 9 | 5 | 2 | 1 | 0 |
| charter-seed-and-check | 6 | 4 | 3 | 2 | 1 |
| validate-definition-preflight | 7 | 4 | 1 | 1 | 0 |
| execution-identity | 7 | 5 | 3 | 2 | 1 |
| receipt-tokens-and-outline | 6 | 4 | 2 | 2 | 1 |
| hint-chain-and-ledger | 5 | 4 | 3 | 2 | 1 |
| planning-telemetry | 6 | 4 | 2 | 2 | 1 |
| guidance-routing | 6 | 4 | 2 | 2 | 1 |
| final-verification | 8 | 10 | 1 | 1 | 0 |
| **Total** | **68** | **50** | **25** | **21** | **10** |

- **Completion:** 11/11 contexts and 50/50 final tasks complete; 47 tasks in the launch document, with three added during final verification.
- **Retry distribution:** 8/11 contexts had a failed round; 10/21 rounds failed (47.6%). The context with the most failures has four criteria; the context with the most criteria has nine and passed its only round. Record count again does not explain retry concentration.
- **Wall clock:** 2026-09-04 02:12:30.231Z to 12:33:56.523Z: **10h 21m 26.292s**. This is elapsed execution time, not agent labor.
- **Lanes:** five authored worktree lanes: `engine`, `locators`, `gate`, `identity`, `integration`; the session lane is additional. The design's “two lanes” describes the two sources of final publication, not the execution's lane count.
- **Joins:** four succeeded. Three have retained conflict-resolution records. The final publish resolved 17 file entries and took 22m 41.060s from join creation to completion; that duration includes the entire join, not just conflict resolution. E1 does not establish how much of that conflict set came from shared ancestry versus competing edits.
- **Intervention:** five live edits in E2; no plan-repair rounds in E1 and no matching halt/repair/breaker events in E2/E3. Their absence is supported by recorded queries, rather than inferred from a cleared final `haltReason`.

The earlier consolidated sample records 76 failed validations out of 130. This run's lower fraction is descriptive only: feature scope, staffing, plan quality, and verification policy differ, and the tooling was being built during this run.

## Did steps 1 to 3 work?

| Delivered behavior | Opened evidence | Assessment |
|---|---|---|
| Managed drafts accept an ordinary authored plan and preserve server-owned fields | E6 S1: bare preflight shows charter findings and `claims: 0 of 3`; authored preflight shows `propose: nothing refuses` and `claims: 3 of 3`; replace succeeds at revision 2; the full definition re-read retains origin, approval policy, and locked regions. | Demonstrated on the scratch source server. The scenario still authored the claims required by the decided steps 1–3 scope. |
| Receipt sequence reaches propose, sign-off, and launch using the workflow execution id | E6 S1: propose points to sign-off, sign-off points to start, and start names `6daf4bef-f5e7-44d6-9747-6a31f72f7208`; status accepts that id. | Demonstrated. |
| Pause before provisioning resumes into initial dispatch | E6 S2: execution `e844046a-1c8f-4317-b10a-1da2accc5ecb` starts at 11:09:32.681Z, pauses at 11:09:32.723Z, and fences the old loop out. No lane creation precedes that pause in the quoted lifecycle. Resume at 11:10:06.459Z is followed by `scheduler.ready_set`, `lane.created`, and `parallel.context_started`; status is running without a halt. | Demonstrated for the required ordering. Earlier race misses were discarded; this was not a claim based on a pause after provisioning. |
| Abandon retires the attempt and open reseeds from the launched candidate | E6 S3: abandoned workflow execution and attempt are re-read from scratch SQLite; the subsequent delta-seeded attempt retains three claims and the authored charter. Passing the internal spec row id is refused with the workflow id to use. | Demonstrated with durable re-reads. |
| Refusal rationale survives the user-facing renderer | E6: live preflight initially dropped the supplied rationale. Added task `render-managed-preflight-why-lines` reproduces it with an assertion failure at seq 685; seq 849 shows a `why:` line beneath each charter finding. | Final verification found and closed a real end-to-end gap. |
| Planning telemetry has real production emitters | E5 initially finds missing caller identity, discarded located record ids, and a launch emitter with no production caller. E1's final telemetry review confirms those paths and all five event contracts after repair. Current emitter catalogue is in `.kiro/steering/logs.md`. | Production reachability was explicitly reviewed. **This audit has no complete per-run planning-event stream or planning-cost denominator. Missing event counts are unavailable, not zero.** |

The managing instance's deployed state at the time of this audit is not the evidence for these historical scenarios. The final transcript identifies the lane-local scratch configuration and matching source server/CLI build. This avoids the existing trap in which `cctl dev ensure` from a lane points to a session server that lacks the lane's changes.

## Findings and owners

### A1. Enumerate sibling defects once the ownership failure is known

E4's first opened retry says the provisioning mutex was module-local even though Next.js route handlers use separate module graphs. Its next retry says the execution logger registry has the same ownership error: start registers a logger that pause cannot see, silently dropping `execution.paused`. The first fix's cross-module test separated start from resume but invoked pause through the start module, leaving the sibling untested.

These are two related findings discovered in successive rounds of the same candidate lineage. The observed evidence supports enumerating all relevant route-owned registries and start/pause/resume instances when the first ownership defect is found. It does not prove a dollar amount the stronger contract would have saved, and it does not imply validators should invent unrelated scope.

**Owner:** validator role contract (R3), with the existing context criteria as the boundary. Proceed with the requested full-class instruction. The older memory incidents remain the broader evidence for the rule.

### A2. Premise verification must reach the production caller

E5's task instructions prescribe caller identity “from the request scope the way neighbouring log lines do.” The implementation used ambient trace context, but those routes have no conversation-id parameter. Another task points at `delivery-plan-service.recordLaunch`, which had no non-test caller; actual launch records the transition in `execution-start-attachment.ts`. Passing builder and service tests therefore did not prove either runtime claim.

The reviewer returned the conversation-identity, located-id, and launch-reachability findings together; the context passed the next round. Preserve that breadth. This is useful evidence for opening the exact record, transition, and production caller behind a premise. It is not evidence that this run had an impossible provider-state criterion or needs another lexical lint.

**Owners:** planning skill and review feasibility lens (R2); implementation tests own producer-to-consumer behavior. A source citation should substantiate the claim, not merely name a nearby module.

### A3. Per-context cheap gates and final remediation already worked here

All 11 contexts in E1 carry `typecheck` and `seams`; final verification also carries `lint` and `test`. E7's outline records typecheck catching an accidental truncation that deleted pre-existing tests. Final verification's full test run exposed two touched architecture failures, and its live exercise exposed dropped why-lines. It added and completed exactly three tasks instead of recording those defects as residuals.

The final full run at E6 seq 839 has **3 failed, 27,592 passed, 8 skipped tests across 1,844 files**. The three retained failures were explicitly classified as pre-existing; the final context did not claim an unconditionally green full suite. Its retained review accepted that authored baseline policy.

**Owners:** planning defaults and final-verification guidance (R5); implementer role contract (R3). Preserve context-sized gates, a final integration check, and ownership of discovered in-scope defects. This run supports those mechanisms, not a claim that cheap gates alone cover architecture or live behavior.

The baseline policy needs one qualification before reuse: this plan treated an unchanged failing test and unchanged subject file as sufficient evidence. The transcript shows that diff check, not a baseline rerun. It is useful evidence for the two direct configuration assertions, but not a universal causal test; the Tailwind collision test also scans generated utilities and CSS. Guidance should require a captured baseline or concrete causal evidence, and an escalation policy for unresolved attribution. Do not teach “untouched files means no regression” as a general exemption.

### A4. Keep task-boundary rationale separate from unsupported occupancy claims

E4 proves at least one engine conversation rotated: the retry prompt carries the previous conversation's context-limit handoff. E1 reports a 250,000-token limit and final Claude occupancy measurements, including `execution-identity` at 250,562 with rotation requested. These final measurements are not historical peaks. Two implementer contexts use Codex and mark limit evaluation unsupported; their large processed-token counters cannot be interpreted as occupancy.

**Owners:** planning skill task-grain rationale (R4); remaining rotation enforcement and historical audit metrics belong to R10/R11. The older memory run's 391k peak remains the quantitative evidence for task grain. This audit does not manufacture a new peak or rotation count from a final snapshot.

### A5. Documentation needs checked lifecycle claims and one sequence owner

E7's actual review catches a wrong instruction that reopening advances the pinned spec revision; production preserves the pin, and the supported sequence is abandon then open. It also catches pointer documents restating partial launch sequences and omitting preflight. Those were corrected before the context passed.

**Owners:** owning planning reference and its documentation contract tests. Preserve source-backed wrong-model corrections and pointers to one owning sequence. The upstream-input, skill-resolution, and lane-visibility changes requested now remain earned by the prior reports; this run adds no independent measurement of those three misunderstandings. When carrying a historical explanation forward, verify its current implementation rather than treating the retrospective as a specification.

## Cost, limitations, and disposition

The eleven retained final review artifacts report a combined **$43.778679** in `usage.costUsd`. That is an artifact subtotal with explicitly partial coverage, **not the execution cost**. Implementer conversation costs, rotated-out conversations, previous review-call costs, scratch agents, and planning/review costs were not completely exported. No per-context retry dollar attribution, token-cost savings, agent-time total, planning-call count, or human-wait total is claimed.

The available evidence is sufficient to close the bounded workflow audit and sharpen the already-earned instruction changes. It is insufficient to say the new tooling reduced planning cost or refusal frequency. A subsequent managed-spec planning run on a rebuilt instance can supply that comparison: retain the caller conversation id, definition/attempt identities, deployment revision, and a complete planning window, then aggregate the five catalogued event types with counts distinguished from distinct issue codes. **Owner:** the next planning audit and R11 tooling, rather than the current prompt/docs change set.

Keep #109 held. Proceed with R2/R3 and the R4/R5/R7 documentation work. Preserve validators, source-backed review, cheap per-context gates, and final live verification with explicit remediation and baseline ownership. Correct future summaries to 21 validations / 10 failures and five authored worktree lanes; the earlier report files are not modified by this audit.
