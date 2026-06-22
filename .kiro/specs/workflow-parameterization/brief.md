# Brief: workflow-parameterization

## Problem

Graph workflow definitions are static, so a workflow is generally only useful for one specific session/feature. To run "the same workflow" for a different feature you must hand-edit or recreate the definition. There is no way to define a workflow once and supply run-specific values (a feature name, a brief, extra context) at launch.

## Current State

- Definition vs. execution are already separated: a `WorkflowDefinitionRecord` is persisted; a run is started from it with only `{ definitionId }` and the definition is snapshotted onto the execution at seed time.
- Per-context human approval gates, charter + ranked sources-of-truth injection, and the global → workflow → context config cascade already exist.
- Nothing is parameterized: `acceptanceCriteria`, task `instructions`, context `title`/`description`, and charter `mission`/`sourcesOfTruth` are static strings with no interpolation. The start endpoint accepts only `{ definitionId }`; there is no MCP tool to start a run.

## Desired Outcome

A definition may declare typed launch inputs. At start, the engine validates supplied values, deterministically substitutes `{{inputs.x}}` into content fields and every agent-rendered charter text field, re-validates the concrete result through the same accept-time/spec-lint path as a hand-authored workflow, and runs the existing engine unchanged. A human launches via a generated form; an agent can launch via a new MCP tool; the planner can declare parameters when authoring. Static workflows keep working as zero-input templates.

## Approach

Additive substitution at seed time (pure engine code — agents never fill templates). **Text substitution only** in v1 (no typed config bindings), so approval gates remain author-fixed per context, with the existing per-context gate as the single approval point. Substitute once at seed, before the existing resolver runs; runtime/agent-added tasks stay concrete (no auto-substitution). Because substitution precedes resolution, the already-persisted resolved working definition + charter snapshot record the concrete post-substitution graph — no separate materialized snapshot is persisted. Fail-closed: an undeclared `{{…}}` reference is a definition-accept-time lint error; a missing required value is a start-time error before any tokens are spent.

## Scope

- **In**:
  - A typed, declarative parameter-declaration block on the semantic definition (each param: name, type, label, required, default, validation/enum options). Types: string, multiline text, enum. Container shape (array vs. record) decided at design time.
  - `{{inputs.x}}` substitution into content fields (task instructions, context title/description/acceptance criteria) and every agent-rendered charter text field (mission, conventions, non-goals, vocabulary, ownership map, test strategy, known ambiguities, and each source-of-truth's label/locator/description/appliesTo); **not** config commands.
  - Deterministic seed-time substitution, run before the existing config resolver.
  - Validation: parse supplied values against the parameter schema; `{{…}}` reference lint at accept time; re-validate the substituted concrete graph through the existing accept-time path.
  - Audit: store `definitionId` + revision and the bound input snapshot on the execution (alongside the existing resolved working definition + charter snapshot, which already record the concrete post-substitution graph).
  - Start API accepts `{ definitionId, parameters }`; raw input snapshot surfaced in audit/UI, not injected into prompts.
  - UI: a launch form generated from the parameter schema + a parameter-declaration editor in the builder.
  - MCP `start_graph_workflow` tool (agents may launch parameterized runs) and a planner/create-tool extension so planner-authored workflows can declare parameters.
- **Out**:
  - Typed config bindings (per-run gate toggles, model/validator selection).
  - Secrets as inputs.
  - `boolean`/`number` parameter types (string/text/enum suffice for v1).
  - A run-inputs blob / per-execution shared run-inputs document, and any generic "Run Inputs" echo section.
  - A separately persisted materialized-definition snapshot or a hash over it (the resolved working definition + charter snapshot already record the concrete result).
  - Cross-project/global template tier (own spec: `global-workflow-templates`).
  - Parameterizing context/task IDs or graph topology (content-only substitution).
  - Mid-run parameter fill; presets / saved parameter sets.
  - Conditional edges / expansion nodes / `propose_graph_patch`; a deterministic "command node" step type.

## Boundary Candidates

- Parameter schema + Zod types on the semantic definition.
- Deterministic substitution pass at seed, before the resolver.
- Validation/lint (accept-time reference check + start-time value validation + substituted-graph re-validation).
- Execution audit field (bound input snapshot; the resolved working definition + charter snapshot already exist).
- Start API + MCP start tool + planner param-declaration.
- UI: launch form + parameter-declaration editor.

## Out of Boundary

- Cross-project/global storage and library (`global-workflow-templates`).
- Pre-flight prerequisite checking (`global-workflow-templates`).
- Any runtime graph dynamism.

## Upstream / Downstream

- **Upstream**: `workflow-graph-builder` (definition + builder UI), `composable-workflow-primitives`, `workflow-charter` (charter + sources-of-truth), `human-review-gate` (per-context approval gate), and the existing execution seed / scheduler / validator / audit machinery.
- **Downstream**: `global-workflow-templates` (consumes the parameter schema + materialization/validation path); future dynamic-structure work (conditional edges / expansion) reuses bound inputs as immutable seed data.

## Existing Spec Touchpoints

- **Extends**: none (additive new capability).
- **Adjacent**: `workflow-graph-builder` (definition schema + builder UI — add params/editor without forking), `workflow-charter` (substitute into charter without muddying charter authority/hash), `human-review-gate` (reuse the gate as-is; gates author-fixed in v1).

## Constraints

- Additive; reuse the existing engine / scheduler / validators / charter / audit.
- Deterministic substitution (no agent step); substitute once at seed, before resolution; no re-substitution at runtime.
- TypeScript strict, Zod-first, no `any`; round-trip durability for new persisted fields.
- General primitive — no Kiro special-casing.
