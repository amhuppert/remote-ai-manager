# Design addendum: the agent surface describes itself

**Status:** APPROVED by Alex 2026-07-25 (ticket command-center#24) and folded into `requirements.md` (R24 + deltas), `design.md` (amendment section + traceability rows), and `tasks.md` (22.x) the same day — this document remains the decision record. Delivery is staged: 22.1–22.5 are the Stage-1 items implemented now; 22.6–22.13 are recorded as deferred with their evidence. Product-design deltas (§7) are **not yet folded** — this amendment writes only inside `.kiro/specs/native-sdd/`.
**Motivated by:** Ticket command-center#24 — a two-agent review of the first real `cctl spec` authoring run, re-verified against the branch. Every finding below is confirmed in current code.
**Extends:** `requirements.md` R1/R6 + new R24; `design.md` CctlSpecFamily, SpecRouteHandlers, Error Handling, Testing Strategy; `docs/design/native-sdd/01-product-design.md` B8/B11 (rev 6).
**Depends on:** `design-staged-authoring.md` (the `advance` refusal and stage vocabulary this addendum makes legible) and `design-plan-stage-execution-planning.md` (the compiled definition the execution handoff must name).
**Date:** 2026-07-25

## 1. The gap

Native SDD's server behavior is correct. Its agent surface is not **knowable**: the addressing vocabulary, the input schemas, the policy authority, the amendment path, and the execution handoff are each discoverable only by reading `src/lib/specs/**`. Inside this repository an agent can read the source and recover; in any other repository — the case native SDD exists to serve — each one is a hard stop. Five separately-reported findings are one defect:

- **Handles are the addressing vocabulary and the authoring surfaces omit them.** `specElementSchema` (`schemas.ts:496-506`) carries `number`, not `handle`, because it is the durable row shape; the `create` and `draft` result envelopes never return the handle just assigned, and `show --json`'s element arrays omit it. The derivation already exists and is already sanctioned — `review-state.ts:15-84` attaches a handle to every element of a snapshot, and both `export.ts:183-230` and `route-handlers.ts:882-892` consume that model — so this is unfinished reuse, not a missing capability. It produced the authoring run's only command failures.
- **The element write document is "schema-backed" but unpublished.** `--file` accepts a kind-discriminated document whose variants, required fields, and enum values exist only in `authoring-service.ts:62-74` and `schemas.ts`. Off this repository, authoring is guesswork.
- **Policy authority is invisible.** That gate policy is per-spec data, mutable, human-only, and changed from Spec Studio appears nowhere in `cctl spec --help`; establishing it cost roughly six tool calls and nearly produced a confident wrong conclusion.
- **The amendment path is undiscoverable.** Continuing an approved spec runs through `spec create` — stated only inside that command's own description (`spec.help.ts:243`) — while help's only prominent use of the word "amendment" is `spec capture` (`spec.help.ts:596-604`), the *execution-time* scope amendment, which actively steers the reader away. The `advance` refusal compounds it: with no open draft, `StaleStageConflictError` (`specs-repo.ts:262-277`) names an approved, immutable revision, and the route instruction (`route-handlers.ts:2141-2153`) says "advance that exact revision if it still applies" — a signpost to a draft that does not exist.
- **The execution handoff hides a designed boundary.** `spec start` prints one line, `started execution <id>` (`write.ts:1006`), while the execution parks in `definition_review` — an intended lifecycle phase (`design.md:261, 271, 319, 521`) whose `approvalRequired` derives from the execution-start dial (`execution-service.ts:1389`) and whose next step is the existing `cctl workflow start <definitionId>` (`workflow.help.ts:99, 108`). Meanwhile `spec status` reports `phase: executing` while nothing runs and `execution_start: not_required` while a different, designed gate holds the work. The defect is the output, not the lifecycle: **this addendum adds no agent approval route and no auto-launch.**

Two smaller truth defects belong to the same failure mode: guidance advertises cross-spec discovery (`native-spec.ts:9`, `.claude/commands/spec.md:32`) that `spec search` does not provide — it is spec-scoped (`read.ts:505-521`) — and `position` is documented nowhere while the repository enforces **one global order per revision with an opaque element-id tiebreak** (`ORDER BY position ASC, element_id ASC`, `specs-repo.ts:631, 713`), not the per-parent order an author naturally assumes.

## 2. The contract

> Every mutating `cctl spec` response states four things: the **resulting state**, the **addressing tokens the server assigned** (element handles, revision, execution, and workflow-definition ids), **what is blocked and which party must act** — agent or human — and the **exact next command**. Every schema-backed input is dumpable from the CLI itself. A refusal names the legitimate next step; a success names the next step too, because a handoff that parks work is as blocking as a refusal.

This is the `instruction` discipline the CC CLI already treats as load-bearing (R6.5), extended from refusals to successes. It is one contract, not five patches: each of §1's stops is an instance of a response that knew something the agent needed and did not say it.

## 3. What changes for the authoring agent

1. `create`, `draft`, `answer`, and `assume` come back with the handle the element now answers to; reads carry handles on every element they return.
2. A mis-typed address is refused with the handle format, per-kind examples, and — when the value is a known element id — the real handle for it.
3. `cctl spec schema [kind]` prints the JSON Schema, enums, constraints, and a worked example for every input document the family accepts.
4. `cctl spec amend <slug>` is the authoring-amendment command, named by the `advance` refusal and disambiguated from `capture` in help.
5. `spec start` says what it did (`execution <id>`, `definition <id>`), what it did **not** do (`workflow launched: no`), what happens next (`cctl workflow start <definitionId>`), and who acts (agent under Notify/Off; the operator under Gate).
6. `spec status` qualifies the phase with the execution's state and names the definition-review park; gates show current-revision state and, separately, historical admission provenance.

## 4. Design decisions

### SD1 — The self-description is a result-envelope contract, never per-command copy

Mutating responses gain the four contract fields at the **result envelope** layer (service result types and their view schemas), not in the durable row shapes. `specElementSchema` (`schemas.ts:496-506`) and `specRevisionSnapshotSchema` (`:546-552`) are parsed from DB rows by `specs-repo` and pinned by round-trip contract tests; they must not gain `handle`. Handles ride in:

- **result envelopes** — `AuthoringSpecCreateResult` (`authoring-service.ts:162-167`) and an authoring-level wrapper around the repo's `CreateDraftElementResult` (`specs-repo.ts:220-223`), computed inside the same transaction that writes the element;
- **view-only projections** — a snapshot *view* wrapper in `view-schemas.ts` over the durable snapshot, built from `handlesByElementId` (`route-handlers.ts:882-892`).

The CLI renders the four fields as fixed lines (state / assigned / blocked-by / next), so `--json` consumers and humans read the same facts.

### SD2 — One handle derivation, and no invented handles

`review-state.ts:15-84` is the canonical derived-handle model; `export.ts` and `route-handlers.ts:882-892` already reuse it. This amendment adds **no third derivation** and collapses the private duplicate at `route-handlers.ts:863-880` onto the shared one, so `pendingApprovals` and `taskPlanStatus` stop re-deriving. Criterion handles resolve their parent requirement through `resolveCriterionBareHandle` (`handles.ts:187-217`) or the in-transaction snapshot.

Sections and number-less elements have no handle: `toLintSnapshot` falls back to the raw element id (`review-state.ts:20-31`). The projection therefore reports `handle: null` for them and labels the fallback value as an element id. Encoding the fallback as `handle: string` would publish a non-address as an address — exactly the confusion this amendment exists to remove.

### SD3 — The invalid-handle refusal explains the grammar and detects element ids

The explanation is domain-owned, in `handles.ts` (both CLI files already import from it), and reused by all three sites: `read.ts:450`, `write.ts:699-704`, and the server path that today ends in a bare `Spec element not found` (`route-handlers.ts:1483, 1511`). It carries the format sentence with per-kind examples (`R1`, `R1.2`, `D3`, `T4`, `Q1`, `A2`, and the slug-qualified form) plus a detected reason. Element ids are caller-chosen `z.string().min(1)` (`authoring-service.ts:62-66`), so grammar alone cannot prove "this is an element id" — the server upgrade uses the loaded snapshot: when the value matches a known element id, the refusal names the real handle ("`requirement-1` is an element id; its handle is `R1`"). The server side uses `notFound(message, code, details)` / `specRefusalResponse`, never a raw `404` literal, so the route-404 seam count (`seam-adoption.ts:317-325`) is unchanged.

**Rejected in review and re-affirmed rejected:** accepting a raw element id through `--element`. Two addressing vocabularies is the defect, not the cure; the refusal copy is.

### SD4 — `cctl spec schema [kind]` publishes the input documents

A read verb printing JSON Schema for every schema-backed input the family accepts — element write documents per kind (`section`, `requirement`, `criterion`, `decision`, `task`), and the execution scope document — generated from the Zod sources so it cannot drift, with enumerated enum values, field constraints, and one worked example per kind. No hand-written duplicate types (house rule); the generator is the single source. Deferred to Stage 2 because it is the largest item and every Stage-1 fix stands without it.

### SD5 — The execution handoff is reported, not crossed

`spec start` reports: `execution <id>`, `definition <id>`, `workflow launched: no`, `next: cctl workflow start <definitionId>`, and the acting party resolved from the execution-start dial — agent under Notify/Off, operator under Gate (the definition-approval boundary, `design.md:260`). `spec status` qualifies the phase (`executing · definition review — no workflow running`) and names the definition and next action. `definition_review` remains a designed park: **no auto-launch, no agent definition-approval route.** Removing definition review would be a separate product decision nobody is proposing.

### SD6 — `cctl spec amend <slug>` over the existing server action

The action already exists and is already agent-reachable: `POST /api/specs/{project}/{slug}/actions/open-amendment` (`route-handlers.ts:2325-2328`), body strictly `{}` (`openAmendmentBodySchema:1739-1742`), response the bare `SpecRevision`, semantics idempotent — an open draft is returned unchanged with no event published, otherwise a draft is created from the latest approved revision with its stage from `openDraftAuthoringStage` (`authoring-service.ts:1348-1396`). The CLI verb is a thin, honest surface over it; `spec create`'s amendment overload keeps working and stops being the only signpost.

Two refusals become legible in the same pass:

- **No open draft at `advance`.** `StaleStageConflictError.currentRevision === null` (`specs-repo.ts:262-277`) is the discriminator: when null, the `stale_stage` instruction (`route-handlers.ts:2141-2153`) names `cctl spec amend <slug>` and states that the identified approved revision is immutable; when non-null, today's copy stands. `details.currentRevision` already carries the discriminator to the CLI. Slug threading uses one closure inside `specActionPOST` (where `resolved.value.spec.slug` is in scope) rather than editing every `invokeAction` call site.
- **No approved revision and no draft.** `SpecDraftUnavailableError` currently degrades to `Spec target not found` (`route-handlers.ts:2184-2189`); it becomes an explanatory refusal naming the create path, since `amend` is the command an agent will hit with it.

### SD7 — `capture` and `amend` name each other

`capture` (`spec.help.ts:596-604`) is the **execution-time scope amendment** (a task on a draft based on the run's pinned revision); `amend` is the **authoring amendment** (a new draft revision of an approved spec). Each help entry states which amendment it performs and names the other; `draft` and `advance` list `amend` in `related[]`. Adding a command also regenerates the skill reference block validated by `scripts/cc-cli-skill-reference.test.ts`.

### SD8 — Policy authority is stated where it is looked for

One line in the `spec` family help: gate policy is per-spec data, mutable, human-only, changed from Spec Studio, with no CLI verb (D5 — `cctl spec` has no policy verbs, by design). A metadata-generated authority table across the whole family (which actions are human-only, per `HUMAN_ONLY_ACTIONS`, `route-handlers.ts:2061-2078`) is the later, better version and is not required for the truth to be available.

### SD9 — Guidance tells the truth about search, and the two guidance surfaces are pinned together

`spec search` is spec-scoped (`read.ts:505-521`), so both guidance surfaces stop advertising cross-spec discovery (`native-spec.ts:9`, `.claude/commands/spec.md:32`). The runtime `/spec` expansion (40 lines) and the repository guidance (92 lines) have drifted with no test between them; they gain a parity check that fails on divergence — shared structured content is the preferred shape, a content-equality assertion the acceptable minimum. Project-wide search (`list --query` or `search --all`) is deferred (task 22.8); when it lands, the guidance is restored to describing it.

### SD10 — The `position` ordering contract is decided: one global order per revision

Today's behavior is the contract, stated rather than inferred: `position` orders **all** elements of a revision, ties broken by element id (`specs-repo.ts:631, 713`); parent/child nesting is derived from `parentElementId`, never from position. The refinement (task 22.7) is a server-assigned deterministic **append** when a write omits `position`, so an author never has to guess a global coordinate to add an element — the case that made the run's assumption of per-parent ordering costly. Per-parent renumbering was rejected: it would make every element's stored position depend on its siblings' history, breaking the copy-on-write snapshot invariant that revision content is a row-set copy.

## 5. Deferred design notes (evidence recorded, design not yet done)

Recorded here so the evidence is not lost and the work is not smuggled into an unrelated change.

- **Approval-request validation.** `requestApproval` (`review-service.ts:998-1043`) validates only that the spec and revision exist: the caller-supplied `gate` and `subject` are trusted, and every call mints a fresh `attentionId`. Stale (gate no longer pending) and duplicate (same gate/subject requested twice) Needs You entries are therefore both reachable. The design target is applicability + pending-state validation, a logical idempotency key, and returning the existing active request on repeat — not a new notification mechanism. Task 22.9.
- **Per-write full-spec read.** Every single-element write first fetches the whole spec detail (`write.ts:255-274`, sites `:453, :506, :562, :916, :975`), so an authoring session of *n* writes transfers O(n²) content — the dominant cost of the observed run, before any batching. The design target is a lightweight edit-context read (current revision id, stage, and the target element's version) that is independent of, and earlier than, batching. Task 22.10.
- **Atomic batch element write.** The write API takes one element (`authoring-service.ts:62-74`), which cost 59 process invocations for initial authoring. The batch design is constrained, not open: it **must** preserve per-element `baseElementVersion` CAS inside one all-or-nothing transaction and return **indexed per-element refusals**; collapsing to a single revision-level CAS token would replace element-granular optimistic concurrency (R7.1–7.4, the one concurrency guarantee this feature invented) with document-level locking in all but name. A revision-level token may only ever be additive and optional. Atomic create-with-first-element (R4.1) must survive: batch must not reintroduce a content-free create. Task 22.11.
- **Read-projection DTO normalization.** `show --json` returns raw persistence rows for `executions` and `gateAdmissions` (snake_case keys, `scope_json` as a string — `route-handlers.ts:503, 627, 726, 1047`). Normalization must **retain** execution state and workflow linkage: those raw fields are currently the only way to diagnose a parked execution, so this sequences *after* the SD5 handoff output, never before it. Task 22.12.

## 6. Requirement deltas (folded into `requirements.md`)

- **R6 — add criterion 9:** "Every mutating `cctl spec` response shall report the resulting state, the addressing tokens the server assigned, what is blocked and which party must act, and the exact next command; and every schema-backed input the family accepts shall be printable from the CLI (Requirement 24)."

### New Requirement 24: Agent-surface self-description

Authored in full in `requirements.md` (13 criteria): the four-field response contract; handles in mutation responses and read projections with an explicit no-handle case; the grammar-stating, element-id-detecting invalid-handle refusal; CLI-published input schemas; the truthful execution handoff; phase qualification and the definition-review park; the draft-opening refusal instruction; a first-class amendment command; capture-vs-amend disambiguation; the policy-authority note; search-scope truth with a guidance parity check; the decided-and-documented `position` contract; and gate history presented as provenance without asserting current satisfaction.

## 7. Product-design deltas (fold into `01-product-design.md` as rev 7 when implemented — not folded here)

- **B8:** add that the agent surface's self-description is part of the enforcement contract — a response that parks work names its next actor and command, exactly as a refusal names its next step.
- **B11:** note that `definition_review` is reported by `spec start` and `spec status` as an explicit handoff with the launching command, and that no agent path crosses the definition-approval boundary.
- Record the decision date 2026-07-25 in the doc's decision log.

## 8. Compatibility and observability

- **Dual strict detail schemas.** `specDetailViewSchema` exists twice — `view-schemas.ts:174-217` (CLI) and `queries.ts:109-152` (Spec Studio), both `.strict()`. A projection field must land in both in the same change or one consumer breaks at runtime. Only `specStatusViewSchema` is shared by re-export (`queries.ts:31, 33`).
- **The status shape is declared three times:** the local `SpecStatusView`/`SpecGateStatus` interfaces (`route-handlers.ts:216-250`), the view schemas (`view-schemas.ts:37-98`), and the CLI renderer (`read.ts:126-169`). A field added to fewer than three type-checks but never reaches the agent.
- **Strict CLI response schemas.** `createResponseSchema` (`write.ts:50-57`) and `draftResponseSchema` (`:62-64`) are `.strict()`: the handle field must land server- and CLI-side in one change, or `create`/`draft` start failing with `invalid_response`.
- No schema migration, no new table, and no new refusal code: the improved copy rides the existing `stale_stage`, `not_found`, and refusal shapes. The spec-wide gate-admission history read (task 22.5) is covered by the existing index `idx_spec_gate_admissions_spec_gate` (`state-db.ts:374-375`).
- Seam-neutral: no raw `404` literal is added or removed in `route-handlers.ts` (`seam-adoption.ts:317-325`).
- Observable effect: the §6.1 approval-friction and intervention counters already record refusals; the measure of this amendment is the disappearance of address- and discovery-caused interventions from a second instrumented run (task 22.13).

## 9. Tasks (appended to `tasks.md` as 22.x)

Stage-1 items now: 22.1 handle returns and refusal copy; 22.2 truthful execution handoff; 22.3 amendment path; 22.4 authority and scope truth in guidance; 22.5 gate history without asserted satisfaction. Deferred: 22.6 `spec schema`; 22.7 `position` contract; 22.8 project-wide search; 22.9 approval-request validation; 22.10 edit-context read; 22.11 batch write; 22.12 DTO normalization; 22.13 live journey validation.

## 10. Rejected alternatives

- **Five separate patches for the five findings** — they share one cause; patched individually, the next surface added omits the same four facts again. The contract is the artifact.
- **A second addressing vocabulary (raw element ids through `--element`)** — doubles what an agent must learn to remove one refusal; the refusal copy solves it (SD3).
- **Auto-launching the workflow from `spec start`** — crosses a designed review boundary to hide a missing line of output, and would silently make execution-start Gate policy unobservable.
- **An agent route to approve a compiled definition** — the definition-approval gate is human authority under a Gate dial (17.3); an agent path around it is the enforcement model this feature replaced.
- **Adding `handle` to the durable element schemas** — they are DB row shapes pinned by round-trip contracts; a derived address stored as content is a second source of truth (2.15).
- **Publishing input schemas as hand-written help text** — drifts from the Zod sources by the first change; generation is the only version that stays true.
- **Per-parent `position` renumbering** — makes stored positions depend on sibling history and breaks the copy-on-write row-set snapshot; the global order plus deterministic append gives authors the same ergonomics without it.
