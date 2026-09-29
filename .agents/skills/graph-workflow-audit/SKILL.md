---
name: graph-workflow-audit
description: Audit the performance of a completed (or halted) graph workflow
  execution — friction points, deviations from the plan, what worked well, cost,
  and wall-clock time. Use when asked to "audit this workflow execution",
  "review the workflow run", "how did the workflow perform", "workflow
  retrospective", "workflow post-mortem", "where did the workflow struggle",
  "what did the execution cost", or before proposing graph-workflow
  engine/planning improvements based on a real run.
---

# Graph Workflow Execution Audit

Systematic review of one graph workflow execution to answer three questions,
in priority order:

1. **Quality** — did the work meet intent? Where did agents get tripped up,
   stall, or deviate from the plan? What silently degraded output?
2. **Cost** — what did it cost in tokens/USD, and where was spend wasted
   (churn, re-derivation, oversized contexts)?
3. **Speed** — wall clock vs. agent time vs. human wait; what serialized that
   didn't need to.

Always report **both** friction and what worked well — improvements to the
engine and to `graph-workflow-planning` need to know what to preserve, not
just what to fix. An audit that only lists problems is half an audit.

State the audit's learning target at the start, using the user's request and
conversation context: the delivered product, Command Center's functionality,
or both. For a CC retrospective, use work-product quality as evidence about
CC's planning, native SDD, validation, execution, recovery, or skills. Lead
with those mechanisms and their improvements; application repairs belong in
the recommendations only when the user includes them in scope.

Vocabulary matches the `graph-workflow-planning` skill: execution contexts,
tasks, acceptance criteria, implementer / context-validator lanes,
iterations, script validator, circuit breaker, lanes/joins (worktree merges),
approval gates, ask-user-question pauses, charter, shared documents.

## Ground rules

- **Read-only.** Everything lives in the live instance's config dir
  (`~/Library/Application Support/cc` on macOS; `cc-dev` when auditing a dev
  instance — pass `--config-dir`). Never write there, and never open the DB
  through the state-store (`getStateDb` runs schema DDL on connect). The
  extractor below opens SQLite `readonly` — use it, or `sqlite3
  "file:<db>?mode=ro"` for ad-hoc SQL.
- **Deterministic extraction first, judgment second.** Run the extractor
  before reading any transcript; use its flags to decide *which* transcripts
  and prompts deserve expensive qualitative reading. Don't hand-tally what
  the script already computes.
- **Every published number must trace to primary telemetry** — extractor
  output, DB rows, workflow-logs JSONL, or a transcript tally you can point
  to. Subagent deep-read summaries are hypotheses, not sources: in a real
  audit two deep-read agents returned quantifications (a per-iteration
  dollar split; an errored-call count) that failed verification against the
  extractor. Before a number ships in a report, re-derive it from the
  primary source or drop it; when a figure is a floor or inconclusive, say
  so explicitly (the extractor's "Telemetry confidence" section lists the
  known limits for the run).
- Full data-source map (tables, JSONL shapes, paths, ad-hoc query recipes):
  `references/data-sources.md` in this skill directory.

## Step 1 — Locate the execution

- The session context often names it (`<execution-id>` under
  `<graph-workflow>`). Otherwise:
  `bun run workflow:audit -- --list` — every execution (active + archived),
  newest first, with project/session.
- A live run in the current session: `cctl workflow status` (add `--full`
  for the whole execution record).

## Step 2 — Run the extractor

```bash
bun run workflow:audit -- --execution <executionId>          # markdown report
bun run workflow:audit -- --execution <executionId> --json   # full structure
bun run workflow:audit -- --project <path> --session <name>  # by session
```

It merges `command-center.db` (execution state, event log, conversation
costs) with `<config-dir>/workflow-logs/<executionId>/` (per-iteration
timing, prompt sizes, context-token telemetry, validator parse paths, plus
`lifecycle.jsonl` for halt/resume/join-retry history and `decisions.jsonl`
for scheduling decisions) and a single-pass scan of every reachable
transcript (lineage-corrected cost, tool tallies, error counts,
background-task kills, re-read churn), and reports: overview (including the
final-publish diffstat), per-context iteration tables, validation verdicts,
gate waits, cost by lane/context with a transcript-corrected total, timing
with gap classification, halt-recovery table with operator wait, detector-
driven friction findings, detected positives, and a "Telemetry confidence"
section listing where the run's figures are floors or inconclusive.

**Time semantics:** `main implementer turns` covers the ordinary implementer
prompt intervals and excludes detected hung-turn intervals, reported
separately. Validator dispatch and completed advisory-response intervals are
separate elapsed-time totals. These intervals can overlap or contain waiting;
they are neither additive labor nor a partition of wall clock. An incomplete
interval has unknown duration. Advisory admission waits are measured from
matching execution/trace/conversation records in `logs/global.log`; missing
or rotated records leave coverage unknown. Other phases' admission waits are
not separately measured. `Human waits` counts approval/user-input gates,
using iteration-log wait exits when historical resolved events are missing.
`Operator recovery` is halted→resumed wait from lifecycle.jsonl. Gap classes:
`halt_wait`, `hung_turn`, `validation_compute` (script gate), `agent_work`,
`human_wait`, `admission_wait`, `unexplained`.

**What the detectors flag** (each maps to a known failure mode):

| Finding | Meaning / where to dig next |
|---|---|
| `halt` | Execution stopped; classified `infrastructure` (config/env/merge — an LLM retry would never have fixed it), `agent`, or `user`. Infra halts are engine/config bugs, not agent failures. |
| `validation_no_go` | Validator rejected work → extra iteration. Read the verdict AND the iteration that followed: was the finding real, or did the validator enforce a wrong/ambiguous AC? |
| `circuit_breaker` / `task_failure` | Repeated failure; read `contexts/<id>/tasks.jsonl` failure messages for the root cause. |
| `context_window_pressure` | Peak measurable occupancy ≥ 70% of the model window — a pressure signal. Inspect compaction and task continuity before attributing quality loss or recommending a split. |
| `cost_mismatch` | A conversation's DB `total_cost_usd` diverges from the transcript's lineage total. Rows written before the accrual fix are inflated (SDK cumulative was consumed as a per-turn delta). Use the transcript-corrected total for all cost conclusions. |
| `background_task_kills` | Background tasks were reported killed. Inspect whether this was intended cleanup or interrupted work; attribute wasted time only when the transcript supports it. |
| `compaction_events` | The conversation was silently summarized mid-flight; verify nothing load-bearing was dropped around the boundary. |
| `scratch_debris` | The final-publish commit includes paths resembling scratch files (`.cc/`, `*.log`). Inspect their purpose before calling them accidental debris; some artifacts may be intentional deliverables. |
| `prompt_growth` | Seed prompt grew ≥ 2× across iterations. Check whether this is accumulating feedback, added scope, or required continuity. |
| `parse_fallback` | Validator response needed fenced-JSON/raw fallback — structured output failed; check the raw response in `prompts/<n>.json`. |
| `stall_gap` | Wall-clock gap covered by neither agent work, a human gate, a halt window, a hung turn, nor a validation run — orchestration dead air. Correlate with server logs (below). |
| `human_wait` | Gate/question latency ≥ 10 min. Not agent friction, but it is calendar time; note it separately. |
| `merge_conflict` | Join or context merge hit conflicts/failure. |
| `recovered_halt` | The run halted mid-flight and was resumed. The execution state clears the halt reason on resume, so without this the run reads as never having halted; the wait shown is operator recovery time. |
| `hung_turn` | A turn produced no recorded activity for over an hour — likely a dead/silent SDK turn. Its time is EXCLUDED from agent-work totals; treat as a reliability incident, not labor. |
| `join_retry` | A join needed retry attempts before its final state (final join status hides attempt history) — read lifecycle.jsonl for the sequence. |
| `cost_gap` | A conversation with real recorded activity has a zero/absent cost row — its spend is missing and the cost total is a floor. |

**Two different "turns" columns.** The iteration table's `prompt cycles` is
orchestrator prompt→completion cycles (1–3 is normal); the conversation
lines' `sdk turns` is SDK API turns (hundreds is normal for tool-heavy
work). They are not comparable — a 1-cycle iteration can contain 240 sdk
turns.

**Detector limits — always also check by hand:**

- Scan the iteration tables for **outliers the detectors don't rank**: an
  iteration far longer than its siblings, a conversation with an extreme
  `$ / sdk turns` ratio, many prompt cycles in one iteration (follow-up
  churn: the agent needed repeated re-prompting to finish its task list).
- The per-conversation tool tallies rank hotspots: high `errored` counts,
  `bg task(s) killed`, and extreme `top re-read` counts (a file read 10+
  times may signal churn, but can also reflect successive edits) mark the transcripts worth
  deep-reading first.
- `iterationCount` much larger than task count ÷ tasks-per-iteration
  suggests grinding; 1–2 iterations for a large task list suggests healthy
  flow.
- Compare main implementer and review intervals with wall clock using the gap classifications. Parallel
  turns overlap, and validation/halt waits also consume wall time; subtraction
  alone cannot establish scheduling overhead.

## Step 3 — Qualitative deep-dive (quality is priority 1)

Pick the 2–4 hotspots the extractor surfaced (NO-GO contexts, cost/time
outliers, halts, kill/re-read-heavy conversations) and read the primary
sources. Paths are in the report's "Where to dig deeper" section.

**Delegate independent transcript deep-reads when agents are available.** Hotspot transcripts run to
thousands of JSONL entries. Assign bounded hotspots and continue the audit
while they run; without delegation, read bounded excerpts locally. Use a brief
of this shape:

> Read-only. Transcript: `<path>`. Context: <what this conversation was, its
> cost/turns, what the extractor flagged>. Parse with python3 — tally first
> (entries by type, tool_use by name, is_error results, top repeated
> commands), then locate phase boundaries, then classify WASTE vs LEGITIMATE
> spend (repeated failing commands, re-derivation, env fights, idle filler
> turns) and quality-degradation signals (compaction, ignored truncations).
> Return ~40–60 lines: phase timeline with turn ranges, tallies, waste
> findings each with 1-line evidence, and a verdict: legitimate heavy
> lifting vs avoidable churn, plus the single highest-leverage change.
> Every numeric claim you return must cite the transcript entry range or
> tally it came from — unattributed numbers will be dropped.

1. **Iteration seed prompts** — `workflow-logs/<exec>/contexts/<id>/prompts/iteration-<n>.md`.
   Is the briefing self-contained? Does it restate sources of truth instead
   of citing them? Did validation feedback get injected verbatim and bloat
   later seeds?
2. **Implementer transcripts** — `transcripts/<conversationId>.jsonl` (one
   JSON entry per line; `type`/`role`/`content` blocks). Look for: repeated
   tool failures or permission denials; re-deriving project understanding
   already in the charter; fighting the validator instead of appealing;
   wandering outside the context's scope; `cctl workflow task complete`
   friction; whether ask-user-question pauses were used at genuine forks
   (and whether the agent guessed badly where it *should* have asked).
3. **Validator evidence** — `validators/<assignmentId>/validation-transcript.jsonl`
   (each cohort member's recorded output) and `validation.jsonl` (the whole
   cohort's verdict pipeline, with `assignmentId` on each entry). For every NO-GO ask
   the AeroTrainer question: *was the AC itself wrong?* A validator
   faithfully enforcing a bad spec is a planning defect, not an agent one.
4. **Scheduling telemetry** — `workflow-logs/<exec>/decisions.jsonl`
   (context scheduling and iteration limits) and `lifecycle.jsonl` (lane
   create/reuse, batch scheduling, joins). Often the richest source for
   "why did the engine do that" questions — read them before blaming an
   agent for a structural behavior.
5. **Server-side logs** for stalls and infra errors:
   `bun run logs:duckdb sql "SELECT ..."` over `<config-dir>/logs/global.log`
   (see `cc-performance-log-analysis` skill), filtered to the stall window
   or the context's conversation ids.
6. **Git evidence** — run `git show`/`git log` from the assigned worktree against
   the recorded commits; do not enter another lane's checkout without authorization. Inspect commit cadence
   (`Graph workflow context <contextId>` commits), diff size vs AC scope.
   For merged/deleted lanes, the commit SHAs live in the execution's lane
   `commitSnapshots`.

## Step 4 — Judge outcome quality, not just process

The audit is incomplete without an opinion on the *work product*: skim the
final diff / merged result against the workflow's charter and each context's
acceptance criteria. Spec-anchored validators can pass work that is
faithful-but-wrong; note anything the validators structurally could not have
caught (the prototype-inherited-defect class).

**Verify handoff claims against transcript evidence.** Iteration summaries
and task-completion messages are agent self-reports and can overstate — a
handoff claiming "independent reviewer APPROVED" or "TDD'd failing-test-
first" is only true if the transcript shows the reviewer agent invocation /
the RED test run. Spot-check the claims that the GO verdict leaned on.

For a CC retrospective, explain which CC mechanism contributed to each
consequential outcome. A product defect alone does not establish an engine
defect: distinguish an implementation error from a missing contract, an
ownership gap, ineffective guidance, or a runtime failure. Inspect the current
code or skill before recommending a change; distinguish the behavior in this
run from a fix already present in source and from verified deployment. Keep
successful mechanisms as explicit findings too.

## Step 5 — Write the audit report

Save to `docs/reports/workflow-audits/<yyyy-mm-dd>-<short-slug>.md` (create
the directory if needed) and register it:
`cctl docs register <path> --description "Workflow audit: <slug>"`.

Template:

```markdown
# Workflow audit — <workflow name> (<executionId>)

Audit objective: <what the user wants to learn; recommendation scope>

## Verdict
<2–4 sentences answering the audit objective, supported by outcome quality
and headline cost/time. For a CC retrospective, lead with how CC performed
and the most useful CC improvement.>

## What worked (preserve these)
- <mechanism → evidence. e.g. "first-try GO on N/M contexts — ACs were
  precise enough to implement against">

## Friction (ranked by quality impact)
1. <finding> — evidence: <file/line/event> — root cause — proposed fix
   (engine, planning-skill guidance, or workflow-definition change?)

## Cost
CC-recorded agent usage $X across N conversations, on the same effective
cost basis as the lane/context breakdowns (per-conversation table for outliers).
Implementer vs validator split; wasted spend identified (churn iterations,
re-derivation, oversized contexts) with $ estimates where possible.
Separately evidenced external model usage: $Y, or unknown. Shell-launched
model jobs are outside the CC conversation total.

## Time
Wall clock … · main implementer … · validators … · advisory response …
Measured advisory admission waits … · human waits … · unexplained gaps …
State overlap and incomplete telemetry; do not add phase totals as labor.
What could have run in parallel but didn't?

## Recommendations
<For each: responsible mechanism → observed evidence → current-code or skill
status → smallest useful general change. Tag: [engine] [native-SDD]
[skill] [template/definition] [config]. Identify existing fixes or proposals
before recommending new work; consult
docs/reports/graph-workflow-improvement-report.md when present. State when
an observation supports no CC change.>
```

## Pitfalls

- **Cost is conversation-grained.** `total_cost_usd` accrues over a
  conversation's whole life; a conversation reused across iterations cannot
  be split per-iteration. Compare conversations, not iterations, for spend.
- **Historical cost rows are inflated.** Rows written before the accrual fix
  consumed the SDK's cumulative `total_cost_usd` as a per-turn delta, so any
  conversation that had follow-ups over-counts (observed up to ~75% high).
  The extractor cross-checks every reachable transcript and prints a
  transcript-corrected total plus `cost_mismatch` findings — base all cost
  conclusions on the corrected figure. Manual recipe: group the transcript's
  `raw.total_cost_usd` result entries by `raw.session_id`, treat a
  cumulative DROP within one id as a lineage restart, and sum each lineage's
  final value (`summarizeTranscriptTelemetry` in
  `src/lib/workflow-graph/conversation-telemetry.ts` implements this).
- **A recorded row can also be the higher, correct figure.** Output-capture
  turns that ran as task runs wrote no transcript cost frame: a Codex capture
  turn's cost is only in the recorded row, and a Claude one's is recorded
  nowhere. The extractor keeps the recorded cost for those conversations and
  lists them as `unpriced_capture_turns` under "Telemetry confidence".
- **Lane labels ≠ context purpose.** A "Validate: …" *context* still runs in
  the implementer lane; `context_validator` is the separate validator agent.
  Validator invocations often have no conversation cost row (task-runner
  path) — validator usage appears in `graph-workflow-validation-result`
  events (`reviewArtifact.usage`; task/codex artifacts carry tokens,
  conversation artifacts carry transcript-derived cost) and the extractor
  rolls it up separately, skipping conversation artifacts whose CC
  conversation row is already priced. Events from before usage reporting
  carry tokens only or nothing, so that line can still undercount. Say so in
  the report if validators ran.
- **Codex occupancy is unmeasurable.** Codex lanes report a CUMULATIVE
  processed-token counter with `contextWindowMax: null` (turn records carry
  `occupancyMeasurable: false`). Never divide that counter by a window
  capacity; the extractor suppresses occupancy findings for such contexts and lists them under "Telemetry confidence" as inconclusive.
- **Long `agent_work` gaps can be legitimate**, but classification alone
  does not prove useful work. Inspect activity when the interval is an outlier;
  likewise, an `unexplained` gap needs corroboration before blaming orchestration.
- **`preReset` events**: a context that was reset keeps its pre-reset event
  stream flagged `pre_reset=1`; expect duplicated status sequences.
- **Archived vs active**: completed executions may still sit in the active
  table; `--execution <id>` checks both. Old executions may be missing
  `workflow-logs/` or transcript files — the DB event log is the fallback.
- **Dev instances**: `CC_ENV=dev` uses `…/cc-dev`; pass `--config-dir`.
