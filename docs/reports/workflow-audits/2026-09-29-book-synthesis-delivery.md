# Workflow audit — book-synthesis delivery

Execution `62c5ad5a-4c6a-4ab5-ac53-3091a5007cca` · project `book-ingest` · session `envelope` · audited 2026-09-29.

**Audit focus:** Alex clarified that the objective is to improve Command Center. [Command Center lessons](2026-09-29-book-synthesis-command-center-lessons.md) is the primary assessment and prioritized follow-up. The execution/product analysis below supplies supporting evidence; application repair suggestions are not the scope of the requested follow-up.

## Verdict

The workflow delivered a working CLI with credible ingestion, command-surface, and principal-journey evidence. It completed all 23 contexts and published 137 files, but its evaluation remains incomplete: the judge parser rejected replies containing quality findings, leaving misleading zero-error totals alongside explicitly unjudged answers. Workflow-agent usage cost was **$212.29**, and saved nested evaluation answers bring observed usage cost to **at least $292.94**; wall time was **16h 03m**, including a **9h 06m runtime admission deadlock**. The most valuable next change is to repair and re-run judging of the retained answers, with a delivery rule that treats a broken measurement instrument as incomplete evaluation.

These dollar amounts are provider-reported usage-equivalent costs, not verified incremental subscription charges. This audit reviews the published git objects and recorded runtime evidence; it does not claim a fresh execution of the product.

## What worked — preserve these

- **A thin path preceded breadth.** The charter required the §8.3 excerpt journey first, and the authored dependency chain followed that sequence. The final validator independently exercised the bundled CLI on a temporary fixture. Its observed replay matched the documented evidence apart from build identity and one shell-quoting difference in a continuation command; the documentation heading was subsequently corrected. This is stronger evidence than a task-completion claim. [G: `docs/delivery/principal-journey.md`; T: `c727a9ce…`, lines 956–957, 1739.]
- **Integration verification found real wiring defects.** Final verification exercised production command handlers, the refusal inventory, and text/JSON disclosure checks. It repaired invalid-config handling, missing package information in `doctor`, and the `finalize` → `overview` hint. Recorded full tests, typecheck, and build all passed. The validator retrieved the actual validation receipts. [G: `test/surface-matrix.test.ts`; T: `c727a9ce…`, lines 779, 1739; run IDs in Evidence below.]
- **The full-book ingestion was substantive.** The ingest-6 validator ran the CLI and read the package through SQL, checking completed units, statement attribution, source evidence, and relationship integrity. This supports completion of the ingestion contract, while remaining a bounded semantic sample rather than an independent reread of every statement. [T: `02becdec…`, lines 252–253, 351–354, 501–502, 655–656.]
- **Review usually converged without rejection.** 22 of 23 contexts received GO on their first validation. The single NO-GO caught a real loss of reproducibility in recorded CLI arguments and was repaired. Both joins merged without conflicts; the extractor found no compactions, killed background tasks, or scratch-file debris in the publish diff. First GO did not always mean the context was finished: advisory-driven rereviews are accounted for below. [Extractor; W: `evaluation-harness/validation.jsonl`.]
- **Agents respected the user's actual constraints.** When the prescribed `--bare` flag proved incompatible with subscription authentication, the implementer asked and followed Alex's explicit subscription requirement. The validator accepted that authorized substitution instead of mechanically enforcing stale wording. [T: `9283f16f…`, lines 3469–3483; `eb292614…`, first verdict.]
- **The handoff preserved uncomfortable results.** The trial note explicitly declines to claim an advantage over source search, and evaluation NOTES preserves the judge failures. Keep that candor, while fixing the generated report so its headline counts carry the same qualification. [G: `docs/delivery/trial-note.md`; `eval/runs/2026-09-25/NOTES.md`.]

## Friction, ranked by quality impact

### 1. Finding-bearing judge replies disappeared from error totals

`eval/judge.ts:64–69` requires arrays of strings, but its prompt does not specify the array element representation. The live judge returned objects describing claims and missing evidence. All eight unjudged records retain such replies: four proposed-system answers and four summary-only answers. `eval/run.ts:311–314` substitutes empty error arrays when parsing fails, and `eval/report.ts` sums them into zeros.

This is selective loss of quality evidence, not merely random missing scores. The rejected replies contain unsupported-negative and missing-limit allegations. They also say `correct: true`, so this audit does **not** reclassify them as wrong core answers or automatically accept their allegations. It concludes that the reported zeros cannot establish absence of those defects. [G: `eval/runs/2026-09-25/results.jsonl`, lines 12, 43, 56, 61, 77, 132, 148, 180.]

The implementer and validator recognized the problem. Evaluation-run nevertheless passed because its acceptance contract required a recorded run/report without numeric thresholds, while harness changes belonged upstream. Documenting the defect was useful; treating it as only a deferred harness advisory let an incomplete measurement pass through delivery. No minimum accuracy threshold is needed to require a valid measurement.

**Recommendation [template/definition]:** give downstream evaluation an explicit return path to the harness owner. Generate an unambiguous output contract, exercise a live nonempty finding, preserve every judge attempt, and rejudge the retained answers. A report with unresolved judging failures should prominently say the evaluation is incomplete, including beside per-class totals.

### 2. Contract completion did not demonstrate a product advantage

The published raw results yield:

| Condition | Correct / judged | Unjudged | Tool calls | Processed input tokens¹ | Answer usage cost |
|---|---:|---:|---:|---:|---:|
| Proposed system | 41 / 41 | 4 | 175 | 2,137,131 | $4.29 |
| Summary only | 33 / 41 | 4 | 0 | 2,723,658 | $22.06 |
| Source search | 44 / 45 | 0 | 158 | 1,035,171 | $2.61 |
| Full context | 45 / 45 | 0 | 0 | 6,388,460 | $51.29 |

¹ Input + cache creation + cache read, summed from the answer records. Costs exclude judging. Source: G, `eval/runs/2026-09-25/results.jsonl:1–180`; independently recomputed in the companion telemetry.

The proposed system used more tool calls and processed input than source search, and missing judgments prevent a clean quality comparison. Its 12 citation-check failures also remain in the saved results. NOTES attributes those failures to quote typography; this audit did not reopen the source package to independently re-resolve that attribution.

Index recall needs the correct denominator: **83/181 in-scope Index terms matched an entity name or alias (45.9%)**; **108/110 page references belonging to those matched terms had occurrences (98.2%)**. The page figure excludes unmatched terms. Some misses are naming/alias mismatches, not missing knowledge, so the report does not equate all missed terms with absent semantics. [G: `eval/runs/2026-09-25/index-report.md:1–4`; `eval/index-report.ts:72–89`.]

Isolation evidence is similarly bounded. The smoke checks establish offered tools and allowed/denied commands, but “residual context identical” compares sanitized initialization metadata, not the complete hidden system prompt. Smoke self-reports mention account context. Fresh per-call directories also warrant a controlled cache check before attributing all cost differences to the retrieval conditions. [G: `eval/claude.ts:116,245–265`; `eval/runs/2026-09-25/smoke/smoke.json`.]

**Recommendation [planning-skill]:** distinguish delivery completion, measurement validity, and demonstrated product benefit. Require a working instrument and honest denominators without inventing an unapproved performance threshold. Diagnose unmatched index terms and compare the corrected evaluation before choosing product improvements.

### 3. A displaced external turn blocked admission overnight

An external Claude turn opened between CC admitting a follow-up and delivering its prompt. The follow-up completed, but the external turn remained unsettled. The next advisory response waited for admission from **04:50:09.805Z until operator intervention at 13:56:01Z**. No implementer work occurred during that interval. The query session's idle close did not unblock it.

The decisive sequence in `logs/global.log` is:

| UTC timestamp | Event | Line at audit time |
|---|---|---:|
| 04:44:29.124 | CC follow-up admitted | 80513 |
| 04:44:29.213 | External turn started | 80544 |
| 04:44:29.586 | CC runtime turn started | 80661 |
| 04:50:09.805 | Advisory response requested | 81471 |
| 13:56:01.515 | Waiting advisory turn finally admitted | 86213 |

The transcript independently jumps from the completed follow-up to the advisory prompt after intervention. Lifecycle records show operator pause/resume and recovery of evaluation-run. This was infrastructure wait, not a nine-hour human approval or an expensive thinking turn. [T: `d998fd8d…`, lines 310–311; W: `lifecycle.jsonl:142–143`.]

**Recommendation [engine]:** retain and verify deployment of the existing fix, rather than implementing another one. Commit `5dba7bbad95db158473739fb635e1e951b015343` (“Complete a displaced Claude external turn so later turns are admitted”) already exists in this checkout; `query-session.ts` now supersedes the displaced turn before replacing it. Its author timestamp follows this recovery. This audit did not establish the currently deployed server revision.

### 4. Optional edits repeatedly reopened already-passing work

The run produced **36 validation verdicts: 35 GO and one NO-GO**. Beyond the first verdict for each context, one round repaired the NO-GO and **12 rounds recertified optional edits after GO**. Those 12 rounds cost **$16.21 in validator usage alone**, with implementer edits and script checks additional. This is the measured cost of rereview, not an assertion that all of it was waste.

Evaluation-run illustrates the tail: four GO verdicts, three intervening edits to NOTES, and repeated deferral of the same harness-owned advisories. The first note made the evaluation much more honest. Subsequent passes added a provider-context caveat and corrected a sentence about role self-reports. The original run artifacts stayed unchanged. [W: `evaluation-run/validation.jsonl:13,26,39`; T: `d998fd8d…`, lines 334, 358–386; `282833ba…`, lines 1650, 1676.]

The first evaluation validator also started in an empty scratch directory without an explicit candidate root in its prompt and had to locate the work. Other sampled validators likewise located the frozen core checkout. This produced real verification but added orientation work. Current backend code intentionally uses scratch as cwd to restrict writes; the missing readable-root briefing, not the empty cwd itself, is the defect. [T: `282833ba…`, lines 45–194; `c727a9ce…`, lines 14–18, 103–104.]

**Recommendation [engine]:** keep stable advisory identities and dispositions across recertification, provide the exact readable candidate root, and focus rereviews on changed evidence. **[planning-skill]:** batch optional documentation improvements once. Preserve recertification for substantive changes; avoid repeatedly soliciting new prose polish after GO.

### 5. Default telemetry misstates both the bill and the waiting time

The extractor corrects the total from **$360.17 recorded to $212.29**, but its `byLane` and `byContext` fields still contain the uncorrected amounts. The table below was recomputed from conversation transcript totals. Its empty confidence array also misses nested CLI usage, which appears in product artifacts rather than CC conversation rows.

Likewise, the extractor reports zero human wait and two unresolved questions. Both were answered: extraction-full-book waited **1m 43.210s**, and evaluation-harness **3m 24.382s**. The paired `user_input.waiting` / `wait_exit` records establish **5m 07.592s** total. The overnight admission wedge is separate from these questions. [W: those contexts' `iterations.jsonl:6–7`.]

**Recommendation [engine]:** use corrected costs consistently in every breakdown; include separately declared nested usage; pair question wait records; and identify admission waits instead of leaving this interval as unexplained dead air. These changes improve audit accuracy without changing the work-product verdict.

## Cost

| Scope | Corrected usage cost | Basis |
|---|---:|---|
| Implementer conversations | $89.96 | 23 transcript lineage totals |
| Context-validator conversations | $122.33 | 23 transcript lineage totals |
| Workflow-agent total | **$212.29** | 46 conversations |
| Full evaluation answering calls | $80.25 | 180 saved `cost_usd` fields |
| Two-question fixture answering calls | $0.41 | 8 saved `cost_usd` fields |
| Observed combined floor | **$292.94** | Unrounded sums before rounding |

Nested judge, smoke, and discarded probe-call costs are additional. The harness saves answer cost but not complete judge cost, and overwrites judge token usage on retry. An exact all-in total cannot be reconstructed from these artifacts. Subscription usage-equivalent dollars should not be presented as an invoice.

The most expensive corrected contexts were thin-path **$15.91**, evaluation-harness **$14.18**, and unit-lifecycle **$12.91**; their scope and evidence support legitimate implementation/review work. Evaluation-run was **$10.24**, including **$8.64** for its validator. Its three post-GO validator passes account for **$4.84** of the $16.21 rereview total. These phase amounts come from cumulative result differences at formatted-verdict boundaries; no conversation total was arbitrarily divided among iterations.

Workflow transcripts record approximately **0.415M uncached input, 7.782M cache-creation input, 196.721M cache-read input, and 2.065M output tokens**. These include helper models and exclude nested evaluation calls. They represent processed usage, not context occupancy. The companion telemetry records the counter method and source conversations.

## Time and scheduling

Run: **2026-09-24 22:23:51Z → 2026-09-25 14:26:55Z**.

| Measure | Duration | Interpretation |
|---|---:|---|
| Wall clock | 16h 03m 04s | Entire execution |
| Admission deadlock | 9h 05m 52s | Primary-source classification of extractor's largest unexplained gap |
| Wall clock excluding that gap | 6h 57m 12s | Still includes useful compute, checks, and short waits |
| Implementer iteration intervals | 3h 47m 15s | Extractor's “agent turns”; not all workflow labor |
| Context-validator intervals | 2h 53m 47s | Validator start → parsed-result records |
| Matched advisory responses | 17m 01s | Excludes the unmatched stalled attempt |
| Script-validator intervals | 4m 33s | Context gate records |
| Answered user questions | 5m 08s | Two wait/exit pairs |

These are overlapping interval sums, not an additive partition of wall time. Implementer iteration time includes the useful background evaluation wait; it excludes the validator and advisory phases shown separately. Operator pause→resume itself lasted about seven seconds and should not be confused with the preceding admission blockage.

The graph allowed scaffold and question-set to start together. Its remaining core contexts formed an explicitly authored serial chain; the engine did not silently serialize an otherwise parallel graph. Sequential ingestion on one package was an explicit operating constraint and should remain so. A better candidate for earlier parallel work is the harness/authentication/judge preflight against the fixture after the CLI contracts stabilize. Discovering subscription incompatibility and live judge shape before full-book ingestion would shorten the feedback path without introducing concurrent writes to the book package. No precise speedup is claimed.

## Recommended follow-up order

1. **[template/definition] Repair evaluation validity and rejudge saved answers.** Keep unknown results visible in every headline count and route harness defects back to their owner.
2. **[engine] Verify the existing admission fix is deployed.** The run directly demonstrates its failure mechanism; do not duplicate the implementation.
3. **[engine] Reduce advisory recertification churn and supply the candidate root.** Preserve substantive review while avoiding repeated disposition of unchanged advisories.
4. **[engine] Correct audit cost/wait accounting.** Carry corrected totals into breakdowns, expose nested usage gaps, and distinguish admission wait from human response time.
5. **[planning-skill] Front-load live evaluation feasibility and preserve bounded conclusions.** Check subscription auth, output shape, and cache behavior together; report matched-only index coverage explicitly.

The skill's suggested comparison document, `docs/reports/graph-workflow-improvement-report.md`, is absent from this checkout. Existing implementation was checked directly for the admission fix; no alignment with an unavailable proposal is asserted.

## Evidence and limits

- [Companion telemetry](2026-09-29-book-synthesis-delivery.telemetry.json) contains corrected per-conversation/context figures, token counters, rereview billing boundaries, evaluation tallies, wait events, and selected server events.
- Extractor: `bun run workflow:audit -- --execution 62c5ad5a-4c6a-4ab5-ac53-3091a5007cca --json`. The execution is archived and completed. Definition revision 7; 38 tasks across 23 contexts; publish `9373130d263242fee969a20ecc430a9cc5e8d588` (+17,748/−2).
- **G** means the published object above in book-ingest's git database. Retrieve from the assigned audit worktree with `git --git-dir=/Users/alex/github/book-ingest/.git show 9373130d:<path>`; no other checkout was entered or modified.
- **W** means `/Users/alex/Library/Application Support/cc/workflow-logs/62c5ad5a-4c6a-4ab5-ac53-3091a5007cca/`; context-relative references are under `contexts/`.
- **T** means `/Users/alex/Library/Application Support/cc/transcripts/<conversation-id>.jsonl`. Full IDs are in the companion telemetry; line numbers count physical newline-delimited JSON records. Server-log line numbers can change with rotation, so timestamps and event names are also recorded.
- Final validation receipts spot-checked in the validator transcript: test `vrun-2cca4234-e774-4d32-b827-63ec8e70de8f`, typecheck `vrun-b38a01ab-6ada-453c-a137-1263610a80d7`, build `vrun-cb1914ae-7539-45a1-bfe8-4e5a31f3c120`.
- The full book package was gitignored. Recorded CLI/SQL evidence verifies its existence and completion during validation; the published code commit alone does not certify the package bytes or their present location. This audit found no evidence of package loss and makes no such claim. A durable package receipt would strengthen reproducibility.
- All live telemetry was read-only. Only this report and its evidence artifact were added to the audit worktree; no engine or book-ingest fixes were applied.
