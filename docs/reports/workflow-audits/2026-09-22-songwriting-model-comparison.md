# Workflow audit — Songwriting Model Comparison (68ff0dcb-9bef-4971-b486-2a4cbe702c4f)

Execution `68ff0dcb` · template definition `b4c44125` rev 2 (project tier) · project `creative-ai`, session "Eval model songwriting" · audited 2026-09-22.

Sources: `bun run workflow:audit -- --execution 68ff0dcb…` (markdown and `--json`), `workflow-logs/68ff0dcb…/{_manifest.json,lifecycle.jsonl}` and `contexts/<id>/iterations.jsonl`, the archived execution row in `graph_workflow_archived_executions` (read-only; `contextOutputs` used as ground truth), the 13 conversation transcripts tallied with python3, the six Codex rollouts under `~/.codex/sessions/2026/09/22/` for per-turn token counts, `logs/global.log`, and read-only `git show 90a89c74` in `creative-ai` for the published files. No subagent deep-reads were used; every number below was derived directly from those sources.

## Verdict

The run did what it was designed to do, and the output can be trusted. Four writers produced songs in isolation, eight blind judges scored them, and the consolidator published a 15-file eval directory with a thorough report. I checked the published files against the engine's recorded outputs rather than against the consolidator's own copies. The lyrics are character-for-character exact in 4/4 songs, every judgment text fragment is verbatim in 8/8 files, all 8 weighted scores and the means, gaps, and tie rule recompute exactly, and the empty `misquotes` array holds up under an independent check. The wall clock was 23m 29s, almost all of it on one critical path (song-b → judge-b-astra → consolidated-report). Recorded cost is $17.06. That figure is itself a floor; the extractor's "transcript-corrected" $15.06 is wrong for this run (see Cost).

The most useful engine change keeps the two-turn capture and fixes both halves of it. Tell the work turn that its result is collected afterwards, and what it will be asked to report, so agents stop hunting for a submission path (34 blind help and ToolSearch calls). Run the format turn on the lane's live runtime so Codex keeps its prompt cache ($2.00 of mostly uncached format-turn spend here). On the eval-design side, which is out of scope for the engine, the rubric's hard-constraint cap needs a stated accuracy threshold: one interpretive split there produced the run's two largest judge disagreements (4 vs 9 twice) and decides the order of places 2–4. The decisions and fixes that followed this audit are listed under [Follow-up](#follow-up).

## Shape of the run

- **Graph**: 4 writers (`song-a..d`) → 8 judges (one Opus 5.5 and one GPT-6 Astra per song, each depending only on its song) → `consolidated-report` (depends on all 12). 20 edges, `maxConcurrency` 8, peak 7 in flight.
- **Writers**: Fable 5.1 (claude, effort high), Opus 5.5 (claude, high), GPT-6 Astra (codex, reasoning high), GPT-5.6 Sol (codex, high). **Judges**: Opus 5.5 effort xhigh, GPT-6 Astra reasoning xhigh. **Consolidator**: Opus 5.5 xhigh.
- **Placement**: the 12 writer and judge contexts ran `session`/`readOnly` with no lane (`read_only.completed_without_commit`). Only the consolidator got a lane (`songwriting-eval-report`, mode `full`), and that lane had one final-publish join.
- **Output schemas** on all 12 writer and judge contexts. Downstream contexts received upstream payloads as typed JSON under "Inputs from upstream".
- **Context validation disabled on all 13 contexts**; no script gate. In their place, the consolidator ran two deterministic checks: script-computed scores and a misquote audit. 47 acceptance criteria were declared but enforced by no validator.
- One seeded shared document (the rubric) plus the charter. The charter's `sourcesOfTruth.appliesTo` scoped the rubric to judges and the consolidator.

## What worked (preserve these)

- **Per-song pipelining with no scheduling dead air.** Each song's two judges started within 0.1 s of that song finishing (`lifecycle.jsonl`: song-d finished 20:29:27.857, judges started 20:29:27.894). The last judge finished at 20:38:47.330 and the consolidator started 1.4 s later. Critical path 23m 26s (song-b start → consolidator finish) vs wall clock 23m 29s: the engine added essentially nothing.
- **Isolation held everywhere.** No writer read, listed, or searched a repository file: the only writer tool calls were `cctl … --help`, a scratch-file `Write`, and `task complete`. Judges opened only the rubric, via `Read` or `cat`. Keyword scans of all 8 judgments for model names or other songs found only false positives ("the song does…"). Writer identity never reached a judge: judge seeds carry only `title`, `intendedSound`, `lyrics`.
- **Typed upstream payloads worked as designed.** All 12 output captures parsed as `raw_json` with `repaired: false`. The report seed was 110,365 characters, of which 92,717 were payload JSON the consolidator genuinely needed, and only 5,596 were schema field descriptions.
- **Deterministic arithmetic in place of LLM arithmetic.** The plan required a script for `scores.json` and a script-based misquote audit. Every figure I recomputed matched. Opus judges also ran their own quote and weight checks with python before submitting (e.g. `judge-a-opus` entry 2175, `judge-d-opus` entry 1969).
- **The consolidator verified its own numbers against the data.** Entry 2689 cross-checks every number in `report.md` against `scores.json` and then corrects one sentence (entry 2747). The report also surfaced the most important analytical finding on its own: the judges' different thresholds for "biblically accurate". Its self-preference section is correct, including the observation that the Opus judge ranked its own model last.
- **Charter scoping by `appliesTo`.** Writers saw an empty source-of-truth hierarchy; judges and the consolidator saw the rubric.
- **Cheap, correct merge gate.** creative-ai's `preMerge: ["test"]` scoped out correctly ("no changes under lyricvid/; skipping the pytest suite"), so the final-publish join took 581 ms. The publish contains exactly the 15 intended files and no scratch debris; `.cc/temp/` was confirmed ignored at entry 673.
- **No halts, no retries, no compaction, one errored tool call in the whole run.**

## Friction (ranked by quality impact)

1. **The rubric's hard-constraint cap has no threshold for "accuracy", so one judgment call decides places 2–4.**
   - Evidence: `scores.json` and report §4 show exactly two dimension splits of ≥3 points, both on `directionFidelity`, both Astra 4 vs Opus 9. In each case the Astra judge treated one line of poetic compression as a broken hard constraint ("No sun and no moon, for the Lamb is her lamp," against Rev 21:23; "And every mountain was gone." as merging 6:14 with 16:20) and applied the rubric's "Missing a hard constraint caps this dimension at 4." The Opus judge flagged the same lines and judged them non-doctrinal.
   - Impact: places 2–4 are separated by 0.23 and 0.25, and the report attributes "most of the spread among these three" to that cap.
   - Root cause: the direction's "biblically accurate" is a hard constraint with no stated tolerance, and the rubric's cap is a cliff (any breach → ≤4).
   - This is a plan and rubric defect, not a judge defect: both judges applied the text faithfully.
   - Fix [template/rubric]: define what breaks an accuracy constraint (e.g. "contradicts or invents a scriptural event" vs "compresses or paraphrases"). Require the judge to cite the verse contradicted. Consider a graded penalty in place of the cap.

2. **The consolidator re-typed all 12 upstream payloads by hand after an opaque `cctl` failure.**
   - Sequence: at entry 40 (20:39:05) it tried the deterministic route, `cctl workflow status --full --out .cc/temp/status-full.json`. That failed with `KERNEL_OUTPUT: Artifact delivery failed; optional detail omitted.` The server answered 200 in 5 ms (`global.log`), so the failure was client-side.
   - Cause: `cli-for-agents` resolves a relative `--out` inside the artifact directory `.cc/temp/cctl-artifacts/` (`node_modules/cli-for-agents/dist/internal/artifacts.js:47-55`; directory set in `src/cli/framework/artifact-policy.ts`). The target became `.cc/temp/cctl-artifacts/.cc/temp/status-full.json`, whose parent did not exist, and the reason was swallowed.
   - Fallback: the agent then issued 12 `Write` calls re-emitting the payload JSON from its prompt into `.cc/temp/inputs/*.json`. That is 92,729 characters, 20:39:49 → 20:43:28 (3m 39s on the critical path).
   - Risk: this bypasses the verbatim guarantee the plan was built around. Its later "verbatim" check (entry 745) compared the output against its own transcription, which is circular. It happened to be exact (verified above), but nothing in the run would have caught a slip.
   - No command exists to export upstream inputs: `cctl workflow output` is an unknown command (`judge-b-opus` entry 30).
   - Fix [cctl]: resolve relative `--out` against the cwd, or refuse with a message that names the artifact directory, and never drop the reason. Fix [engine]: materialize upstream payloads as JSON files in the context's scratch directory and name that path in "Inputs from upstream". Aligns with improvement report §1.4 ("downstream injection of the actual … upstream deliverables").

3. **Output-schema contexts are never told their output contract, so agents probe blind and the plan's instruction order can't be followed literally.**
   - Evidence: the seed prompt renders upstream schemas but not the context's own schema. `iteration-prompt.ts` has no section for it; the only mention is the plan author's "Deliver the judgment as this context's structured output, then complete task …".
   - Probing: 10 of 12 schema contexts spent 34 calls hunting for a submission mechanism (`cctl workflow --help`, `task complete --help`, `workflow live --help`, `cctl --help`, and 6 `ToolSearch` calls for "structured output"). Only the two Codex writers didn't probe.
   - Guessed fields: `judge-c-opus` reasoned "Without knowing the exact schema, I'll infer reasonable field names" (entry 1056). Several judges drafted `title` in place of `songTitle` or put dimensions at top level; the format turn reshaped them.
   - Unsatisfiable ordering: "deliver, then complete" can't happen, because the deliverable is the final message and that comes after the last tool call. All six Codex contexts called `task complete` before emitting their deliverable (song-d: complete at 20:27:43, lyric first emitted at 20:28:53). Their summaries claim verification of an artifact not yet emitted ("Verified key imagery and narrative order"). The Claude contexts wrote a scratch draft first.
   - Invisible constraints: judges couldn't see constraints like `strongestLines` minItems/maxItems 3 or rationale ≤1500 chars until the format turn. No capture needed repair this time.
   - Fix [engine]: render an "Output contract" section for schema contexts: the fields, their constraints, and "end your turn after completing the task; a follow-up turn collects the payload; there is no submission command." Fix [planning-skill]: until then, word output-schema tasks as "finish, complete the task, end your turn with the finished work."

4. **Format turns cost ≈7.5 minutes of agent time and $2.00+, and the Claude share is recorded nowhere.**
   - The design: after the tasks complete, the engine runs one format turn on the same conversation (`context-output-capture.ts`).
   - Time: summed format-turn time was 451 s across 12 contexts (second-rounded, `output_capture.started → captured`). Codex averaged 48 s, Claude 28 s. 74 s of it sat on the critical path (song-b 16 s, judge-b-astra 58 s).
   - Codex spend: the Codex format turns inherit the context's model selection (judges at reasoning `xhigh`; `context-output-capture-runner.ts:163`) and ran on a cold cache. 5 of 6 had `cached_input_tokens: 0`: 170,308 uncached input tokens and 8,012 output tokens in total (rollout `token_count` records). The Codex conversation rows exceed their transcript and `turn_end` totals by exactly $2.00 in aggregate; for `judge-a-astra` that is $0.43 on a $0.92 main turn. The format turn is the only other turn on those conversations and logs no cost, so the $2.00 is attributed to it by inference.
   - Claude spend: the six Claude format turns left no cost anywhere. DB rows equal the main-turn result exactly (e.g. song-a $1.53090375 in both), and the transcripts end with the format turn's JSON and no result entry.
   - Fix [engine]:
     - Validate the main turn's final message against the schema first, and fall back to the format turn only when it fails. With fix 3, most agents would end with conforming JSON.
     - Run the fallback format turn at minimum effort/reasoning.
     - Record format-turn usage for both backends: a transcript result entry, plus DB accrual for Claude.
   - This is a deliberate design (separate thinking from formatting), so the validate-first path keeps it as the fallback rather than removing it.

5. **The 47 acceptance criteria were unenforced, and the audit tooling reports that as success.**
   - With validation disabled, every context recorded a synthetic GO ("Context validation is not enabled"), and the extractor's `first_try_go` positive counts all 13 as "passed first try" (`scripts/workflow-audit/core.ts:2001-2005` only checks `validations.every(v => v.pass)`).
   - Disabling validators was a reasonable call for an eval: the deterministic checks covered the report's riskiest criteria, and I verified the rest by hand above (all held).
   - The gap: nothing covered the judge criteria "each rationale quotes a line word for word" or "single-song scope", or the writer criterion "lyrics-only". I checked those programmatically: 72/72 rationales contain a verbatim quote, and no writer lyric contains a non-label bracket or production note.
   - Fix [planning-skill]: when a plan disables context validation, move its checkable criteria into a script the consolidator runs, e.g. extend the misquote audit to rationales. Fix [extractor]: report validation-disabled contexts separately, not as first-try GO.

6. **Seed-prompt noise for read-only, non-code contexts.**
   - Unscoped rubric listing: the "Shared Documents" section listed the rubric to all four writers, even though the charter's `appliesTo` excluded them and the task forbade opening files. None read it, but it is an easy "teach to the test" leak in a blind eval.
   - Irrelevant sections, repeated in all 13 prompts: "Validation Commands: test (cost 2)", shared-doc and `task add` instructions, and an "Asking the User" section contradicting the task's "don't ask the user anything". `askUserQuestions.enabled: true` came from the defaults.
   - Code-centric reminder: every `task complete` returned "the context validator reviews this context next … confirm every capability you introduced is reachable through a production call path." There was no validator, and the contexts wrote no code.
   - Fix [engine]: scope the shared-document listing by the same `appliesTo` as the charter, and suppress the validator reminder when validation is disabled. Fix [template]: set `askUserQuestions.enabled: false` for writers and judges.

## Outcome quality (the work product)

**Verified against `contextOutputs`, not the consolidator's copies:**
- 4/4 song files contain the lyrics as exact substrings, with correct `intendedSound`.
- 8/8 judgment files contain every rationale, line, reason, fix direction, cliché, violation, and verdict verbatim.
- 8/8 weighted scores recompute from the rubric weights.
- Means (7.48 / 6.48 / 6.25 / 6.00), judge gaps (mean 0.52), and the tie-rule calls (only first place decisive) are correct.
- My normalized quote check also finds no misquotes.

The report meets all 11 of its criteria as written.

**What no validator could have caught (the eval's own limits):**
- **Convergence.** Three of four songs built their hook on Rev 1:19's "write what you see", and two share the exact title "Write What You See". All four `intendedSound` values specify 6/8 and a "weathered" voice. Isolated judging can't penalize cross-song sameness by design; originality came out 5–7 on every song. The report notes the shared hook but not the shared sound.
- **One song per model.** The report states the caveat plainly. With judge disagreement (mean 0.52) larger than the gaps among places 2–4, this run can only name the winner.
- **Writer effort didn't track rank.** Main-turn output tokens, including reasoning: Opus 5.5 40,044 (35,322 thinking) ranked 3rd; Fable 5.1 14,220 ranked 4th; GPT-6 Astra 5,468 in 2 API calls ranked 1st; GPT-5.6 Sol 2,731 ranked 2nd. The Codex writers made one pass despite "draft, critique, and revise."

## Cost

The recorded total is **$17.06** across 13 conversations. This is a floor: the six Claude format turns are unpriced.

| Role | Contexts | Recorded (DB) | Main turn only (transcript) |
|---|---|---:|---:|
| Writers | Fable $1.53, Opus $1.35, Astra $0.69, Sol $0.26 | $3.83 | $3.44 |
| Opus judges | a $1.38, b $0.93, c $1.21, d $1.16 | $4.68 | $4.68 |
| Astra judges | a $1.35, b $1.22, c $1.07, d $1.25 | $4.90 | $3.29 |
| Consolidator | — | $3.65 | $3.65 |
| **Total** | | **$17.06** | **$15.06** |

- **The extractor's "transcript-corrected" $15.06 is wrong for this run.** No row predates the accrual fix. The $2.00 difference is Codex format-turn spend that the DB recorded and the transcript did not, so "prefer the corrected total" subtracts real spend. It raised no `cost_mismatch` finding because each per-conversation delta ($0.12–$0.43) is below the $0.50 threshold (`core.ts:835`).
- **Avoidable spend:**
  - Codex format turns: $2.00, plus an unknown Claude share.
  - The consolidator's hand transcription: 92,729 characters, roughly 25–35% of that conversation's 92,441 output tokens at 3–4 characters per token. That is an estimate; the $ share can't be separated.
  - Re-authoring a 12,984-character scoring script that should be a checked-in tool.
  - Help probing: 34 calls, small.
- The consolidator is 21% of recorded spend; its seed is justified by the 92.7K characters of payload it has to read.

## Time

Wall clock 23m 29s · agent turns 1h 3m (13 contexts, overlapping) · human waits 0 · operator recovery 0 · unexplained gaps 0.

**Critical path:**

| Step | Duration | Breakdown |
|---|---:|---|
| song-b | 6m 28s | ≈5.5 min of reasoning before the first tool call (35,322 thinking tokens); 16 s format turn |
| judge-b-astra | 5m 2s | 58 s format turn |
| consolidated-report | 11m 54s | 51% of wall clock |

Consolidator breakdown:

| Task | Duration | Detail |
|---|---:|---|
| `save-eval-artifacts` | 6m 42s | 3m 39s hand transcription; ≈40 s writing the scoring script |
| `write-consolidated-report` | 5m 0s | — |

Nothing that could have run in parallel was serialized: judges were already pipelined per song, and the report depends on all eight judgments. The available savings are within stages:
- ≈3.5–4.5 min in the consolidator from file-materialized inputs plus a checked-in scoring and rendering script. This is an estimate.
- ≈74 s from skipping format turns on the critical path.

Together that is about a fifth of the wall clock.

## Audit-tooling gaps found (workflow:audit extractor)

- `first_try_go` counts validation-disabled contexts as first-try passes (friction 5).
- The transcript-corrected total treats DB > transcript as inflation. For output-capture format turns the direction is reversed on Codex, and Claude spend is missing from both sources. No confidence note warns about this (Cost).
- The `model` column is always "—": the parser reads `fields.model` (`core.ts:887`), but `iteration.started` records `modelId`.

## Recommendations

| # | Tag | Change | Addresses |
|---|---|---|---|
| 1 | [template] | Define the accuracy tolerance behind the hard-constraint cap in `songwriting-rubric.md` and require a cited contradicted verse (or grade the penalty). | Friction 1 |
| 2 | [engine] | Materialize upstream payloads as JSON files in the scratch directory and name the path in "Inputs from upstream". Aligns with improvement report §1.4. | Friction 2 |
| 3 | [cctl] | Keep `--out` artifact-directory-relative; make the refusal name the cause and `.cc/temp/cctl-artifacts/`, and state the path rules in `--out` help (cli-for-agents#1). | Friction 2 |
| 4 | [template] | Check in the scoring, misquote, and rendering script (e.g. under `evals/songwriting/`) so the consolidator runs it instead of writing a new one each run. Extend the audit to rationale quotes and writer lyrics-only checks. | Friction 2, 5 |
| 5 | [engine] | Keep the two-turn capture; tell the work turn that a follow-up turn collects its result and which fields it will report, with no shape or limits. | Friction 3 |
| 6 | [engine] | Run the format turn on the lane's live runtime so the request prefix, and the provider's prompt cache, survive. Record task-run cost in transcripts, and keep the Claude task runner's cost. (A one-turn mode for trivial contexts is deferred.) | Friction 4 |
| 7 | [planning-skill] | For output-schema contexts, word the task as "finish, complete the task, end your turn with the finished work". For validation-disabled plans, move checkable criteria into a consolidator script. | Friction 3, 5 |
| 8 | [engine] | Scope the shared-document listing by `appliesTo`, and suppress the validator reminder when validation is disabled. | Friction 6 |
| 9 | [template] | Disable ask-user for writers and judges. Optionally, run 2–3 songs per model so the ranking below first place can be decisive. | Friction 6, Outcome |
| 10 | [extractor] | Report validation-disabled contexts separately, flag aggregate cost divergence and format-turn gaps under Telemetry confidence, and read `modelId`. | Audit tooling |

## Follow-up

Alex's decisions on the recommendations, and what was built on branch `csm/songwriting-graph-workflow-audit-1d29d9`:

- **Two-turn capture stays.** The earlier idea of formatting in the first turn is withdrawn: the work turn stays free of format concerns. The seed prompt of an output-schema context now says its result is collected by a follow-up turn, followed by a plain list of the fields that turn asks for, with no shape or limits, and follow-up prompts repeat it in one line (`a07848948`). A one-turn mode for trivial contexts is deferred.
- **The format turn runs on the live lane runtime** as a single-turn structured conversation turn with the implementer's model, write envelope, and ask-user setting, so the runtime is not rebuilt (`a41a2ee50`).
- **Cost accounting.** The Claude task runner keeps `total_cost_usd`; every task run with a cost writes a `cost_settlement` transcript frame under its own lineage. The audit extractor reads those frames, keeps the recorded cost where a legacy capture turn never reached the transcript, reports contexts with validation disabled separately instead of as first-try GOs, and reads `modelId` (`8fff79a4a`).
- **Shared documents** that are a context-scoped charter source are listed only to those contexts, and the worktree `charter.md` omits context-scoped sources; files stay on disk (`dbcd787a5`).
- **`--out`** keeps artifact-directory-relative resolution; the cc-cli skill states the contract and its examples are fixed (`b4a837546`). The library's error and help text are tracked in cli-for-agents#1.
- **Upstream inputs as files.** `cctl workflow inputs` lists a lane's own inputs (`--full --out` saves them), and the engine writes each delivered payload into the context's payload directory before its seed turn. The result envelope's hint no longer names the nonexistent `cctl workflow result` (`8a3b88147`).
- **Out of engine scope:** the rubric's accuracy threshold (friction 1) is an eval-template matter.

