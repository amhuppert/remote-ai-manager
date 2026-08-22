# Graph workflow — lanes-first builder and execution

Design bundle for the graph workflow **builder** and **execution** pages.
Everything here is a design artifact. No engine, schema, persistence or
execution behaviour changes. One intentional frontend behaviour change is
approved and specified in §2.1: dragging a context between swimlanes edits its
existing `placement.lane`.

Read this file first, then `0 Index.dc.html`, then the canonical files it links.

---

## 1. Canonical files

| File | What it is |
| --- | --- |
| `0 Index.dc.html` | Entry point. Links every canonical screen, states the accepted direction. |
| `Workflow Builder.dc.html` | Desktop builder: definitions sidebar, toolbar, lane canvas, inspector rail, drag-between-lanes states, ephemeral lane states. |
| `Workflow Execution.dc.html` | Desktop execution: executions rail (Current/History), status bar, lane canvas, inspector; six execution-state examples. |
| `Config Panel.dc.html` | The configuration editor component, mounted by both pages. Host-aware (`builder` / `execution`). |
| `Workflow Mobile.dc.html` | Builder and execution at ≤768px, both panel sets, bottom toolbar, nested-config return path. |
| `Context Node.dc.html` | The canonical context-node component. It is props-driven and mounted by every canvas; the variant gallery is in `0 Index.dc.html`. |

**Archived, not accepted** — files prefixed `ARCHIVE `. They are earlier
explorations kept for provenance only. Nothing in them is a specification.
`ARCHIVE Graph Workflow Redesign.dc.html` contains the round-first transcript
exploration that was **discarded** in favour of conversation-first history (§10).

---

## 2. Approved decisions

### 2.1 Dragging a context between lanes (the one behaviour change)

- Dragging a node **within** its lane edits visual layout only (`nodePositions`),
  never semantic data.
- Dragging a node **across** a lane boundary edits exactly one semantic field:
  that context's `placement.lane`.
- The context's grade is preserved verbatim: `full`, `owned` (with its
  `ownedPaths`), or `readOnly`. Nothing else in `placement` is touched. There is
  no silent re-grading and no path rewriting.
- While dragging, a drop preview names the change in full:
  `Re-place → lane: delivery · grade: owned (src/checkout, src/risk) · unchanged`.
- On drop, existing placement validation runs against the post-drop draft before
  the change is accepted (`validateAuthoredDefinition` — lane-name grammar,
  reserved-lane rules, read-only output contract, same-lane concurrency).
- An invalid drop is **refused**: the draft is not mutated, the node returns to
  its lane, and the refusal states the concrete reason and the remedy, e.g.
  *"`session` admits only read-only contexts. "Implement checkout" is owning
  (src/checkout, src/risk). Change its grade to read-only, or drop it on a group
  lane."*
- No new schema, no new engine behaviour, no lane entity.

### 2.2 `+ New lane` is ephemeral builder UI state

- An empty lane is client-only draft UI. It is not an authored entity and is
  never serialized. Creating one does **not** make the semantic definition dirty
  (the toolbar keeps saying *All changes saved*).
- It becomes real only when a context is added or dragged into it — that
  context's `placement.lane` changes, the definition becomes dirty, and Save
  persists it.
- Empty lanes disappear on Reset, reload, workflow switch, and Save.
- Moving the last context out of a lane removes the lane from the canvas.
- Typing a name that matches an existing lane means *use the existing lane*; the
  builder says so instead of creating a duplicate band.
- Lane names use the existing lane-name validation (`[A-Za-z0-9_.-]+`, spliceable
  into a branch name and worktree path).
- `session` is reserved: it is the session worktree, admits read-only contexts
  only, and is never provisioned as a group lane. `__session__` is the engine's
  internal id and is never authored.

### 2.3 Validator de-duplication is out of scope

The redesign reorganises where existing validation information is *shown*. It
does not change issue ownership, filtering, or source of truth. All prototype
copy promising a new or broader de-duplication algorithm has been removed.

### 2.4 Right-rail width is an approved design-system exception

420px for the mounted rail on both pages (the standard is 340px). The standalone
component study renders at 470px. Every other design-system rule is in force
(§12).

---

## 3. Canonical fixture

One fixture, used identically in every file. Any file that disagrees with this
table is wrong.

### 3.1 Definition

- Workflow: **checkout-v2 release train** — `wf_checkout_v2`
- Builder draft revision: **r5**, unsaved
- Contexts: **6** — all six are rendered in every full-canvas screen
- Lanes on the canvas: `plan`, `candidate-rules`, `delivery`, `session`
- Charter invariants: `inv-1` (global) *No customer-facing write path may bypass
  the audit log.*; `inv-2` (scoped to `ctx_checkout`) *Migrations are additive
  within a release train.*
- Sources of truth: `src-spec` rank 1 · spec · `docs/specs/checkout-v2.md` ·
  scoped to `ctx_checkout`; `src-threat` rank 2 · review ·
  `docs/security/payments-threat-model.md` · global
- Launch parameters: `target_branch` — string, "Target branch", required,
  default `main`; `rollout` — enum `canary | full`, "Rollout mode", optional,
  default `canary`

### 3.2 Contexts

| id | title | lane | grade | status | tasks |
| --- | --- | --- | --- | --- | --- |
| `ctx_plan` | Plan the migration | `plan` | full | completed | 3/3 |
| `ctx_rules` | Evaluate rules engine | `candidate-rules` | owned · `docs/eval` | completed | 2/2 |
| `ctx_checkout` | **Implement checkout** | `delivery` | owned · `src/checkout`, `src/risk` | running | 3/5 |
| `ctx_settings` | Settings surface | `delivery` | owned · `src/settings` | running | 1/3 |
| `ctx_rollout` | Rollout switch | `delivery` | full | pending | 0/2 |
| `ctx_notes` | Release notes | `session` | readOnly | pending | 0/2 |

`candidate-rules` is an authored lane, not a runtime expansion — this fixture
has no runtime lane creation, and the expansion ledger reads *none in this
execution*. `ctx_rollout` is `full` on `delivery`: it requires exclusive
occupancy, so it cannot start while the two `owned` members run — the canvas
says so rather than implying a lane has one grade.

### 3.3 The selected context — `ctx_checkout`

Identical in the node, the lane header, the inspector, the config panel, the
approval surface and the transcript history.

- Placement: lane `delivery`, grade `owned`, paths `src/checkout`, `src/risk`
- Status **running**, **iteration 2**, loop pass **2 of 3** (loop group
  `implement-review`), tasks **3/5**
- Implementer: profile `project/checkout-impl` · claude · **opus-4.1** · high
  — *set on this context*
- Validator cohort: **enabled**, inherited from workflow — `security`
  (`core/security-reviewer`, blocking, conversation, claude sonnet-4.5, high) and
  `style` (`project/style-reviewer`, advisory, task, claude haiku-4.5, medium)
- Second agent (collaboration): codex **gpt-5-codex**, medium
- Model ids: the DS `ModelSelector` takes the short `value` (`opus`, `sonnet`,
  `haiku`); every surface **displays** the canonical long name (`opus-4.1`,
  `sonnet-4.5`, `haiku-4.5`, `gpt-5-codex`). No surface shows the short id.
- Latest verdict: **rejected**, iteration 1, seat `security`, 10:42 — *risk rules
  bypass the audit log on the timeout path*; reopened `task-risk-rules`
- Iteration 2 validation is **in flight** (`security` validating, 11:09)
- Conversations: **3**
  - `conv_88d0` 09:40–10:29 — iteration 1, ended on context limit
  - `conv_a9c2` 10:31–10:57 — ↺ rotation from `conv_88d0`; task completed 10:38;
    `security` rejected 10:42; iteration 2 began 10:42; superseded 10:57
  - `conv_b41f` 10:58– — live; task completed 11:04; `security` validating 11:09
- Output schema: 4 properties, 2 required — **every count in the UI is derived
  from the schema text, never hard-coded**

### 3.4 Config provenance for `ctx_checkout`

Counts are stated by kind and never merged into one word:
**2 blocks · 1 role · 1 field set on this context.**

| Setting | Resolves from | Granularity |
| --- | --- | --- |
| Implementer | **context** | block |
| Iteration policy | **context** | block |
| Agent validation — context validator | **context** (`only: test, typecheck`) | role |
| Agent validation — implementer | workflow (`all except build`) | role |
| Collaboration — negotiation rounds | **context** (3) | field |
| Collaboration — enabled / second agent / threshold | workflow | field |
| Validator cohort, script validator, human approval gate | workflow | block |
| Ask user questions, circuit breaker, plan repair, mutability | global | block |
| Lane-merge validation | workflow only — contexts cannot override | field |

### 3.5 Execution

- Current: `exec_7f3a` — **running**, launched from definition **r4** (immutable
  launch snapshot), bound inputs `target_branch=main`, `rollout=canary`
- History: `exec_5c10` completed Aug 14 · `exec_41bd` aborted Aug 12
- The builder draft is r5. The running execution is r4. Saved template edits do
  **not** leak into an active execution — this is why the two revisions differ
  on purpose.

---

## 4. Lane and placement semantics

A lane has **no** placement mode. Grade belongs to the context.

**A lane header may show:** lane name · runtime status (active / merged /
pending / read-only) · branch and worktree · target join or publication ·
member count · a member-grade summary such as *2 owning · 1 read-only*.

**A lane header may never show:** `mode full`, `mode owned`, `full access`, or
any single grade for the lane.

**Each context shows its own grade** on the node and in the inspector: `full`,
`owned` with its paths, or `readOnly`.

Concurrency rules, as stated by the canvas and the drag tooltip:

- Several `owned` members may run at once when their canonical owned paths are
  disjoint.
- A `full` member requires exclusive occupancy of its lane while it runs.
- The reserved `session` lane requires `readOnly`. `readOnly` does **not** imply
  the session lane — a read-only context may sit on any shared lane.
- **Published** is a derived UI state shown after publication. It is never
  presented as a stored context status; the stored statuses are the engine's.

The node, the lane header, the inspector, the config panel and the drag tooltip
all read placement from the same fixture and describe it the same way.

---

## 5. Builder — preserved behaviour

Every existing destination, with where it lives in the redesign.

| Capability | Destination |
| --- | --- |
| Definitions sidebar | Left rail, collapsible to a 48px strip |
| Select workflow | Definitions sidebar row |
| Create workflow | `+ New workflow` at the head of the definitions sidebar |
| Rename workflow | Click the name in the toolbar (inline edit, Enter / Esc) |
| Add Context | Toolbar `+ Add Context` |
| Save Draft | Toolbar, disabled unless dirty; blocked while validation errors or invalid output-schema text exist |
| Reset | Toolbar, disabled unless dirty |
| Re-layout | Toolbar |
| Workflow settings | Toolbar |
| Delete workflow | Toolbar, danger styling, confirm dialog |
| Delete context | Inspector, Context scope, bottom of the Brief group, confirm dialog |
| Saved / unsaved / validation-error state | Toolbar status: green dot *All changes saved* · amber dot *Unsaved changes* · red *Validation errors* |
| Canvas selection | Click a node; click empty canvas to deselect |
| Dependency connection | Drag from a node's right port to another node's left port |
| Node / edge deletion | Select + Delete key, or the node's context menu |
| Zoom · pan · fit | Canvas control cluster, bottom-right: `−` / `%` / `+` / fit |

Not present, deliberately: **no Launch action** (launching a template belongs to
the existing session/template launch flow) and **no separate Validate action**
(the toolbar status already exposes the same definition validation; Save stays
blocked by validation errors and by invalid output-schema text).

Selection and scope: nothing selected → **Workflow** scope. Selecting a context
selects it and switches to **Context** scope automatically. Both scope tabs stay
navigable while a context is selected.

Semantic definition data and visual node layout stay distinct: layout drags
write `nodePositions`; only a lane crossing writes `placement.lane`.

---

## 6. Configuration editor — completeness

Twelve configuration blocks exist. **Eleven** are available at context scope;
lane-merge validation is workflow-only.

**Workflow scope** — Charter (invariants; ranked sources of truth; per-context
source scoping) · Launch parameters (name, type, label, required, default, enum
options) · Agents · Quality gates · Execution policy · Lane-merge validation.

**Context scope** — Brief (title, description, ordered acceptance criteria,
output schema, read-only direct-upstream inputs) · Placement · Agents · Quality
gates · Execution policy · Tasks (ordered) · Delete context.

**Output schema** editing shows all four states: valid JSON · invalid JSON
(parse error with position) · valid JSON outside the engine's supported subset
(named unsupported keyword) · and the consequence — **Save is blocked while the
text is not acceptable**, in the builder and on the execution page alike. Field
and required counts shown anywhere in the UI are derived from the parsed schema.

**Round-tripping.** Values the surface does not author are preserved verbatim
through every edit. `mutability.allowAgentContextAdd` is the worked example: it
is displayed as a preserved value with no editor, so an implementer knows it
must survive a write. The same rule applies to any future unexposed field.

---

## 7. Cascade and provenance

The cascade is **Global → Workflow → Context**. Overriding is not "copy the
whole resolved block" — granularity differs by block, and the UI matches it.

| Block | Granularity | Reset target |
| --- | --- | --- |
| Implementer | whole block | block |
| Context validator cohort | whole block | block |
| Script validator | whole block | block |
| Human approval gate | whole block | block |
| Ask user questions | whole block | block |
| Iteration policy | whole block | block |
| Circuit breaker | whole block | block |
| Mutability | whole block | block |
| Plan repair | whole block | block |
| Collaboration | **per field** | field |
| Agent validation | **per role** (implementer, context validator) | role |
| Lane-merge validation (workflow only) | **per field** (strategy, commands) | field |

Rules the UI enforces:

- Every inherited value states its exact provenance: `G` global, `W` workflow,
  and a tooltip naming the tier.
- Editing one agent-validation role never promotes the other; the untouched role
  keeps showing `G` or `W`.
- Editing one collaboration field never promotes its siblings.
- **Reset to inherit** clears the local override at that granularity — block,
  role, or field — and the row returns to showing its inherited value.
- **Reset all** clears every local override at the current tier. It restores
  inheritance; it does not restore a seeded fixture.
- The header count is stated by kind: *2 blocks · 1 role · 1 field*. A gate
  switched **off** at this tier is counted and coloured separately from a
  neutral override.

---

## 8. Live execution configuration

The execution page mounts a **context-oriented** config surface. There is no
generic editable Workflow-default scope on a live execution. Workflow-scope live
changes (lane-merge validation, charter amendment) are separate existing
behaviour and are not part of this panel.

A running execution uses its **snapshotted working configuration**. Accepted
live edits may affect subsequent work. Editing the saved template does not reach
an active execution.

### 8.1 Affordance matrix

| Mode | When | Surface |
| --- | --- | --- |
| **Editable** | context unstarted, or context started while the execution is quiescent | Full editor + sticky save bar |
| **Pause to edit** | context in progress while the execution is running | Amber banner *"This context is in progress. Pause the workflow to edit it."* + `Pause to edit` (`Pausing…`) |
| **Frozen** | context completed | Lock banner *"This context has completed — its configuration is frozen."* All editors disabled. Output schema is additionally frozen once output was captured against it |
| **Read-only** | execution completed · aborted · halted non-resumably · awaiting definition approval | Banner carrying that reason verbatim |

Read-only reason copy, verbatim from the classifier:

- completed — *This execution has completed and can no longer be edited.*
- aborted — *This execution was aborted and can no longer be edited.*
- halt-not-resumable — *This execution halted with a non-resumable reason and can
  no longer be edited.*
- awaiting-definition-approval — *This plan is parked awaiting definition
  approval; approve or reject it before editing.*

Output-schema disabled hints, per mode: frozen — *The output was already captured
against this schema — editing it now would not re-validate anything.*;
pause-to-edit — *Pause the execution to change the contract before the next
iteration runs.*; read-only — *This execution is no longer running; its working
definition is immutable.*

### 8.2 Live edit flow

`Pause to edit` → paused, editable → dirty (`Save changes` enabled) → validation
failure blocks save (invalid schema text, invalid placement) → `Saving…` →
either success (then `Resume workflow` is offered) or a failure banner:

- Revision conflict — *"The execution changed since you started editing. Review
  your changes and retry."*
- Save error — the server's message, at the edit site, `role="alert"`.

---

## 9. Executions rail, states and controls

**Current vs History is tenure, not terminality.** An execution is *Current*
while it holds the session's execution lease. A paused execution and a resumably
halted execution that still holds its lease stay in Current. History is
newest-first, selectable, deep-linkable, and fully read-only; each historical
row carries its immutable launch snapshot.

| State | Rail | Controls |
| --- | --- | --- |
| Pending | Current | Abort |
| Pending, awaiting definition approval | Current | Approve · Reject (definition) |
| Running | Current | Pause · Abort |
| Paused | Current | Resume · Abort |
| Halted, resumable, lease held | Current | Resume · Abandon |
| Halted, non-resumable or abandoned | History | — |
| Completed | History | — |
| Aborted | History | — |
| Any historical selection | History | — |

Every control has an idle and a pending label (`Pause` → `Pausing…`, `Resume` →
`Resuming…`, `Abort` → `Aborting…`, `Abandon` → `Abandoning…`), is disabled while
pending, and destructive controls confirm first (*"End this resumably halted
execution's lease and move it to History."*).

---

## 10. Approval, landing and publication are four different things

`Approve & land` is gone. It merged a decision with a runtime outcome.

1. **Definition approval** (pre-run) — the parked plan is approved or rejected
   before the execution starts. Rejection moves the execution to History.
2. **Context approval** (post-validation) — reviews the candidate frozen for that
   gate. Approval lets orchestration continue; it does not promise landing or
   publication. Rejection requires non-empty feedback, returns the work to the
   implementer, and validators rerun. Unrelated sibling contexts keep running.
3. **Lane join** — a runtime state with its own status and recovery (conflicts,
   retry, manual resolution guidance).
4. **Publication** — the final landing of a lane into the session worktree,
   again a runtime state.

Candidate states on the context approval surface: **loading** · **ready** (with
the correctly scoped diff) · **drifted** · **unavailable**. Approve is disabled
until the candidate is ready. Reject stays available in every state — it is the
way out of drift and unavailability.

Multiple gates are surfaced as a list with a count (*2 awaiting approval · 1
parked question*), each row naming its context. There is no single global gate.

### Conversation-first history

The durable row is the **conversation**; iterations and conversations are
many-to-many (a context-limit rotation splits an iteration; a returning
validation continues one). Iteration boundaries, task completions, verdicts and
rotations are events *inside* a conversation row. Implementer and validator
transcripts stay independently reachable. The round-first exploration is
discarded and marked as such in the archive.

---

## 11. Execution inspector — relocation map

Nothing was dropped. Destinations: **Overview** (nothing selected), context
header, the three context tabs **Tasks · Config · History**, the **Log** panel,
the lane rail, or a dialog.

| Existing surface | Destination |
| --- | --- |
| Launch revision and seed | Overview → Launch |
| Origin, immutable launch snapshot | Overview → Launch |
| Bound launch inputs | Overview → Launch |
| Workflow / context / task / edge / join counts | Overview → Shape |
| Context brief, acceptance criteria | Tasks tab → Brief |
| Tasks and task history | Tasks tab → Tasks |
| Captured output (pending / captured / rejected) | Tasks tab → Output |
| Direct upstream dependencies | Tasks tab → Brief → Upstream inputs |
| Authored placement | Config tab → Placement |
| Runtime lane, branch, worktree, activity, merge, cleanup | Context header → lane chip, and Config tab → Runtime |
| Guarded routing and route resolution | Tasks tab → Routing |
| Loop state and full loop history | Tasks tab → Loop; full ledger in Overview → Loop ledger |
| Runtime expansion provenance | Tasks tab → Provenance; ledger in Overview |
| Validator cohort state and frozen roster | Config tab → Quality gates → Validator cohort |
| Validation rounds and artifacts | History tab → Rounds |
| Specialist transcripts | History tab → conversation row → Transcript |
| Script logs | Log panel |
| Usage / reference metadata | History tab → round footer |
| Advisories and recertification | Overview → Advisories; each advisory deep-links to its round |
| Circuit breakers | Config tab → Execution policy; trips appear in Overview → Events |
| Parked user questions | Overview → Gates list; answering opens the context |
| Events | Overview → Events |
| Approval history | Overview → Approvals |
| Shared documents | Overview → Documents |
| Join conflicts and recovery guidance | Lane rail → join card, and Overview → Gates list |
| Durable execution result | Overview → Result |
| Narrow validator reset | Config tab → Validator cohort → per-seat reset (paused or halted only) |
| Destructive context reset | Config tab → footer, danger, confirm dialog |
| Output-schema repair navigation | Halt card → *Edit schema* → Config tab → Brief → Output schema |

Semantic navigation preserved: context → Inspector · task or validator → Log
transcript · close transcript → Graph · output-schema halt → Context Config ·
advisory origin → Context History at the round that raised it.

---

## 12. Responsive behaviour

Desktop layouts are described in px for fidelity; they are **not** the
responsive implementation. Below 1100px the rails collapse to strips before
anything else changes.

At **≤768px** exactly one primary panel is visible, with a fixed bottom toolbar
that respects the safe area. All targets ≥44px. Same information, same actions.

**Builder panels: Graph · Defs · Inspector.** Default **Graph**. Selecting a
context switches to **Inspector** on Context scope. Selecting a definition in
Defs switches to **Graph**. Graph controls (zoom / fit / add) sit above the
toolbar as a floating cluster.

**Execution panels: Graph · Inspector · Log.** Default **Graph**. Selecting a
context switches to **Inspector**. Opening a transcript switches to **Log**;
closing it returns to **Graph**. Current/History is a sheet opened from the
status bar's execution chip; selecting an execution closes the sheet and returns
to Graph.

The inspector's nested config drill is a **push navigation**: each level fills
the panel and carries a back row naming its parent (`‹ Quality gates`). The
system back gesture and the back row do the same thing. The bottom toolbar never
moves.

---

## 13. Design-system rules in force

The 420px rail (§2.4) is the only exception.

- **Geist Mono** for interface text; **Manrope** for conversation prose and the
  explanatory notes in these design files.
- Minimum type size 0.7rem.
- Spacing, colour, radius and surface tokens only. Radii: 4px, 6px, 10px, pill.
- Canonical SVG icons throughout — a sprite is defined at the top of each file.
  No Unicode glyph is used as a functional icon.
- Components: Button, IconButton, Badge, StatusDot, Tabs, FormField, Switch,
  SegmentedControl, Select, Checkbox, Progress, Dialog/AlertDialog, and the
  disclosure primitives.
- Violet is reserved for Codex. No decorative gradients or texture fills.
- Pulse animation only on live status indicators; everything animated respects
  `prefers-reduced-motion`.
- Every interactive element is a real control with a visible focus ring. No
  clickable `span` or `div`. Icon-only controls carry accessible names and
  tooltips. Anything reachable on hover is reachable by keyboard and touch.

---

## 14. Out of scope

- Backend, engine, schema or persistence changes.
- A persistent lane entity.
- Generic live Workflow-default editing.
- A builder Launch action.
- New validator de-duplication behaviour.
- New approval or join semantics.
- New authoring for graph fields that are not authorable today.
- Unrelated existing product bugs.
