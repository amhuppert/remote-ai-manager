# Brief: workflow-charter

> Part of `graph-workflow-improvements.taskgarden.yaml` → work item `charter`
> ("Workflow Charter + source-of-truth hierarchy", lane: alignment, p1, 5 pts, depends_on: []).
> Grounded in Report §1.1 + §1.2 (`graph-workflow-improvement-report.md`).
> Design decisions below were resolved with Alex via a 24-question collaboration pass.

## Problem

In graph workflows, alignment lives in N independent acceptance-criteria (AC) prose blocks that drift as each context re-explains the world (observed: seed prompts grew 8.2KB → 25.3KB). When an AC restates authoritative behavior and the restatement is wrong, the AC becomes a second, competing source of truth. Implementers and validators then resolve the same conflict with different implicit authority models.

The motivating failure is the AeroTrainer "floor/round" saga: the implementer followed the prototype (correct), the validator enforced the AC's wrong transcription of the handoff doc (NO-GO), and a later context silently reverted it. Three agents, three implicit authority models — costing a wasted iteration, a wrong TDD test, and a silent revert.

**Who/why:** anyone running graph workflows; pain = wrong-spec enforcement, wasted iterations, silent reverts, and inflating divergent seed prompts.

## Current State

- **`schemas.ts`** — workflow definitions have `workflowConfig`, contexts, tasks, edges; **no** charter or source-hierarchy field.
- **`shared-documents.ts`** — shared documents persist only `{ relativePath, description, readWhen }` + ids/timestamps. No `kind`, `version`, `digest`, `authority`, or acknowledgment state. They are **pointers, not content**.
- **`iteration-prompt.ts`** — implementer prompt injects a one-line pointer per shared doc; the agent reads the file on demand. `buildFollowUpPrompt` injects neither shared docs nor a charter.
- **`validator-runner.ts`** (`buildContextValidationPrompt`) — injects only acceptance criteria, context metadata, and task summaries. **No shared-document/charter section** — charter injection into the validator is entirely new wiring. Standing guidance ("intent over strict wording") is underspecified for AC-vs-source conflicts and, left alone, preserves the old failure mode.
- **`tool-server.ts`** — no `acknowledge_artifact` tool.
- **`execution-repository.ts`** — new executions seed `sharedDocuments: []`; planning-time charter data needs explicit carry-forward into execution state.
- **`resolve-config.ts`** — the config cascade is for operational defaults (implementer/validator/scriptValidator/mutability/collaboration), not semantic content.

## Desired Outcome

For a **new** graph workflow that declares a charter:
- Every implementer **and** validator prompt carries a charter **digest at the top**, including the declared source-of-truth hierarchy and the prompt-level rules for applying it.
- When an AC conflicts with a higher-ranked source and the implementation follows the higher source, the validator does **not** fail for the AC mismatch — it records the conflict in its summary (until `validator-trust`/ESCALATE lands).
- The charter is authored pre-execution, canonical on the workflow definition, mirrored to a readable file, and propagated into execution state.

## Approach

A first-class **charter** authored at planning time and resolved into each context's prompts. Chosen shape and storage (resolved with Alex):

- **Shape:** hybrid typed envelope — a *structured* `sourcesOfTruth` list plus *markdown* narrative sections (mission, ownership map, conventions, non-goals, vocabulary, test strategy, known-ambiguities).
- **Source entry fields:** `rank`, `id`, `label`, `type`, `locator`, `description`, `appliesTo`, `accessPolicy` (small enum, e.g. `worktree-relative | external-readonly`); defer rationale/conflict-notes (rank already encodes precedence).
- **Storage:** canonical on the workflow definition + resolved working definition; mirrored to a registered charter file (reserved `kind: "charter"`) for agent read-access. **Not** modeled as config-cascade data. A deliberate definition→execution-state propagation step runs at seed time.
- **Reserved kind:** a dedicated charter model (canonical in the definition) that **also** registers a shared-document pointer for file access.
- **Injection:** a concise digest is injected inline at the **literal top** of both prompts; the full charter is available on demand as a file. A cheap charter id/reference appears in every prompt; the full digest is included on the seed and on session rotation / fresh context (not blindly every follow-up turn).
- **Behavior in scope:** prompt-level application rules ("higher-ranked source wins; flag the AC rather than failing the implementer") in both prompts; the validator guidance amendment above; implementers cite the hierarchy in `complete_task` summaries when resolving an actual conflict.
- **Lifecycle:** required at create-time for **new** definitions; the persisted schema treats `charter` as **optional** so existing charter-less records still parse (no migration).
- **Success bar:** prompt evidence (charter + hierarchy present in both prompts) **plus** a behavioral fixture reproducing a source-vs-AC conflict the validator resolves correctly.

(No competing approaches remain to evaluate; the collaboration converged on the above. The only consistency item to encode carefully: "required for new definitions" governs the create/replace validation path, while the stored schema keeps `charter` optional so existing records load.)

## Scope

- **In**:
  - Charter data model (hybrid typed envelope + structured `sourcesOfTruth`) on the workflow definition + resolved working definition.
  - Reserved `kind: "charter"`: dedicated charter model that also registers a mirrored shared-document file for agent read-access.
  - Definition→execution-state propagation of the charter at seed time.
  - Digest generation; digest injected at the top of **both** implementer and validator prompts; full charter available on demand; charter id/reference in every prompt incl. `buildFollowUpPrompt`; full digest on seed + session rotation.
  - Prompt-level rules for applying the source hierarchy (implementer + validator) and the validator guidance amendment (pass + record conflict, don't fail on AC-vs-higher-source mismatch).
  - Implementer instruction to cite the hierarchy in `complete_task` summaries on conflict.
  - Create/replace validation: charter required for new definitions; optional on the persisted schema.
  - Outside-worktree source entries allowed as read-only/descriptive via `accessPolicy`; never auto-read/write/validate; explicit permission for any out-of-worktree access.
  - Observability: lifecycle/log events + SSE for charter register/update.
  - Tests: schema parse + round-trip durability contract, planner create/replace, definition→execution-seed propagation, implementer prompt injection, validator prompt injection, follow-up prompt behavior, event/log + SSE publication, and a source-vs-AC conflict behavioral fixture.
- **Out**:
  - `acknowledge_artifact` MCP tool and all acknowledgment semantics (deferred entirely from v1) — and therefore any separate charter "version" field (version = working-definition revision).
  - Per-context charter overrides / subsetting (charter is workflow-global).
  - Runtime charter refinement by an early design context.
  - Backward-compat retrofit for existing executions / running or resumed executions (new definitions + new executions only; no migration).

## Boundary Candidates

- **Charter schema + source-of-truth model** (data; Zod-first, `z.infer` types).
- **Storage + propagation** (definition canonical → resolved working definition → execution seed → mirrored file registration).
- **Prompt injection** (digest builder + placement at top + follow-up referencing, across both `iteration-prompt.ts` and `validator-runner.ts`).
- **Hierarchy-application behavior** (prompt-level rules + validator guidance amendment + implementer citation).
- **Create/replace validation** (charter required for new definitions; parse-tolerant for old records).
- **Observability** (lifecycle events + SSE).

## Out of Boundary

- ESCALATE / NO-GO+ verdicts, `appeal_validation`, pre-reopen adversarial verify → **`validator-trust`** (taskgarden, depends_on: [charter]).
- Deterministic plan-time lint (referenced-path existence, "cite don't restate") → **`spec-lint`**.
- Typed deliverables + contract-freeze / `mayAmendContracts` (and any reuse of a high-authority/ack flag) → **`typed-contracts`**.
- Approval-gate digest surfacing of the charter → **`gate-and-steering`**.
- Execution-inspector / builder UI for the charter → **`ui-legibility`**.

## Upstream / Downstream

- **Upstream** (this depends on / extends): `shared-documents.ts`, `iteration-prompt.ts`, `validator-runner.ts`, `workflows/schemas.ts`, `planner-tools.ts` (create/replace handlers), `execution-repository.ts` (seed propagation), `execution-logger` + SSE bus, `resolve-config.ts` (deliberately *not* the cascade). Taskgarden `depends_on: []`.
- **Downstream** (likely consumers): `validator-trust` (declares `depends_on: [charter]`; needs the declared hierarchy), `spec-lint` ("cite don't restate" references the declared sources), `typed-contracts` (may later reuse a high-authority/ack mechanism), `gate-and-steering` + `ui-legibility` (surface the charter), `integration-sweep`.

## Existing Spec Touchpoints

- **Extends**: none directly — this is a new feature. It builds atop the graph-workflow engine delivered by `composable-workflow-primitives`, `workflow-graph-builder`, `workflow-continuity`, and `human-review-gate`, but does not modify their spec boundaries.
- **Adjacent** (avoid overlap): `human-review-gate` (the approval gate — charter adds no gate behavior in v1), `agent-invoked-collaboration` (collaboration slice — out of scope), `reference-documents` (shared-docs adjacent).

## Constraints

- **Engineering principles**: Zod-schema-first with `z.infer` types (no hand-written duplicates); no `vi.mock` of internal modules (DI via factory / `.provide()` / setter patterns); structured logging via `createLogger`; a persistence **round-trip durability contract** for every new persisted field on the definition/execution.
- **Worktree isolation**: outside-worktree source entries are read-only and permission-gated; never auto-read/written.
- **Compatibility**: existing persisted definitions must still parse (charter optional on the stored schema); no migration; no backward-compat retrofit.
- **Optimization preference (report)**: quality > friction > alignment > token economy > wall-clock speed.
- **Language**: spec docs in `en` per `spec.json`.
