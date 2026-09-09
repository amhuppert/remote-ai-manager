# Workflow audit — CC checkpoint compaction and history zoom

Execution `66d46f3f-ee11-4c6a-82d6-7931886cc950` · native spec `cc-checkpoint-compaction`, revision 3 · audited 2026-09-09.

## Verdict

The workflow produced a substantial, credibly verified Claude checkpoint implementation in both conversation scopes, but completion depended on repeated corrective reviews and a final integration pass that still found important defects. It completed **11 contexts and 32 tasks in 36h 47m**, with **$735.24 of accounted workflow-agent cost**, plus separately launched provider probes and unpriced failed validator attempts. At the audited publish commit, Codex certification remains unfinished and its checkpoint capability is disabled; the final code also retains a raw-reference logging defect and the durable evidence contains a disproved statement. The highest-leverage improvement is to make completion depend on one authoritative outcome receipt and tests through the actual production interfaces, so an agent cannot substitute a favorable submetric or fixture for the required behavior.

This is a completed execution, not proof of a delivered release. At audit time `cctl spec status cc-checkpoint-compaction --full` says the workflow lane completed and awaits the session's delivering merge. The current native coverage projection is 0/48; this audit uses the pinned execution acceptance criteria and actual evidence rather than treating that projection as a test result.

## Scope and evidence

Read-only inspection covered the archived execution, deterministic audit extraction, iteration/decision/lifecycle logs, all validation verdicts, selected implementer and validator transcripts, the pinned spec and source plan, and the final published diff at `563c86480859620048457dec7d089f866f9651a6`. This audit changed no feature code, workflow execution state, approvals, or backend capabilities and ran no new live probes. Separate uncommitted follow-up edits appeared in the workspace during the audit, including Codex enablement work; they are excluded. Code and capability conclusions describe the published commit, not those later edits.

The accompanying [telemetry artifact](2026-09-09-cc-checkpoint-compaction.telemetry.json) contains corrected conversation costs, context tables, exact timing intervals, transcript line coordinates for all eight disputed hung flags, and measurement limits. Reproduce the initial extraction with:

```sh
bun run workflow:audit -- --execution 66d46f3f-ee11-4c6a-82d6-7931886cc950 --json
cctl workflow status 66d46f3f-ee11-4c6a-82d6-7931886cc950 --full --json
cctl spec status cc-checkpoint-compaction --full
```

Primary-source aliases used below:

- **W**: `/Users/alex/Library/Application Support/cc/workflow-logs/66d46f3f-ee11-4c6a-82d6-7931886cc950/`. `W/<context>/…` abbreviates its `contexts/<context>/…` subtree. JSONL citations are physical line numbers unless explicitly marked `seq`.
- **T(id)**: `/Users/alex/Library/Application Support/cc/transcripts/<id>.jsonl`.
- **S**: `/Users/alex/Library/Application Support/cc/workflow-docs/66d46f3f-ee11-4c6a-82d6-7931886cc950/.cc/graph-workflow-docs/checkpoint/checkpoint-ui-browser-evidence.md`.
- **Release transcript**: T(`2a503470-4c47-4e8e-bc17-ba40525e279d`).
- **Repository paths** refer to the audited session checkout. Historical lane paths found in telemetry were not used to inspect another worktree. SQLite inspection used `mode=ro`, never the state-store opener.

## What worked — preserve these

1. **Independent validation prevented incorrect acceptance.** There were 21 NO-GO verdicts and 11 final GOs. Reviews caught stale attempt writes, premature readiness, snapshot resurrection, incorrect HTTP assumptions, and certification despite a failed independent answer. The sampled findings were concrete failures within the assigned contract; no evidence justified discarding one of these NO-GOs as a bad-AC dispute. The round-by-round assessment below covers all 21 verdicts. Source: extractor `contexts[].validations`, backed by W context validation logs.

2. **The final production pass earned its cost.** It reproduced readiness publication before durability, stale retired-reference restoration, the real session composer returning `409 NOT_RUNNING` during maintenance, and queue/cache/reconnect defects. Actual RED results occur in release transcript lines 118, 166, 414, 586, 757 and 791; subsequent code and browser results establish repairs. Earlier context GOs did not make this pass redundant.

3. **The backend gate eventually held.** After the validator rejected a failed Codex identifier outcome, the implementer disabled Codex instead of presenting structural continuity as full certification. Final descriptors enable Claude and disable Codex/Cursor. Claude evidence covers three cycles, queued delivery, fresh references, seed acceptance/omission, memory delivery, and independent answers. Sources: W/backend-continuation-probes/validation.jsonl:31; `src/lib/agent-backends/{claude,codex,cursor}/descriptor.ts`; release verification report.

4. **Source hierarchy and named downstream owners reduced spec disputes.** The charter pins revision 3, names four invariants, and identifies downstream consumers. For example, maintenance explicitly defers restart and delivery, while UI defers enabled-provider browser journeys to release verification. Reviewers honored those boundaries and judged outcomes rather than demanding proof of test-writing order. Sources: archived `workingDefinition.executionContexts[].acceptanceCriteria`, W/checkpoint-ui/prompts/iteration-1.md:232–236, and the validation summaries.

5. **Orchestration preserved work and integrated cleanly.** The run had no execution halt or merge conflict, one brief operator pause/resume, and one final publish join. A single dependency-ordered lane avoided shared-manager merge contention. Retained validator transcripts, structured verdicts, scoped source packs, and 18 registered shared documents made this audit possible. “No halts” does not mean “no infrastructure incident”: two validator attempts stalled and retried internally.

6. **The final checks and browser claims have primary support.** Release transcript:1065 contains terminal full-scope format/lint/typecheck/seams/test verdicts; :1086 verifies the ticket attachment by byte/hash equality. The validator independently read patch/evidence hashes and verdicts at W/release-verification/validators/general/validation-transcript.jsonl, seq 12 and 17. Browser tools exercised both scopes, original tool/image retrieval, reconnect, keyboard destinations and accessibility checks; these were not only handoff claims.

## Friction ranked by quality impact

### 1. Backend certification used a favorable partial result — blocked, but the misleading result remains

The implementer enabled both backends even though the Codex session fixture answered only **8/9 independent expectations**. It treated the missing identifier's presence in the seed as sufficient, although the contract required the continued agent to recover the correct answer. The next conversation inherited the claim that all four fixtures passed. The second validator NO-GO correctly prevented that rollout.

This was aided by a real interface defect: `scripts/probes/checkpoint-continuation/probe.ts:847` sets `outcome: "passed"` from structural failures alone, while `scripts/probes/checkpoint-continuation.ts:160` separately requires all answers to pass for exit zero. The saved report and process exit can therefore disagree about certification. That split remains in the final code.

Evidence: T(`36719c9c-80c8-42c6-bfdf-71e689118a33`):2857 enables both descriptors; :2861 prints the Codex 8/9 outcome; :2862 writes certification claims. T(`76bf2273-f437-4562-90bb-f7baa9119c25`):151 repeats the inherited claim. W/backend-continuation-probes/validators/general/validation-transcript.jsonl:41 rejects it; the later GO explicitly retains Codex as unfinished.

**Recommendation [engine/probe]:** derive one certification verdict from structural checks, independent outcomes, workload enforcement and evidence identity. Keep structural results as a named sub-result. Make the enablement evidence and release report consume that verdict. **[planning-skill]:** preflight the complete independent oracle and contradictory prompt instructions before spending on live batches. Preserve independent backend disablement when certification fails.

### 2. Lifecycle correctness emerged through serial patching and late integration

Storage, maintenance, restart and first-turn delivery repeatedly passed local tests before reviewers found gaps in cross-module authority. Examples include generic outcomes bypassing evidence-bearing methods, an external turn remaining active after maintenance released ordinary admission, reconciliation ownership preventing explicit recovery, and queue acknowledgement preceding the checkpoint acceptance receipt.

The final integration context then found additional production defects after those contexts had received GO: early ready publication, stale reference restoration and a real composer admission failure. The remaining work was concentrated at producer/consumer boundaries, not missing high-level requirements. Splitting maintenance/restart/delivery reduced individual task scope but left tests insufficiently representative of the assembled lifecycle.

Evidence: W/checkpoint-maintenance validation rounds at 01:35:04 and 02:24:27 UTC; W/checkpoint-restart rounds at 03:58:15, 04:57:08 and 05:38:37; W/checkpoint-delivery rounds at 07:42:13 and 08:28:49. Release transcript:118,166,381,414 demonstrates downstream failures. `docs/reports/checkpoint-compaction/production-review.md` records the corresponding final repairs.

**Recommendation [template/definition]:** assign executable transition scenarios to each boundary: manager plus real temporary repository, settlement receipts plus publication, and route plus maintenance admission. Exercise both event orders, stale attempts, thrown writes/closes and post-failure admission through the actual owner. Keep the final integration context as defense in depth. This supports existing improvement-report §2.4; it does not justify reducing independent review.

### 3. UI fixtures proved an invented interface and omitted real destinations — repaired

UI evidence initially populated the query cache directly rather than serving the production endpoint. The UI expected JSON where the real complete-entry endpoint returned text/plain, so screenshots could look correct while the actual reader failed. The accompanying claim that scoped outline/range HTTP routes did not exist was false. Later fixes addressed additional GET/SSE list-membership and cursor-advancement races; those were distinct defects rather than repeated enforcement of an already-satisfied criterion.

Evidence: T(`95895d9a-de19-4d2b-992d-87281274bce2`):1487 justifies cache-seeded evidence; W/checkpoint-ui/validators/general/validation-transcript.jsonl:54 identifies the mismatch and existing `/read` routes; the implementer reproduces missing tool content at :2479 and verifies its repair at :2492. Final browser navigation has primary results in T(`488239b8-8a30-4df6-9be8-a95a0ef0ea6a`):367–450.

**Recommendation [planning-skill/template]:** put verification fixtures at the production HTTP boundary and include a production-host route through each destination before broad UI validation. Cache seeding can support visual states, but it cannot establish transport compatibility or reachability. Preserve keyboard and actual browser checks.

### 4. Corrected shared evidence was overwritten, and the durable copy is still wrong

The UI agent corrected its evidence locally several times. Each later iteration could restore the earlier centrally registered copy. The final stored document **still says outline/range endpoints do not exist** at S:124, even though implementation and later evidence disproved that statement.

Registration is visible at T(`4ba19c55-b549-4859-8c6d-b65d50d14871`):757–758 and T(`95895d9a-de19-4d2b-992d-87281274bce2`):1635–1636. No later executed shared-doc upsert appears in the five UI transcripts. T(`6ce952d3-a28c-41dd-868d-f1afcc08a9eb`):2088 and T(`488239b8-8a30-4df6-9be8-a95a0ef0ea6a`):14 show the stale content returning.

The repository explains the observed behavior: `iteration-orchestrator.ts:4657–4665` materializes documents before each worktree iteration; `document-materialization.ts:91–99` reads central content and writes it over the local file. `shared-documents.ts:253–265` and `shared-document-store.ts:97–104` capture edited bytes only through registration. This is a stale stored snapshot overwriting unregistered edits, not evidence of random filesystem corruption.

**Recommendation [engine]:** detect divergence from the last materialized content before overwriting, and require an explicit content update/conflict resolution rather than silently losing edits. **[tool guidance]:** make `shared-doc upsert` content-capture semantics clear and report the stored content hash. **[template]:** persist a sanitized evidence bundle before lane cleanup; the release report currently points to ignored lane-local `.cc/temp` artifacts absent from the final session checkout. Hashes and transcript records survive, but do not themselves preserve every original artifact.

### 5. Raw-reference logging was partly fixed; an error-message alias still leaks — remains

The final change replaces named Codex `threadId` log fields with a digest. However, `src/lib/agent-backends/codex/conversation-runtime.ts:495` interpolates `this.threadId` into `acc.failure.message`, and the stale-resume logger at :498–501 emits that string through `error`. The added `provider-ref-logging.arch.test.ts:27` only matches fields literally named `threadId` or `sessionId`, so it cannot detect this path.

This is a pre-existing error-message construction left behind by this run's logging remediation, not a newly introduced interpolation. It contradicts the outcome claimed by the new no-reference guard. Codex checkpoint admission is disabled, but ordinary Codex stale-resume logging still reaches the path. This audit establishes the flow statically; it did not trigger a live failure or reproduce raw references in the report.

**Recommendation [implementation/test]:** log a bounded classified failure and the safe digest; use a controlled sentinel reference in a captured-log behavior test across stale-resume/error paths. Keep the source-name check as a narrow check if useful, but do not treat it as proof that no raw reference can enter logs.

### 6. Validation waiting and repeated broad runs consumed calendar time

The logs record **26 explicit background waits totaling 6h 02m 59s**, including **four waits that each reached the 30-minute timeout**. These include test-completion monitors, not just useful work. The CLI timeout even records an empty `stillInFlightTaskIds` list, which makes a generic “a test was still running” explanation insufficient.

Evidence: W/checkpoint-cli/iterations.jsonl:42; W/checkpoint-ui/iterations.jsonl:24,58; W/backend-continuation-probes/iterations.jsonl:63. T(`66aa3199-7e4e-4178-86f1-d9a0f8082dfe`):1096,2340 shows file-polling background monitors; release transcript:1030–1063 shows repeated model reasoning while waiting for full tests.

Broad-run failures had mixed causes. UI evidence includes a 15-second source-audit timeout under heavy swap use and an isolated pass; this supports resource contention, not a failing assertion. A later release full-suite failure was genuinely introduced by the workflow: a type-asserted queue-route fixture omitted a new required dependency. It was corrected and the full suite passed. The final script gate and final join then ran validation again; those are safety checks, but potential reuse must be keyed to the precise candidate and required command set.

**Recommendation [engine/config]:** complete agent suspension from durable validation-job state, reconcile tracked monitors with terminal jobs, and account for background timeouts separately from model work. Bound heavy validation concurrency and avoid overlapping broad runs. Reuse a validation receipt only when its candidate identity and scope exactly match; otherwise rerun it. No dollar estimate is assigned to these waits because conversation cost is not phase-grained.

### 7. Two actual validator stalls were hidden by the headline detector

The history validator failed twice with `Task stalled: no backend activity for 1200000ms`, then returned a valid structured NO-GO on its third attempt. The context reached GO after later remediation. The two failed attempt windows total approximately **43m 27s**. These were infrastructure attempts, not NO-GO judgments or additional implementation defects.

Evidence: W/checkpoint-history/validation.jsonl:5–14; the third attempt starts at :15. The failed attempts have no usage-bearing review artifact in the durable incident records, so their spend is not established by the validator cost subtotal. The retained validator transcript does not recover the failed-attempt activity.

**Recommendation [engine/audit]:** retain attempt-level transcript/last-activity/usage information even on runner failure and report internal retries alongside execution halts. Preserve bounded retry and its successful recovery. Investigate the backend inactivity using this evidence; the available record does not establish its underlying cause.

### 8. The audit extractor misclassifies time, suppresses measurable windows, and mixes cost bases

Three corrections are necessary before using this run to change workflow policy:

- **All eight implementer hung flags are false as claims of an hour without activity.** `scripts/workflow-audit/core.ts:963–985` labels the interval between a turn-start log and the next iteration-log entry as hung solely because it exceeds an hour. It never checks intervening transcript activity. Every flagged interval contains recorded work; some also include explicit background waits. The release turn alone has 1,099 transcript entries and 436 tool calls. Its largest adjacent-record gap is 251.553 seconds at release transcript:271–272. The alleged 10h 30m “hung” total cannot be counted as downtime.
- **Codex validators suppress Claude implementer occupancy.** `core.ts:1350–1395` mixes lane states and rejects occupancy whenever any lane is Codex. In this run Claude completion records explicitly carry `occupancyMeasurable: true` and a 1,000,000-token window. Implementer-only peak readings include maintenance 593,870, restart 476,535, delivery 646,394 and UI 404,318. These exceed the 250,000 rotation target by 2.38×, 1.91×, 2.59× and 1.62× respectively, while staying below 70% of the measured provider window. Codex release occupancy remains unknown. Rotation-target overshoot is supported; hard-window pressure or silent compaction is not.
- **Context and lane costs remain on the raw database basis.** `core.ts:1480–1512` corrects the overall total from transcripts but aggregates `byContext`/`byLane` from uncorrected rows. UI therefore appears as $187.28 there, while its actual reconstructed conversation total is $134.10. This report recomputes every cost table from the same corrected basis. Validator cumulative usage is also lineage-corrected; summing its repeated snapshots would overcount.

**Recommendation [engine/audit]:** derive time from activity and explicit wait intervals, keep telemetry per lane/backend, and calculate total and breakdowns from the same cost rows. Add coverage for active long turns, terminal background waits, mixed Claude/Codex lanes, failed validator attempts and cumulative cost restarts. These changes should precede any conclusion that this workflow needs a more aggressive hung-agent policy.

## Cost

| Accounting component | USD | Basis |
| --- | ---: | --- |
| Implementation conversations | **683.46** | 36 reachable conversations; transcript lineage correction |
| Context validators | **51.78** | 32 usage-bearing verdicts; cumulative thread/restart correction |
| Accounted workflow-agent subtotal | **735.24** | Sum of the two rows |
| Separate provider probes and failed validator attempts | **Not fully accounted** | Isolated probe calls and missing failed-attempt usage are outside the subtotal |

The raw conversation rows total $774.24 and overstate the reconstructed conversation subtotal by **$90.79**. For example, T(`00b1bac6-4735-4292-86c8-ad70de4fc8a4`) is recorded as $79.00 but reconstructs to $39.50. Some rows undercount, so a blanket percentage correction would also be wrong. The numbers combine provider-reported prices and adapter estimates where applicable; they are operational accounting, not an invoice.

Validators represent about **7.0% of accounted workflow cost** and caught substantive errors. This run is evidence for improving first-pass implementation and evidence quality, not for dropping review to save money. The 21 NO-GOs contain 75 blocking-issue appearances; those appearances are not 75 distinct defects and must not be priced as equivalent units of waste.

### Per-context result

Elapsed columns run from each context's first to last recorded activity and include reviews and waits. Costs are implementation conversations only, never per-iteration allocations.

| Context | Tasks | Iterations | NO-GOs | Corrected USD | Context elapsed |
| --- | ---: | ---: | ---: | ---: | --- |
| `checkpoint-storage` | 3 | 5 | 2 | $55.75 | 3h 18m |
| `checkpoint-seed` | 2 | 2 | 1 | $24.20 | 1h 45m |
| `checkpoint-maintenance` | 3 | 6 | 2 | $76.81 | 3h 21m |
| `checkpoint-restart` | 2 | 6 | 3 | $52.00 | 2h 47m |
| `checkpoint-delivery` | 3 | 5 | 2 | $60.34 | 2h 53m |
| `checkpoint-history` | 3 | 3 | 2 | $29.32 | 2h 29m |
| `checkpoint-http` | 3 | 4 | 2 | $44.60 | 1h 49m |
| `checkpoint-cli` | 3 | 6 | 2 | $80.23 | 3h 57m |
| `checkpoint-ui` | 3 | 9 | 3 | $134.10 | 5h 41m |
| `backend-continuation-probes` | 3 | 7 | 2 | $66.49 | 5h 17m |
| `release-verification` | 4 | 1 | 0 | $59.62 | 2h 46m |

The largest individual conversation is release verification at **$59.62**. UI conversations at **$41.43** and **$39.50** are the next outliers. Their transcripts contain substantial implementation and verification as well as avoidable fixture/revalidation work; charging their entire cost to waste would be unsupported.

Avoidable spend is visible in late harness assertion design, contradictory probe instructions, repeated stale-document repair, broad-test reruns and model polling. It cannot be isolated reliably in dollars: conversations span several iterations and failed probe batches are not all in the central accounting. Backend T(`08a31227-aa57-4e21-a0da-b5d225a4dc46`):983,1194 shows two intentional cancellations to change the harness. Those are not the engine killing valid work. Similarly, one UI monitor's termination is proved without proving its server-side validation job was killed. The extractor's five background-kill records are not five lost jobs.

## Time and scheduling

The [validation timing supplement](2026-09-09-cc-checkpoint-compaction-validation-time.md) measures each registered command and scheduler delay from durable job timestamps. It expands the explicit background-wait accounting below; those waits are only one part of validation activity.

The run lasted **2026-09-07 18:47:35.797 UTC → 2026-09-09 07:34:54.541 UTC**, or **36h 47m 18.744s**.

| Recorded time category | Duration | Interpretation |
| --- | ---: | --- |
| Implementation turn envelopes | 32h 29m 18s | Includes tools, in-turn tests, and the explicit background waits below |
| Of those, explicit background waits | 6h 02m 59s | 26 waits; subset of implementation envelopes |
| Envelopes less those explicit waits | 26h 26m 18s | Still includes tool execution and in-turn waits; not model inference time |
| Context script gates | 1h 18m 46s | Includes the interrupted storage gate |
| Validator attempt envelopes | 2h 16m 10s | Includes approximately 43m 27s in two failed infrastructure attempts |
| Configured human approval/question waits | 0 | No such gates recorded |
| Operator pause | 1m 16s | Separate pause/resume, not a configured human gate |
| Final publish join | 37m 44s | Validation/landing included; no conflict |
| Residual outside these envelopes | About 4m 03s | Startup, bookkeeping and unallocated gaps; not established idle waste |

Sources: paired W iteration/validation events in the telemetry artifact; W/lifecycle.jsonl:10–13 for the pause and :88–92 for the join. The categories are event envelopes, not CPU measurements. Background waits and failed-validator time are subsets, so adding every table row would double-count them.

Four background waits reached the 30-minute limit, consuming about two hours within the six-hour wait total. These need investigation and a better completion contract; the evidence does not justify treating every remaining minute of tests or probes as removable overhead. There is no supported 10.5-hour dead-agent incident in these implementer transcripts.

The graph deliberately serialized all 11 contexts on `checkpoint-delivery` through a linear chain of 10 edges. The source implementation plan requires P1–P7 in order. The scheduler followed that plan; this was not a scheduler failure to use available concurrency. A future plan could prepare the independent corpus early and, after HTTP/CLI contracts stabilize, consider separate UI and backend certification work where actual file ownership is disjoint. Shared manager/lifecycle changes should retain serial ownership. No numerical parallel speedup is claimed without an ownership and resource-contention check.

## Work-product assessment and limits

The final publish contains **268 files, +52,592/−1,287 lines**, including **105 test files with 27,093 added lines**. No `.cc/` or log scratch file appears in the publish diff. The size is consistent with a broad feature spanning persistence, actor lifecycle, history, APIs, CLI, UI and real provider probes; a large test footprint alone does not establish behavior at module boundaries.

The final integration source/config patch matches the reviewed release patch after accounting for one landing-time test-only difference: `src/lib/workflows/conversation/boundaries.arch.test.ts` adds a 30,000ms timeout to an existing source audit, with no assertion change. `git diff 154963aaa 563c8648` shows this sole difference. Do not describe it as unreviewed production drift, but preserve landing validation separately from the earlier report hash.

The release report honestly discloses remaining verification limits: synthetic recovery controls were focused but not activated; queue retry was not chosen; no real browser crash was induced; browser memory was empty, with nonempty memory/notepad coverage coming from certification and integration tests. Image verification establishes explicit recovery and byte fidelity, not autonomous discovery of which historical image to retrieve. Codex's failed independent answer and Cursor's unverified capability remain unfinished backend obligations. Ticket items 3, 5 and 7 remain out of scope.

This audit accepts the evidence for the enabled Claude path while identifying the surviving logging and evidence-contract defects above. It is a bounded execution audit and final-diff review, not an exhaustive product certification or a fresh live recovery run.

## Recommendations and relationship to existing proposals

| Priority / owner | Concrete next change | Existing improvement-report relationship |
| --- | --- | --- |
| P1 [implementation/probe] | One certification verdict covering structural and independent outcomes; sentinel-based logging tests and sanitized error fields | §1.4 typed deliverables and §2.3 reality-check lens; apply locally, not as another broad review layer |
| P1 [template/definition] | Production-interface tests for lifecycle settlement/publication, route admission and actual HTTP reader contracts | §2.4 integration sweep and §1.4 traceability; preserve the final sweep already present |
| P1 [engine] | Detect shared-document divergence before materialization; explicit stored-hash update; retain sanitized final evidence outside disposable lane scratch | §1.5 durable completion reports; fixes a demonstrated overwrite rather than adding a second registry |
| P2 [engine/audit] | Correct hung-time, mixed-backend occupancy, cost breakdown and failed-attempt coverage | §3.2 failure taxonomy, §3.4 context telemetry and §3.6 transcript retention; successful retention exists, failed attempts remain a gap |
| P2 [engine/config] | Job-state-driven suspension and completion, resource-aware broad validation, candidate-bound receipt reuse | §6.2 validation economy; preserve necessary checks and reviewers |
| P3 [planning-skill] | Prepare oracle/fixture guards before live probes; test production destinations before UI evidence; only then consider disjoint parallel lanes | §2.7 planning checks and §5.1 ownership; current linear plan was intentional |

The historical improvement report's suggestion to prove TDD order (§1.4) should not be revived here: current validators correctly judged protected outcomes. Likewise, its review-cost rationale (§6.2) came from a run with mostly first-try GOs. This run has the opposite profile; independent review was valuable and inexpensive relative to implementation.

## Every NO-GO: was the acceptance criterion wrong?

These are dispositions of the recorded rounds, not claims that every individual remedy was optimal. Each row is supported by the context's `validation.jsonl`/validator transcript and corresponding task reopen record. The underlying source plan and pinned context AC assign the listed behavior to that context. No reviewed round established a conflicting or invalid AC.

| Context / round | UTC verdict time | Assessment and protected outcome |
| --- | --- | --- |
| Storage 1 | Sep 7 21:04:41 | Accept: stale delivery/recovery writes could alter authority; attempt/supersession validation was required. |
| Storage 2 | Sep 7 21:39:48 | Accept: generic outcomes bypassed freeze, retirement and delivery evidence; phase legality alone was insufficient. |
| Seed 1 | Sep 7 23:09:52 | Accept: source hash omitted later input; citations lacked actual membership; exact byte bound and complete recovery commands were wrong. |
| Maintenance 1 | Sep 8 01:35:04 | Accept: dormant reservations, drains, external starts, cancellation and failed writes crossed the maintenance boundary. |
| Maintenance 2 | Sep 8 02:24:27 | Accept: overlapping drain ownership, freeze invalidation, external-turn release and failed disposal remained distinct failures. |
| Restart 1 | Sep 8 03:58:15 | Accept: stale hydration restored retired references; recovery gate and reconcile ownership were incorrect. |
| Restart 2 | Sep 8 04:57:08 | Accept: thrown reconcile work failed to preserve safe retryable ownership. |
| Restart 3 | Sep 8 05:38:37 | Accept: retained unknown-delivery ownership permanently blocked explicitly permitted recovery. |
| Delivery 1 | Sep 8 07:42:13 | Accept: receipt order, assembled fingerprint, acknowledgement repair and close settlement could misattribute acceptance. |
| Delivery 2 | Sep 8 08:28:49 | Accept: archive failure lost observed acceptance; replacement delivery could use an earlier runtime reference. |
| History 1 | Sep 8 10:31:26 | Accept: partial-entry recovery, huge multiline export and image-path containment failed the original-evidence contract. |
| History 2 | Sep 8 11:06:17 | Accept: small excerpts lost handles and recovery commands inherited incompatible reader flags. |
| HTTP 1 | Sep 8 12:20:30 | Accept: free-form failure logs could disclose content and missing counters became unmarked partial totals. |
| HTTP 2 | Sep 8 12:53:14 | Accept: publication failure still emitted unrestricted exception text. |
| CLI 1 | Sep 8 14:28:47 | Accept: exit/error, byte-budget, omission follow-up, mutation-scope and recovery/help guarantees were violated. |
| CLI 2 | Sep 8 15:46:30 | Accept: JSON spills were invalid, primary recovery facts were lost and wrong-scope advice changed the requested action. |
| UI 1 | Sep 8 18:33:44 | Accept: missing host action, stale eligibility/reconnect, queue/recovery controls and earlier evidence navigation were owned here. |
| UI 2 | Sep 8 20:43:31 | Accept: invented reader transport, absent destination proof and GET/SSE cache races were actual integration gaps. |
| UI 3 | Sep 8 22:30:16 | Accept: concurrent list omissions, pagination cursors and archive entry selection still failed. |
| Backend probes 1 | Sep 9 01:24:55 | Accept: post-hoc call ceiling, missing available cost, unprotected logs and decorative images did not prove the assigned outcomes. |
| Backend probes 2 | Sep 9 03:04:59 | Accept: failed independent Codex answer could not be waived by structural success; old ordinary logs still retained raw references. |

Release verification received its first context-validator GO, but only after the implementer repaired defects within that same iteration. “First-try GO” here measures the review cycle, not a defect-free incoming implementation.
