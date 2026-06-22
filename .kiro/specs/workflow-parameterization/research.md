# Research & Design Decisions

## Summary
- **Feature**: `workflow-parameterization`
- **Discovery Scope**: Extension (additive layer over the existing graph workflow engine)
- **Key Findings**:
  - The definition/execution split, seed-time config cascade, resolved working definition, charter seeding, per-context approval gate, and audit fields all already exist. Parameterization slots in as one deterministic substitution pass between "raw seed definition" and the existing resolver, plus one extra block on the definition schema and one bound-input audit field on the execution. Because substitution runs before resolution, the already-persisted resolved working definition + charter snapshot record the concrete post-substitution graph, so no separate materialized snapshot or hash is needed.
  - There is exactly one seed seam to extend: `createExecutionFromSeed` in `src/lib/workflow-graph/execution-repository.ts` builds `workingDefinition` via `resolveWorkflowDefinition(global, seed.definition)` and snapshots `charter: seed.definition.charter`. Substitution must run on `seed.definition` (a raw `WorkflowSemanticDefinition`) before this, so the entire downstream path (resolve, `validateResolvedWorkflow`, context/task state build, lane plan, charter seed) is reused with zero changes.
  - Accept-time validation already has a single choke point: `assertValidDefinition` -> `validateWorkflowDefinition` in `src/lib/workflow-graph/storage.ts`, invoked by both human (`create`/`update`) and planner (`createWorkflow`/`updateWorkflow`) save paths. The `{{...}}` lint and parameter-shape checks belong here so both authoring surfaces are covered by construction.

## Research Log

### Definition schema and the materialization target fields
- **Context**: Determine exactly which fields are content (substitutable) vs. config (never substituted), and where parameter declarations attach.
- **Sources Consulted**: `src/lib/workflows/schemas.ts` (`workflowSemanticDefinitionSchema`, `graphWorkflowExecutionContextDefinitionSchema`, `graphWorkflowTaskDefinitionSchema`), `src/lib/workflows/charter-schemas.ts` (`workflowCharterSchema`, `sourceOfTruthSchema`).
- **Findings**:
  - Content fields to substitute: task `instructions`; context `title`, `description`, `acceptanceCriteria`; charter `mission`; each `sourcesOfTruth[].locator`.
  - Config fields that must NOT be substituted: `scriptValidator.command` is sourced from `CommandCenter.json`'s `preMergeCommand`, not the definition; agent backend/model/reasoning; iteration/circuit-breaker/mutability blocks; all IDs (`context.id`, `task.id`, edge ids) and `task.order`.
  - `workflowSemanticDefinitionSchema` is the right home for a new optional parameter-declaration block; it defaults cleanly so static definitions parse as zero-input.
- **Implications**: The substitution pass is a pure function over a closed, known set of string fields. IDs and topology are structurally excluded — substitution rewrites string content in place and never touches `id`/`order`/`edges`.

### Seed path and audit fields
- **Context**: Find the single seam to insert substitution and the existing audit surface.
- **Sources Consulted**: `src/lib/workflow-graph/execution-repository.ts` (`GraphWorkflowExecutionSeed`, `createExecutionFromSeed`, `create`), `src/lib/workflow-graph/workflow-manager.ts` (`start`), `src/lib/workflows/schemas.ts` (`graphWorkflowExecutionSchema`: `seedDefinitionId`, `seedDefinitionRevision`, `workingDefinition`, `charter`).
- **Findings**:
  - `seedDefinitionId`, `seedDefinitionRevision`, `workingDefinition` (resolved), and `charter` are already persisted on the execution. The only new audit addition is the bound raw input snapshot. Because substitution runs on `seed.definition` before `resolveWorkflowDefinition`, the persisted `workingDefinition` and `charter` snapshot are already post-substitution — they record the concrete graph the run executes — so no separate materialized-definition snapshot or hash is added.
  - The seed already runs `validateResolvedWorkflow(workingDefinition)` and throws `GraphWorkflowValidationError` on failure. Re-validating the substituted concrete definition through `validateWorkflowDefinition` (the accept-time path) is a natural addition right before resolution.
- **Implications**: Inject substitution into `GraphWorkflowExecutionSeed` as a new `inputs` field, run substitution + `validateWorkflowDefinition` inside `createExecutionFromSeed`, then proceed unchanged. Add one audit field (`boundInputs`) to `graphWorkflowExecutionSchema`.

### Start interfaces (HTTP + MCP) and planner authoring
- **Context**: Determine how launches flow and where the MCP start tool and planner extension attach.
- **Sources Consulted**: `src/lib/workflow-graph/execution-route-handlers.ts` (`startExecutionSchema = { definitionId }`, dirty-start gate, `deps.startExecution`), `src/lib/mcp-gateway/session-server.ts` (tool registration), `src/lib/workflow-graph/planner-tools.ts` (`createWorkflowSchema`, `inflateToSemanticDefinition`, `registerPlannerTools`), `src/lib/workflow-graph/tool-server.ts` (`registerGraphWorkflowExecutionTools` pattern).
- **Findings**:
  - HTTP start request is `{ definitionId }`; extend to `{ definitionId, parameters? }`. The manager `start` -> `executionRepository.create` -> seed path carries the inputs down.
  - There is no MCP start tool today. `start_graph_workflow` is registered alongside the planner tools via `registerPlannerTools` (or a sibling registrar) in `session-server.ts`; it must route through the same start service the HTTP handler uses to keep one validation/materialization path.
  - The planner `createWorkflowSchema`/`inflateToSemanticDefinition` builds the semantic definition from agent input; adding an optional `parameters` array there lets planner-authored workflows declare parameters, subject to the same accept-time lint.
- **Implications**: One start service is shared by HTTP and MCP. The planner gains a parameter-declaration field; the lint guarantees a planner-authored template with a bad `{{...}}` reference is rejected at save exactly like a human one.

### Round-trip durability for new persisted fields
- **Context**: New persisted fields (parameter declarations on the definition; bound-input snapshot on the execution) need durability coverage per project rules.
- **Sources Consulted**: `src/lib/workflow-graph/storage.contract.test.ts` (`assertRoundTripDurability`, `buildMaximalRecord`, `fieldPolicies`), `src/lib/shared/testing/round-trip-durability.ts`, persistence-fixture conventions in CLAUDE.md.
- **Findings**: The definition storage already has a `*.contract.test.ts` (`storage.contract.test.ts`) round-tripping a maximal fixture. The execution persists through the session repo as part of `SessionState.graphWorkflowExecution`; its durability backstop is `src/lib/state-store/sessions-repo.contract.test.ts`, which round-trips a maximal `graphWorkflowExecution`.
- **Implications**: Extend `buildMaximalRecord` in `storage.contract.test.ts` so the maximal definition fixture declares parameters (forcing the new block onto a persisted path), and extend the execution fixture in `sessions-repo.contract.test.ts` with a non-empty `boundInputs` snapshot. The `boundInputs` default (`{}`) admits pre-feature rows on read-back; no derived-on-write fields are introduced.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Additive seed-time substitution (chosen) | One pure substitution pass over the raw seed definition, before the existing resolver; new schema block + one bound-input audit field | Reuses every primitive; narrow change; reproducible; auditable; no new persisted snapshot | Must keep substitution field-set in lock-step with content-field set | Matches roadmap "Approach Decision" |
| Separate template/instance runtime model | New entity + runtime for templates vs. instances | Conceptually tidy | Duplicates the execution model (the execution already IS the instance); large surface; forbidden by locked constraints | Rejected in roadmap |
| Templating DSL (loops/conditionals) | Rich interpolation language | Expressive | Auditability + scope cost; overlaps planned conditional-edges/expansion work | Rejected in roadmap |

## Design Decisions

### Decision: Parameter container shape — ordered array of declarations
- **Context**: The brief leaves the container shape (array vs. record vs. JSON-schema subset) as a design choice driven by ordering/lookup/validation needs.
- **Alternatives Considered**:
  1. `record<name, decl>` — O(1) lookup, but loses a stable launch-form display order and makes duplicate-name a structural impossibility (hiding the error rather than reporting it per R1.5).
  2. Ordered array of `{ name, type, label, required, default?, ...typeOptions }` — preserves authoring/display order; duplicate-name becomes an explicit validation (R1.5); a derived name->decl map serves lookup.
- **Selected Approach**: Ordered array on the definition (`parameters: ParameterDeclaration[]`, defaulting to `[]`). Lookups build a transient `Map<name, decl>`. The bound input snapshot is a `record<name, value>` (lookup-shaped, order irrelevant once bound).
- **Rationale**: The launch form and builder editor both need a deterministic order; the explicit duplicate-name check is a stated requirement; record-shaped bound values are simplest for substitution lookup.
- **Trade-offs**: Lookup needs a one-time map build (negligible). Worth it for ordered UX + explicit duplicate detection.
- **Follow-up**: Confirm the maximal durability fixture exercises every type variant.

### Decision: Parameter value typing via a discriminated union, validated with a derived per-launch Zod schema
- **Context**: Each parameter declares a type; supplied values must be validated against type + options (R3) using Zod, no `any`.
- **Alternatives Considered**:
  1. One free `z.unknown()` value bag validated ad hoc — loses type safety.
  2. A `type`-discriminated `parameterDeclarationSchema` union, plus a pure `buildLaunchInputSchema(params)` that derives a `z.object({...})` whose per-field schema is chosen by declared type (string/text -> `z.string()`, enum -> `z.enum(options)`), with required/default applied per field.
- **Selected Approach**: Discriminated `parameterDeclarationSchema` (`string`|`text`|`enum`) + derived launch-input schema. `safeParse` external launch payloads (HTTP/MCP); the derived schema enforces required/default/enum constraints and rejects unknown keys (R3.5).
- **Rationale**: Schema-first, `z.infer`-derived types, single source of truth, and it naturally produces field-level errors the UI surfaces (R7.4/R7.5). All supported types bind to string values, so substitution is plain string replacement — no per-type rendering.
- **Trade-offs**: Deriving a schema per launch is a tiny cost; gains full type safety and reuses Zod's error reporting.
- **Follow-up**: `boolean`/`number` types are deferred from v1; revisit only if a concrete need appears (they would add a per-type canonical text-rendering requirement).

### Decision: Accept-time lint and parameter-shape checks live in the storage validation choke point
- **Context**: R2 (undeclared-reference lint) and R1.5/R1.7 (duplicate-name, invalid-default) must apply to both human and planner saves.
- **Alternatives Considered**:
  1. Lint in each authoring surface (builder + planner) — duplicated, drift-prone.
  2. Extend the single `validateWorkflowDefinition` accept-time path (called by both `create`/`update` and planner `createWorkflow`/`updateWorkflow`).
- **Selected Approach**: Add a pure `lintParameterReferences(definition)` + parameter-shape validation invoked from the same accept-time validation that hand-authored definitions pass; both authoring surfaces inherit it. The substituted concrete definition is re-validated through this same path (R5.1), giving substitution no way to bypass accept-time guarantees.
- **Rationale**: One validation path = R2.4 satisfied by construction and R5 re-validation is literally the same function.
- **Trade-offs**: None material; consolidates logic.

## Risks & Mitigations
- **Substitution field-set drift** (a new content field added later but not substituted) — Mitigation: a single `CONTENT_FIELD` traversal used by both the lint and the substitution pass, plus a post-substitution assertion that no `{{inputs.}}` remains in substituted fields (R4.7).
- **Secrets in inputs** — Out of scope in v1, handled by policy not enforcement: there is no secret parameter type and no redaction. Input values are treated as non-sensitive and are persisted + surfaced unredacted for audit (R6.3); the service does not inspect or reject values for secret content (R3.7). Authors/launchers MUST NOT place secrets in inputs. Inputs are not injected into prompts (R6.4).
- **Backward-compat regressions** for static definitions — Mitigation: parameter block defaults to `[]`; bound-input field defaults to `{}`; zero-input launch path adds no gate (R3.6, R10.2); durability fixtures cover both shapes.
