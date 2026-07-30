# 07 — Live Charter Amendments for Launched Graph Workflows

Status: **implemented** (2026-07-29, session `csm/plan-workflow-changes-b4e0f6` — all four
slices; F1 and F2 resolved by Alex the same day: quiescence required, metadata-only
amendment log). Designed and built against `main` @ `a8a19190`.

## Problem

Doc 06 delivered live editing of a launched execution's contexts, tasks, config, and future
structure — but explicitly excluded the **charter** (its D13: "Live charter edits … needs
versioned amendments — future seam"). The roadmap's D1 plan-repair agent needs exactly that
seam: when a circuit breaker trips because the plan itself is defective, the repair often
isn't "reword task 3" but "this invariant is impossible" or "this convention was wrong" —
charter-level content. Today the only way to fix a charter mid-run is abort-and-relaunch,
which forfeits all completed work.

Amendments must be **versioned and auditable**: agents that already ran operated under the
old charter, validators cite invariant ids from it, and a repair agent's change needs a
recorded rationale that future iterations can see.

## Current state (what changed since doc 06 was written)

Doc 06 called the charter "embedded per resolved context; needs versioned amendments". The
charter subsystem has since been reworked (native-SDD hardening) and is materially friendlier
to amendment. The charter now exists in three synchronized runtime forms:

1. **`execution.charter`** — the governance snapshot (`workflow-graph/schemas.ts:556`,
   required), seeded at launch by `seedCharter` (`charter/service.ts:155-216`), which also
   registers `.cc/graph-workflow-docs/charter.md` as a `kind:"charter"` shared document and
   logs/publishes `graph-workflow-charter-registered` with a `charterHash`
   (`charter/render.ts:182-188`, canonical-JSON sha256).
2. **Per-resolved-context copies** — `resolveContext` attaches the workflow-global charter
   identically to every resolved context (`resolve-config.ts:221-226`;
   `graphWorkflowResolvedContextSchema.charter`, optional, `definition-schemas.ts:302`).
   **These copies are what prompts actually render**: the iteration orchestrator passes
   `context.charter` into implementer and validator prompt builds
   (`iteration-orchestrator.ts:2229,2239,2526`), which render a budget-bounded digest fresh
   **every iteration** (`iteration-prompt.ts:253-254`, continuation reminder at `:434-436`;
   `validator-runner.ts:165-166`).
3. **The worktree `charter.md` mirror** — for worktree-isolated lanes, re-rendered from
   `execution.charter` at the **start of every iteration**
   (`iteration-orchestrator.ts:1810-1831` → `document-materialization.ts:82-88`). Session-lane
   contexts skip materialization (the file was written at seed and would dirty the worktree).

Consequences for this design:

- An amendment that updates `execution.charter` + the non-frozen contexts' copies reaches
  every future prompt and every lane worktree **with zero new plumbing** — the per-iteration
  digest render and per-iteration lane materialization already exist.
- `charterHash` has **no consumers** outside the charter service and event schemas — no
  spec-integrity binding constrains amendment.
- `publishCharterUpdated` + the `graph-workflow-charter-updated` event schema **already
  exist and have zero callers** (`execution-events.ts:1038-1055`, `event-schemas.ts:462-475`,
  nullable `executionId` anticipating definition-level use) — built in anticipation of this
  seam; this design finally wires them.
- The doc 06 frontier invariant deep-compares each **frozen** context's whole definition
  entry (`runtime-edits.ts` `checkFrozenPastUnchanged`, `isDeepStrictEqual(context,
  nextContext)`) — which includes its charter copy.

**Two latent gaps this design fixes on the way:**

1. Doc 05's saved-definition `update-charter` op **cannot edit `invariants`** — the field is
   missing from its schema (`edit-schemas.ts:119-127`), `applyCharterEdit`
   (`definition-edits.ts:880-893`), and the dry-run field-path list
   (`definition-edits.ts:178-187`). Invariants were added to the charter schema after doc 05
   shipped (`charter-schemas.ts:48-62`) and the op was never extended.
2. `publishCharterUpdated` is dead code — saved-definition charter edits today emit no
   charter event at all.

## Design overview

One new live-edit operation, riding the doc 06 choke point end to end:

```
amend-charter op ──▶ applyLiveExecutionEdits (same pure core)
                       │ execution gate + (F1) quiescence check
                       │ partial-merge onto execution.charter
                       │ propagate to NON-frozen contexts' charter copies
                       │ append charterAmendments entry (F2)
                       │ frontier invariant — unchanged: frozen copies untouched
                       ▼
                mutateActiveGraphWorkflowExecution (serialized, atomic)
                       ├─▶ liveRevision bump (it is a live edit)
                       ├─▶ publishLiveEditApplied      (existing, mandatory)
                       ├─▶ publishCharterUpdated       (finally wired; new hash)
                       └─▶ post-commit: rewrite session-worktree charter.md
```

**The frozen past keeps its as-run charter.** Completed contexts' charter copies are
deliberately **not** updated: prompts for them never render again, the frontier invariant's
frozen deep-compare passes untouched, and each frozen context organically records *the
charter version it actually executed under* — history by construction, not bookkeeping.
Started and unstarted contexts' copies are rewritten to the amended charter.

## Data model

1. **`workflowCharterSchema` is unchanged** — amendments modify content, they are not
   content.
2. **`charterAmendments`** on `graphWorkflowExecutionSchema` (runtime tier, additive,
   `.default([])` — old rows parse):

```ts
export const charterAmendmentSchema = z.object({
  seq: z.number().int().min(1),          // 1-based, append-only
  amendedAt: z.string(),                  // ISO timestamp
  source: z.enum(["cli", "ui"]),         // same trust model as doc 06 D15
  rationale: z.string().min(1),           // required on the op; the "why"
  fieldsChanged: z.array(z.string()),     // derived from the op, e.g. ["invariants","mission"]
  charterHash: z.string(),                // hash AFTER this amendment
});
```

Per **F2 (locked)** this metadata log is all that persists — bounded growth even in a repair
loop; the full prior content survives in frozen contexts' copies and in committed lane
renders of `charter.md`. Contract round-trip fixture extension is mandatory
(`persistence-testing-strategy`).

## The operation

Added to `workflowLiveEditOperationSchema` (live union only — the saved-definition union
keeps `update-charter`):

| `type` | Fields | Preconditions |
|---|---|---|
| `amend-charter` | required `rationale`; partial-merge content fields, ≥1 present: `mission`, `conventions` (nullable), `nonGoals` (nullable), `vocabulary` (nullable), `testStrategy` (nullable), `knownAmbiguities` (nullable), `invariants` (nullable), `sourcesOfTruth` | execution editable per doc 06 gate; **quiescent required** (F1) — while running → `requires_pause` |

- Merge semantics match doc 05's `applyCharterEdit` exactly: scalars set, arrays replace
  wholesale, `null` clears an optional section, `undefined` leaves untouched — one shared
  helper serves both ops after the invariants fix.
- Post-merge the charter must re-`parse` under `workflowCharterSchema` (min-1 sources, unique
  ranks, unique invariant ids) — violations reject the batch as `invalid_edit` with
  `operations[i]` locators.
- `affectedContextIds` = every non-frozen context id (drives SSE/UI invalidation honestly).
- Batch composition with other ops is allowed (e.g. amend an invariant + rewrite the affected
  context's AC in one atomic batch — the exact D1 repair shape).
- `liveRevision` bumps once per accepted batch as today; `charterAmendments.seq` increments
  once per `amend-charter` op.

### Editability policy (F1 — open)

- **(a) Recommended: quiescence required.** The op rewrites *started* contexts' charter
  copies, and every existing edit that touches started work requires quiescence
  (paused / resumably-halted). D1's repair agent always operates on a halted execution, so
  this costs nothing for the driving use case; relaxing later is a one-line change.
  While running → `requires_pause`.
- **(b) Allowed while running.** Treat the charter as advisory-additive guidance; the
  serialized mutation + per-iteration prompt render mean a running conversation simply sees
  the amendment on its next iteration. More permissive for a future D8 owning agent; breaks
  the "started work needs pause" symmetry now.

## Rendering, materialization, and visibility

- `renderCharterDigest` / `renderCharterMarkdown` / `renderCharterPromptSection` gain an
  optional `amendments: CharterAmendment[]` parameter rendering an **"Amendment log"**
  section (seq, date, fieldsChanged, rationale) after the content sections — so every future
  implementer/validator prompt and every re-materialized `charter.md` shows *that* the rules
  changed and *why*. `computeCharterHash` stays content-only; the hash chain across
  amendments lives in the event stream and the `charterAmendments` entries.
- **Lane worktrees**: nothing to do — per-iteration materialization re-renders from the
  amended `execution.charter` (+ log).
- **Session worktree**: the seed-time `charter.md` goes stale for session-lane contexts
  (materialization deliberately skips them). The route handler rewrites the session
  worktree's `charter.md` **post-commit** via the same artifact-registry path `seedCharter`
  uses (worktree confinement preserved; failure is logged, non-fatal — the inline prompt
  digest is authoritative, the file is a pointer copy).
- `sharedDocuments` charter entry gets `updatedAt` bumped in the same mutation.

## Events, SSE, audit

- `publishLiveEditApplied` fires as for any live edit (mandatory doc 06 D12/D16 signal).
- `publishCharterUpdated` (existing, currently uncalled) fires additionally per accepted
  `amend-charter`, carrying the post-amendment `charterHash`, `executionId`,
  `definitionId`/`seedDefinitionRevision`. The event joins the workflow + global SSE unions
  (schema already exists) and `NotificationListener` invalidates execution detail + events
  list on it.
- Structured logs: `live_edit.charter_amended` (executionId, seq, source, fieldsChanged,
  charterHash) on the `workflow.live-edit` logger.
- **Saved-tier emission stays out of scope** (amended during implementation): the doc 05
  edit pipeline (`definition-edit-handler.ts`) is deliberately tier-agnostic — it has no
  project/session identity (none exists at the global tier) and `graph_workflow_events`
  rows are session-keyed, so there is no legal row to append. The event schema's nullable
  `executionId` remains a seam for a future definition-tier event bus; this design wires
  `publishCharterUpdated` on the live path only.

## CLI surface

- `cctl workflow live edit` picks up `amend-charter` through the schema — no new verb.
- `cctl workflow live get --charter` — new selector (parity with the saved-tier
  `workflow get --charter`): renders the current charter markdown + amendment log; the
  default outline header gains `charter: amended ×N` when amendments exist.
- Help-registry updates per `.kiro/steering/cli.md` (flag wiring, COVERAGE, an `amend-charter`
  example teaching the rationale-required shape, `related` edge to `workflow edit`
  "saved-definition charter vs live amendment"), cc-cli SKILL.md sync, plugin version bump.

## UI

v1 ships **display only**: the execution inspector Overview shows amendment count + latest
rationale (data already flows via SSE invalidation). Charter *editing* UI joins the doc 06
slice-5 parity bucket (structural forms) — same accepted, temporary CLI-only gap, same
revisit point (D4 design time).

## Testing plan (red-green TDD throughout)

1. **Op unit tests** (`runtime-edits.live.test.ts` extended): partial-merge matrix incl.
   `invariants`; null-clears; ≥1-field rejection; post-merge Zod violations (dup rank, dup
   invariant id, empty sources) → `invalid_edit`; frozen copies untouched + non-frozen copies
   updated (deep-compare both sides); frontier invariant green without modification; F1 gate
   (`requires_pause` while running under (a)); seq/`fieldsChanged`/hash correctness; batch
   atomicity with a failing later op (no amendment persists).
2. **Route tests**: amendment applies → `liveRevision` bump + `charterAmendments` row +
   *both* events appended; dry-run: no persist, no seq, no events; `createPersistenceFixture()`
   reload-assert (serialization backstop).
3. **Contract round-trip**: `charterAmendments` in the executions repo maximal fixture.
4. **Render tests** (`charter/render.test.ts` extended): amendment-log section in digest +
   markdown; hash unchanged by amendments (content-only).
5. **Materialization test**: amended execution re-materializes lane `charter.md` with the log.
6. **Doc 05 fix regression**: `update-charter` accepts/applies/clears `invariants`; dry-run
   field paths include it; saved-tier edit emits `charter-updated` with null executionId.
7. **CLI tests**: `live get --charter` rendering + selector exclusivity; help contract green.
8. **SSE**: `graph-workflow-charter-updated` passes envelope stamp/strip and triggers
   invalidation (`FakeEventSource`).

## Implementation slices

1. **Slice 1 — schema + doc 05 gap fix**: `charterAmendmentSchema` + execution field +
   contract fixture; `invariants` added to `update-charter` (schema, shared merge helper,
   field paths).
2. **Slice 2 — the op**: `amend-charter` in the live union; pure-core applier (merge,
   propagation, seq, hash); route pipeline (events, post-commit session `charter.md`
   rewrite); logs.
3. **Slice 3 — rendering + CLI**: amendment-log rendering; `live get --charter`; help
   registry + SKILL sync + plugin bump.
4. **Slice 4 — UI display**: Overview amendment count/rationale; NotificationListener
   handler.

Each slice independently landable, tree green.

## Decisions

| # | Decision | Status |
|---|---|---|
| C1 | Amendments ride the doc 06 choke point (`applyLiveExecutionEdits` → serialized mutation); never a parallel path | locked (charter constraint) |
| C2 | Frozen contexts keep their as-run charter copies; propagation targets non-frozen copies only; frontier invariant unchanged | locked (recommended, no counter-option identified) |
| C3 | `amendments` live on the execution (runtime tier), not inside `workflowCharterSchema` — authored tier stays pure; render functions take them as an explicit param | locked |
| C4 | Op vocabulary: `amend-charter` (live) with required `rationale`, distinct from `update-charter` (saved); merge semantics shared | locked |
| C5 | `computeCharterHash` stays content-only; hash-after recorded per amendment + in events | locked |
| **F1** | `amend-charter` requires quiescence (paused / resumably-halted); while running → `requires_pause`. Relaxable later in one line. | **locked (Alex, 2026-07-29)** |
| **F2** | History = metadata-only amendment log (seq, amendedAt, source, rationale, fieldsChanged, post-hash); no full prior-charter snapshots. Frozen contexts' as-run copies + committed lane `charter.md` renders are the content history. | **locked (Alex, 2026-07-29)** |
