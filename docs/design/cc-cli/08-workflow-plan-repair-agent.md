# 08 — Plan-Repair Agent for Retry-Exhaustion Halts (roadmap D1)

Status: **implemented and live-proven** (2026-07-30, session `csm/plan-workflow-changes-b4e0f6`).
All six product forks locked by Alex 2026-07-29 (see Decisions). Designed against the session
branch containing doc 07 (`284dc20c`), whose amendment seam this deliverable consumes.

**F6 live proof (2026-07-30, dev instance, scratch project `plc-test-lab`):** a deterministic
trap (premerge gate rejecting the exact marker filename the AC demanded, breaker threshold 1)
produced the full autonomous loop live — breaker trip → supervisor trigger → repair agent
(sonnet/high, ephemeral session-worktree conversation) → root-cause diagnosis (it read the
premerge script, the execution worktree, and git history, and correctly classified
"contradictory acceptance criterion, not a failed implementation") → 2 allowlisted ops applied
through the shared core (`source: "plan-repair"`, liveRevision 1→2) → autonomous resume →
implementer executed the amended plan → execution completed. Round log, halt summary,
`graph-workflow-plan-repair` events, and the live-edit event all verified in the dev DB.
The proof also caught and fixed one real defect: a fully loose verdict schema let the model
emit typeless operations — `operations[].type` is now schema-required (backend-enforced) and
the prompt carries exact op JSON shapes. The doc 07 `amend-charter` branch (not chosen by the
repair agent, whose fix correctly targeted AC/tasks) was closed with a direct live exercise on
a paused execution: amendment applied, log rendered in `live get --charter`, session
`charter.md` pointer copy rewritten. Earlier probe runs are themselves evidence for D1's
premise: LLM implementers and validators repeatedly rationalized around purely LLM-judged
contradictions (charitable validator passes, self-serving marker renames) — only the
deterministic gate held the line, which is exactly the failure mode plan repair exists for.

## Problem

The single biggest observed graph-workflow failure mode (native-SDD audits, VISION.md) is
a planning defect burning iterations: an impossible or contradictory acceptance criterion,
a wrong charter assumption, or an underestimated iteration budget. Today the machinery
reacts by tripping the circuit breaker (or exhausting `maxIterations`) and halting — a
dead end until a human diagnoses the transcript and hand-repairs the plan via
`cctl workflow live edit`. The full halt → repair → resume loop became scriptable when
doc 07 landed; nothing scripts it yet.

D1 closes that loop: on a retry-exhaustion halt, an agent reviews the failure evidence,
decides whether the root cause is a planning defect, and if so patches the plan artifacts
through the doc 06/07 edit surface and resumes the execution — autonomously, bounded, and
audited. It is deliberately a scoped first slice of the D8 owning agent.

## Locked product forks (Alex, 2026-07-29)

| # | Fork | Decision |
|---|---|---|
| F1 | Trigger | **Breaker trips + max-iterations halts** — both retry-exhaustion kinds; not per-validation-failure (that would fight doc 07's quiescence lock and add per-iteration cost) |
| F2 | Autonomy | **Fully autonomous repair → resume**; a "not a planning defect" verdict leaves the run halted with the diagnosis recorded; push notification on every outcome |
| F3 | Edit scope | **Plan artifacts, no graph surgery** — charter, context prose/AC, task ops, iteration/breaker budgets; no context/edge structural ops |
| F4 | Enablement | **Default ON everywhere** — a `planRepair` block in the standard config cascade; workflows opt out |
| F5 | Process | Doc-07 pattern: this design doc, then red-green TDD in this session |
| F6 | Live proof | D1's first real repair loop is also the live proof of the doc 07 amend-charter seam |

## Current state (what this builds on)

- **Halt shapes.** `circuit_breaker` halts carry `contextId`, `failureCount`, and a
  `summary` field that is always `null` today (`workflow-graph/schemas.ts:42-48`) — free
  for the repair verdict. `max_iterations` halts carry `contextId` + `iterationCount`
  (`schemas.ts:49-53`) and gain a nullable `summary` here for symmetry. Both are
  resumable (`lifecycle-classifier.ts:37-51`), i.e. quiescent-editable — exactly what
  doc 07's F1 requires for `amend-charter`.
- **Halt promotion.** Trips record a pending halt (`recordPendingHaltReason`), the loop
  drains, `drainAndHalt` promotes it and the loop `break`s and returns the final
  execution (`execution-loop.ts:2612-2621`). Every loop start — launch, resume, restart
  recovery — flows through the single `kickOffExecutionLoop` dep
  (`execution-route-handlers.ts:624-626`): the natural supervisor seam.
- **Resume semantics.** `workflowManager.resume` flips halted contexts to `ready`,
  zeroes `consecutiveFailureCount` for every ready context, clears halt reasons, and
  bumps `loopEpoch` to fence zombie loops (`workflow-manager.ts:1105-1164`). A repair
  round that resumes gets a genuinely fresh breaker window.
- **Evidence.** Validation verdicts persist as `graph-workflow-validation-result` events
  (summary, issues, reopened tasks, `reviewArtifact` conversation pointer); task states
  keep an append-only `failureHistory`; full validator transcripts and prompts live under
  `<configDir>/workflow-logs/<executionId>/contexts/<id>/`.
- **The edit surface.** `applyLiveExecutionEdits` accepts `amend-charter` (rationale
  required, quiescence-gated), `update-context`, and the task ops, applied atomically
  under `mutateActive` with a `liveRevision` bump and mandatory live-edit + charter
  events. The apply pipeline currently lives inline in the runtime-edit route handler
  (`runtime-edit-route-handlers.ts:394-505`) — this design extracts it so the repair
  path rides the identical core, per the charter constraint (same choke point, never
  around it).
- **One-shot engine agents.** `executeWorkflowTaskRun` is the entrypoint every
  engine-spawned one-shot agent uses (validator, planner, validation-fix, conflict
  resolution): transient actor input, optional `outputFormat` JSON schema, structured or
  text or error result variants. The context validator (`validator-runner.ts`) is the
  template: build prompt → task_run with schema → `validateStructuredOutput` → record
  artifact + telemetry.

## Design overview

```
loop settles halted (circuit_breaker | max_iterations)
        │  kickOffExecutionLoop → runLoopWithPlanRepair (supervisor wrapper)
        ▼
  trigger predicate ── disabled / attempts exhausted / wrong halt kind / stale
        │ eligible            └──▶ (exhausted: populate haltReason.summary, notify, stop)
        ▼
  append planRepairRounds entry (outcome pending)   ← crash-safe attempt accounting
        ▼
  repair agent: one-shot task_run in the session worktree
    prompt = charter digest + amendment log + tripped context (AC, tasks,
             failureHistory) + validation-result event history + budgets
             + advisories and their dispositions (workflow-validator-advisories
               D10: the tripped context's, plus every long-lived one elsewhere)
    output = { planningDefect, diagnosis, operations[] }  (JSON schema enforced)
        ▼
  verdict gate
    ├─ planningDefect=false / no ops ──▶ settle round "declined";
    │                                    haltReason.summary = diagnosis; notify; stop
    └─ planningDefect=true ──▶ re-parse ops against the RESTRICTED repair op schema
                                  │ violation → round "failed"; summary; notify; stop
                                  ▼
                          shared live-edit apply core (extracted from the route)
                          source: "plan-repair", baseLiveRevision from fresh read
                                  │ gate rejection / lost race → round "failed" or
                                  │ "superseded"; notify; stop (halt state untouched)
                                  ▼
                          settle round "repaired"; notify
                                  ▼
                          normalizeAfterRestart → resume → kickOffExecutionLoop
                                  └── recursion re-enters this supervisor; the rounds
                                      cap bounds it
```

The supervisor is **not** a fourth orchestration shape: it composes existing lifecycle
verbs (halt inspection, live edits, resume) around the deterministic loop, exactly like a
human operator scripting `cctl workflow live` — but server-side, in-process, and fenced.

## Trigger policy

`maybeRunPlanRepair` runs after every `executionLoop.run` settlement, and fires only when
**all** hold:

1. A fresh `getActive` read returns the same execution id the loop returned, with
   `status === "halted"` and `haltReason.type ∈ {circuit_breaker, max_iterations}`.
   (The loop's returned snapshot can be stale when fenced out — the fresh read is
   authoritative; a superseded loop must never trigger repair.)
2. The tripped context (`haltReason.contextId`) resolves `planRepair.enabled === true`
   from its embedded resolved config.
3. Rounds for that context < `planRepair.maxAttemptsPerContext`, and total rounds for
   the execution < the hard backstop constant (`PLAN_REPAIR_MAX_ROUNDS_PER_EXECUTION = 5`).
4. No repair is already in flight for this `(projectPath, sessionName)` (in-memory keyed
   guard; the persisted round log is the durable count, the guard just prevents
   double-spawn).

Not covered on purpose: halts that pre-exist a server restart (no loop settles, so no
trigger — the human resumes and a subsequent trip triggers normally), and every other
halt kind (merge/join failures have their own recovery machinery; validator infra errors
are not planning defects).

Secondary halt reasons of retry-exhaustion shape are surfaced in the prompt as context
but only the primary reason drives attempt accounting.

## The repair agent

**Conversation.** A transient lane conversation (validator-style `actorInput`), bound to
the **session worktree** — the execution is quiescent, so no lane turn can race it — with
the same tool access a validator conversation gets: the agent may read the repo to test
whether an AC is even satisfiable. Model/effort from `planRepair.agent` (seeded default:
`claude / opus / high` — rare, high-stakes invocations). The turn runs with a bounded
`timeoutMs` (constant, 15 min); timeout → round `failed`.

**Prompt** (built by a pure `buildPlanRepairPrompt`, unit-tested):

> **Amended by ticket #69 changes 3 and 4 (2026-08-18).** The repair prompt's charter
> section is the digest alone — the amendment log stayed behind in `charter.md` and the
> durable record — and the digest carries only the sources scoped to the tripped context,
> with no precedence or access-policy rules. The tripped context's AC renders as numbered
> `{id, statement}` records, repair evidence cites the `criterionId` a verdict named, and
> `update-context` rewrites that whole record list (there is no per-criterion op).

- Persona: a senior engineering lead reviewing a stalled workstream — diagnose first,
  change the plan only when the plan itself is wrong.
- Evidence sections: workflow title/description; charter digest **with amendment log**
  (doc 07 render); the tripped context's title/description/AC; its tasks with status,
  `failureMessage`, and `failureHistory`; the last K (≤5) `validation-result` events for
  the context (summary + issues); iteration count vs `maxIterations`; failure count vs
  breaker threshold; the halt reason verbatim; prior repair rounds for this execution.
- Decision framework: planning defect = impossible/contradictory/ambiguous AC, false
  charter assumption, missing or mis-scoped task, or an honest budget shortfall for
  legitimately larger work. NOT a planning defect = a failing implementation approach,
  flaky infra, or work that simply has not succeeded yet.
- **Anti-weakening guardrail (verbatim in the prompt):** do not weaken acceptance
  criteria merely to make failures pass; a repair must preserve the workflow's intent —
  prefer clarifying ambiguity, correcting factual errors, or splitting an impossible
  criterion into achievable ones with rationale. When uncertain, return
  `planningDefect: false`.
- Mechanics note: a `max_iterations` halt resumes into the same iteration count — a
  repair that neither raises `iterationPolicy.maxIterations` nor shrinks the remaining
  work will re-halt immediately and burn an attempt.
- Op vocabulary: the restricted set below, with the `amend-charter` rationale
  requirement spelled out.

**Output schema** (`outputFormat`, enforced by `validateStructuredOutput`):

```json
{
  "planningDefect": "boolean",
  "diagnosis": "string — root-cause analysis; becomes the halt summary when declining",
  "operations": "array — restricted live-edit ops; empty when planningDefect is false"
}
```

## Restricted repair operations — the plan/controls split

The agent may change the **plan** (what to build, how much budget); it may never change
the **controls** (who validates, what gates run, what it may itself do). The agent's
`operations` output is untrusted input: the supervisor re-parses it against a dedicated
`planRepairOperationSchema` before anything touches the apply core.

| Allowed | Notes |
|---|---|
| `amend-charter` | full doc 07 content shape, `rationale` required by the op itself |
| `update-context` | **only** `title`, `description`, `acceptanceCriteria`, `iterationPolicy`, `circuitBreaker` |
| `add-task`, `update-task`, `remove-task`, `reorder-tasks` | any non-frozen context (the shared gates enforce frozen/quiescence as for every live edit) |
| `update-validator-assignment` | narrowing only, one named seat: rewrite its authored `instructions`, or demote `authority` blocking → advisory. Repair-only vocabulary — the engine expands it into the `update-context` cohort write, so the agent never authors a roster (workflow-validator-advisories D10) |

Denied (schema-absent, so a violating batch fails closed as a `failed` round):
`add-context`, `remove-context`, `add-edge`, `remove-edge`, `move-task`, and on
`update-context` every control block — `implementer`, `contextValidator`,
`scriptValidator`, `humanApprovalGate`, `askUserQuestions`, `mutability`,
`collaboration`, and `planRepair` itself (the agent must not raise its own attempt cap
or disable a human gate). Setting `authority: "blocking"` through the narrowing op is
denied at op validation rather than by schema absence, so the round records which line
the agent tried to cross: a repair may defuse a mis-scoped blocking standard, never mint
blocking authority.

`update-validator-assignment` is admitted and expanded in two steps, because the agent's
turn is long enough for an operator to edit the same cohort. Admission judges the op
against the snapshot the prompt was built from; the cohort write is composed later, from
the snapshot the apply's `baseLiveRevision` pins. Expanding early would carry a stale
roster into a whole-cohort write and silently revert a concurrent edit, turning a
one-seat narrowing into a roster overwrite. If the named context or seat is gone by then,
the batch fails closed as a `failed` round — a narrowing never re-creates a seat.

## Config

New cascading block, identical plumbing to `circuitBreaker` (global `workflowDefaults` →
workflow → per-context; resolved into every context at launch):

```ts
export const graphWorkflowPlanRepairPolicySchema = z.object({
  enabled: z.boolean().default(true),                   // F4: default ON
  maxAttemptsPerContext: z.number().int().min(1).default(2),
  agent: graphWorkflowAgentConfigSchema.optional(),     // resolver defaults claude/opus/high
});
```

Touch points: `config-schemas.ts`, `WorkflowDefaults` (`config/schemas.ts`),
`SEEDED_DEFAULTS` + `coerceGlobalDefaults` + `resolveWorkflowConfig` + `resolveContext`
(`resolve-config.ts`), the resolved-context and context-definition schemas
(`definition-schemas.ts`), `liveEditContextConfigShape` + the doc 05 saved-tier config
shape (humans may live-edit or author the block; the repair agent may not), config
rendering in `workflow get --config` / `live get --config`, and the round-trip contract
fixtures. Because the resolved-context field defaults, **pre-D1 executions parse and get
repair for free**, consistent with default-ON.

## Data model

1. **`planRepairRounds`** on `graphWorkflowExecutionSchema` (runtime tier, additive,
   `.default([])`), the single source of attempt accounting — derived per-context counts,
   nothing to reset on resume, and crash-safe because the entry is appended **before**
   the agent runs (a crashed round still counts):

```ts
export const planRepairRoundSchema = z.object({
  seq: z.number().int().min(1),
  contextId: z.string().min(1),
  haltType: z.enum(["circuit_breaker", "max_iterations"]),
  startedAt: z.string(),
  settledAt: z.string().nullable().default(null),
  outcome: z.enum(["repaired", "declined", "failed", "superseded"]).nullable().default(null),
  planningDefect: z.boolean().nullable().default(null),
  diagnosis: z.string().nullable().default(null),
  operationCount: z.number().int().min(0).default(0),
  resumed: z.boolean().default(false),
  conversationId: z.string().nullable().default(null),
});
```

   (`superseded` = the halt state changed under the agent — user resumed/aborted/edited —
   and the round withdrew without applying.)
2. **`max_iterations` halt reason** gains `summary: z.string().nullable().default(null)`
   (additive, parse-safe) so declined/exhausted verdicts are visible in the halt UI for
   both trigger kinds, mirroring `circuit_breaker.summary`.
3. **Source attribution**: `"plan-repair"` joins `charterAmendmentSchema.source`
   (`workflows/charter-schemas.ts:64`), the live-edit event source enum
   (`event-schemas.ts:492`), and `publishLiveEditApplied`'s input — but **not** the HTTP
   `workflowLiveEditRequestSchema`, exactly like `lane-agent`: server-derived only, never
   client-claimable.

Contract round-trip fixtures extend for every persisted field above
(persistence-testing-strategy).

## Apply-core extraction

The route handler's apply pipeline (gate → `liveRevision` bump → `publishLiveEditApplied`
→ conditional `publishCharterUpdated` → post-commit session `charter.md` rewrite) moves
verbatim into a shared service (`workflow-graph/live-edit-apply.ts`,
`applyLiveEditsToActiveExecution`), parameterized by the widened internal source union.
The route POST and the repair supervisor both call it; behavior of the HTTP path is
pinned by the existing route tests before the move (red-green: extraction is a refactor
under green, then the supervisor consumes the seam). Concurrency safety comes from the
same optimistic `baseLiveRevision` + in-mutation gate re-run every other editor uses: a
user edit racing the repair produces `revision_conflict` (one re-read retry), a user
resume/abort produces a gate rejection → round `superseded`, halt state untouched.

## Events, notifications, logs

- **Event**: new `graph-workflow-plan-repair` event type (event-schemas union +
  `graph_workflow_events` append + workflow/global SSE unions + `NotificationListener`
  invalidation): `contextId`, `attempt`, `haltType`, `outcome`, `planningDefect`,
  `diagnosis` (bounded), `operationCount`, `resumed`, and a `reviewArtifact` conversation
  pointer + usage, mirroring validation events. Emitted when a round settles.
- **Push**: two kinds via the existing dispatcher — `workflow-plan-repaired` (info: "Plan
  repair applied to <workflow> — context <id>, attempt N/2 — resumed") and
  `workflow-plan-repair-declined` (warning: decline/failure/exhaustion, with the
  diagnosis' first line). The existing `workflow-halted` push still fires at halt time —
  transparency over suppression; a repaired run reads as halted → repaired → resumed.
- **NDJSON**: the supervisor re-registers the execution logger (drain unregistered it)
  and writes `decisions.jsonl` entries — `plan_repair.triggered / verdict / applied /
  resumed / declined / failed / exhausted` — plus the repair prompt and raw/parsed
  response under `contexts/<id>/plan-repair/`, following the validator's transcript
  logging shape.
- **Structured logs**: `workflow.plan-repair` logger, stable event names matching the
  decisions entries (`.kiro/steering/logs.md`).

## CLI and UI

- `cctl workflow live get` header gains `plan-repair: <n> round(s)` when rounds exist;
  `workflow status` halt line already shows the reason — the populated `summary` now
  explains it. Help-registry COVERAGE + cc-cli SKILL sync per `.kiro/steering/cli.md`.
- Inspector: repair rounds appear in the Events panel via the new event type; the halt
  bar / `HaltDetailsDialog` renders the populated summary. An Overview "plan repair ×N"
  badge is a cheap optional final slice.
- **Configuration UI (landed post-live-proof, closing the original CLI-only parity
  bucket):** the shared `PlanRepairEditor` (enabled / max attempts / optional custom
  agent seeded from `PLAN_REPAIR_DEFAULT_AGENT`) renders on all three config surfaces —
  the global settings page (`PlanRepairFields`, ninth Workflow-defaults block), the
  builder inspector (workflow + context tabs, full Override/Reset cascade provenance),
  and the execution inspector's Config tab (live `update-context` edits). In the same
  pass, the seeded workflow defaults were single-sourced: `SEEDED_WORKFLOW_DEFAULTS`
  is exported from `resolve-config.ts` (the cascade owner) and every UI fallback
  imports it; `DEFAULT_PLAN_REPAIR_POLICY` derives from the Zod schema so plan-repair
  default values exist in exactly one place.

## Testing plan (red-green TDD throughout)

1. **Restricted op schema** (pure): allow/deny matrix — every allowed op parses; every
   denied op type rejects; `update-context` control blocks reject (incl. `planRepair`,
   `humanApprovalGate`); rationale-less `amend-charter` rejects.
2. **Trigger predicate** (pure/unit): halt-kind matrix; disabled config; per-context and
   per-execution caps; stale/fenced snapshot (fresh read disagrees) → no trigger;
   in-flight guard.
3. **Config resolution**: cascade tiers, seeded default, coerce of absent block, pre-D1
   resolved contexts parse with default.
4. **Supervisor flow** (DI fakes for task-run, apply core, resume, notifier — method-
   syntax interfaces): defect → apply → resume → round `repaired`; decline → summary
   populated + no resume + round `declined`; invalid ops → `failed`; task-run error/
   timeout → `failed`; revision conflict → single re-read retry; user resumed mid-round →
   `superseded`, no mutation; exhaustion → summary + notify, no agent spawn; round
   appended before agent runs (crash accounting).
5. **Apply-core extraction**: existing runtime-edit route tests stay green; supervisor
   path emits live-edit + charter events with `source: "plan-repair"`.
6. **Persistence**: `planRepairRounds`, `max_iterations.summary`, and amendment source
   widening in the execution repo's maximal round-trip contract fixture;
   `createPersistenceFixture()` reload asserts after a full simulated round.
7. **Prompt builder**: evidence sections present (AC, failure history, validation issues,
   charter digest + amendment log, budgets, guardrail text, max-iterations mechanics
   note); bounded sizes.
8. **Events/SSE/push**: envelope stamp/strip + listener invalidation for the new event;
   dispatcher mapping for both push kinds.
9. **Integration** (spine/persistence fixture): halted-with-breaker execution + fake
   agent emitting `amend-charter` + `update-context` + `add-task` → applied atomically,
   `liveRevision` bumped once, amendment log source `plan-repair`, resumed, round
   settled.
10. **Live proof (F6)**: a real scratch execution with a deliberately impossible AC →
    breaker trips → repair amends charter/AC → resumes → completes. Also the doc 07
    seam's first live exercise. Evidence per `cc-live-feature-test`.

## Implementation slices (each independently landable, tree green)

1. **Schemas + config**: `planRepair` block through the full cascade; `planRepairRounds`;
   `max_iterations.summary`; source widening; contract fixtures.
2. **Apply-core extraction**: shared `applyLiveEditsToActiveExecution`; route delegates;
   regression green.
3. **Pure repair core**: restricted op schema; trigger predicate; prompt builder; verdict
   schema.
4. **Supervisor**: `runLoopWithPlanRepair` wrapper wired into `kickOffExecutionLoop`;
   agent run; apply; resume; fencing; races; NDJSON + structured logs.
5. **Events + push**: event type end-to-end (append, SSE, listener), dispatcher kinds,
   halt-summary population.
6. **CLI/UI display + docs**: `live get` header, inspector events/badge, help registry +
   SKILL sync + plugin bump; steering `workflows.md` adoption-matrix row.
7. **Live proof + closeout**: F6 run, roadmap/charter updates.

## Decisions

| # | Decision | Status |
|---|---|---|
| F1–F6 | The six product forks above | **locked (Alex, 2026-07-29)** |
| R1 | Supervisor hooks the `kickOffExecutionLoop` seam (post-settlement, fresh-read verified) — every loop start already flows through it; no engine-interior changes | locked |
| R2 | Repair writes ride the extracted live-edit apply core — same gates, same revision bump, same events; never a parallel path (charter constraint) | locked |
| R3 | Plan/controls split: the agent edits plan artifacts and budgets, never validators, gates, mutability, or its own config; enforced by a server-side restricted schema, fail-closed | locked |
| R4 | Attempt accounting = append-only `planRepairRounds`, appended pre-agent (crash-safe), never reset by resume; per-context cap (default 2) + hard per-execution backstop (5) | locked |
| R5 | `source: "plan-repair"` is server-derived only (lane-agent precedent); HTTP schema unchanged | locked |
| R6 | Repair agent runs in the session worktree with validator-grade tool access; quiescence makes this race-free | locked |
| R7 | `workflow-halted` push is not suppressed on repairable halts — outcome pushes complement it | locked |
| R8 | Declined/exhausted verdicts persist in `haltReason.summary` (both halt kinds) so the halt UI explains itself | locked |
