# Phase 0 (D0) Closeout Plan

Date: 2026-07-29 · Session: `csm/plan-workflow-changes-b4e0f6` · Governs: roadmap
[D0 — land the live-mutation surface](../roadmap.md)

## Why this plan looks different from the roadmap's D0 description

The roadmap (and the session charter) described D0 as "commit doc 05, implement
doc 06". Both already happened; the descriptions were stale:

| Artifact | Roadmap said | Actual state (verified against `main`) |
|---|---|---|
| Doc 05 — definition editing | implemented, uncommitted | Landed as `0ad3bf4f`, 2026-07-07 (`cctl workflow edit` + outline `get`, PATCH endpoints, `applyDefinitionEdits`). The old work branch `csm/better-workflow-editing-capability-c6716c` is fully superseded by this commit. |
| Doc 06 — live editing | spec approved, not started | Landed as `476f2e8f`, 2026-07-08 — slices 1–4 of the doc's own plan (94 files): lifecycle classifier, `applyLiveExecutionEdits` + frontier invariant, `liveRevision`, runtime-edits route with dry-run, `publishLiveEditApplied` SSE, `cctl workflow live get\|edit\|pause\|resume` (+ `execution`/`exec` aliases), server-side live outline, inspector Config tab with live editing (`ContextConfigTab`, shared `src/components/workflow-config/` editors). Since maintained through six later main refactors (schema split into `edit-schemas.ts`, state-store perf work, configurable collaboration). |
| Doc 06 slice 5 — UI structural forms | — | Not implemented, by design ("phase 2" in doc 06; structural edits are CLI-only — an accepted parity gap). |

Live-usage evidence (read-only query of the production `graph_workflow_events`
table): 14 `graph-workflow-live-edit-applied` rows — **13 `lane-agent`** (the
`add_task` wrapper, well exercised by real runs), **1 `cli`** (a single one-op
edit), **0 `ui`**. The doc-05 saved-definition edit path has no recorded live
verification either (its landing memory: "live end-to-end LLM run NOT done").

So Phase 0's remaining substance is **verification and closeout, not
implementation**.

## Work items

### W1 — Live verification pass — **CLOSED 2026-07-29**

Alex confirmed the delivered surface was already live-tested; no additional verification
needed. Phase 0 exit criterion 1 is satisfied. (Original scenario plan retained below for
the record.)

Run per the `cc-live-feature-test` skill against this session's own dev server
(`cctl dev ensure`), with backend-state assertions (SQLite events, `liveRevision`,
transcripts), not UI-only checks. Any defect found is fixed in this session under
red-green TDD before closeout.

- **Scenario A — doc 06 canonical CLI loop.** Launch a small real workflow
  (≥3 contexts so there is an unstarted future). While *running*: edit an
  unstarted context (config + task op — allowed without pause). Then
  `live pause` → edit a *started* context (config + prose + task ops) → one
  structural batch (`add-context` with `configFromContextId`, `add-edge`,
  `remove-edge` on an unstarted target) → `--dry-run` (no persist, no revision
  bump) → a deliberately stale `baseLiveRevision` (assert 409
  `revision_conflict` + `currentLiveRevision`) → `live resume`.
  Assert: scheduler picks up graph changes on the next tick; `liveRevision`
  bumps once per accepted batch; audit rows + SSE events carry `source: "cli"`;
  frozen contexts rejected with `frozen`.
- **Scenario B — doc 06 UI.** Config tab shows full resolved config + runtime
  facts; classifier-driven affordances (`frozen` lock, `pause-to-edit` button);
  save a config edit from the UI (this would be the **first ever** `source:
  "ui"` event); CLI edits appear in the UI without manual refresh (SSE
  invalidation); revision-conflict recovery surface.
- **Scenario C — doc 05 smoke.** Against a saved definition: `workflow get`
  outline + a section selector; an `edit` batch with `--dry-run` then applied;
  a stale `baseRevision` conflict; confirm via `get --full`.

Exit evidence: all three scenarios green with recorded assertions; at least one
`cli` structural edit and one `ui` config edit exist in the events table.

### W2 — Slice 5 (UI structural forms): recommend **defer, not part of Phase 0**

Doc 06 already phases it as phase 2 and Alex accepted the CLI-only parity gap.
The next consumer (D1 plan-repair) is CLI-driven. D4 (conditional paths, runtime
expansion, loops) will reshape what "structural editing" even means in the UI —
building forms now invites rework. Revisit at D4 design time; record the
disposition in the roadmap when Alex confirms.

### W3 — Planning-artifact hygiene (done in this session's worktree, uncommitted)

- Roadmap D0 section rewritten to the true state (done alongside this plan).
- Roadmap's "one real fork" bullet reframed (done): doc 06 landed, but **live
  charter amendments are explicitly out of its scope (D13)** while AC / tasks /
  prose / config are editable and `circuit_breaker` halts are
  resumable-editable — so D1's real fork is "AC/task repair only vs. build a
  charter-amendment seam", not "wait for doc 06".
- `.gitignore` fix (done): the root `ROADMAP.md` scratch entry also swallowed
  `docs/roadmap.md` on the case-insensitive macOS FS, so the session's primary
  artifact was silently uncommittable; added a `!docs/roadmap.md` negation.
- Charter: its D0 description is stale the same way the roadmap was. The
  worktree charter copy is read-only (app state is source of truth) — Alex
  updates it app-side, or it gets refreshed at the next alignment update.

### W4 — Housekeeping (flagged for Alex; touches shared git state, not executed)

Delete branch `csm/better-workflow-editing-capability-c6716c` — its content is
fully on main as `0ad3bf4f`; the branch only adds a WIP commit, a main merge,
and a pre-merge auto-fix that were squashed into the landed commit.

## Phase 0 exit criteria

1. ~~W1 scenarios A–C green with evidence~~ — **closed 2026-07-29**: Alex live-tested the
   delivered surface directly.
2. Slice 5 disposition confirmed by Alex and recorded in the roadmap.
3. Roadmap reflects reality (done); charter refresh flagged.

Then Phase 1 opens: D1 / D2 / D3 specs, mutually independent and parallelizable.

**Phase 0 → D1 bridge (picked up 2026-07-29):** Alex chose to build the charter-amendment
seam — the doc 06 D13 exclusion that gates full D1 plan repair. Design:
`docs/design/cc-cli/07-workflow-charter-amendments.md`.

## Phase 1 handoff notes (so the next planner doesn't re-dig)

- **D1:** the halt → `cctl workflow live edit` → resume loop is fully scriptable
  today (`circuit_breaker` is in the `isResumableHalt` allowlist). The open
  design question is charter patching (out of doc 06 scope) and trigger policy
  (breaker-trip only vs. every validation failure).
- **D2:** read ticket #18 Option B **and** the structured-output consolidation
  design in `docs/design/2026-07-12_phase-1-slice-designs.md` (Blocker 1 — a
  different program, but it inventories all seven structured-output mechanisms
  and the projection seam D2 would ride).
- **D3:** extends the `contextValidator`/`implementer` config cascade; the
  resolved-config validation path it must respect now lives behind the doc 06
  frontier checks (`validateResolvedWorkflow` at apply time).
