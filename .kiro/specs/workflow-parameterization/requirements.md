# Requirements Document

## Project Description (Input)

Graph workflow definitions in Command Center are static: a definition is effectively single-use per session/feature because `acceptanceCriteria`, task `instructions`, context `title`/`description`, and charter `mission`/`sourcesOfTruth` are static strings with no interpolation, and a run is started with only `{ definitionId }`. To run "the same workflow" for a different feature today you must hand-edit or recreate the definition.

This feature lets a workflow author (human in the builder, or an authoring agent via the planner) declare typed launch inputs on a definition. At start, the engine validates supplied input values against the declared parameter schema, deterministically substitutes `{{inputs.x}}` placeholders into content fields (task instructions, context title/description/acceptance criteria) and every charter text field rendered into implementer/validator prompts or materialized docs (mission, conventions, non-goals, vocabulary, ownership map, test strategy, known ambiguities, and each source-of-truth's label/locator/description/appliesTo), produces a concrete definition, re-validates that concrete definition through the same accept-time/spec-lint path a hand-authored workflow passes, and runs the existing scheduler / validators / approval gate / charter / audit machinery unchanged. A human launches via a launch surface generated from the parameter schema; an agent launches via a new MCP `start_graph_workflow` tool. Static workflows continue to work unchanged as zero-input templates.

Substitution is pure engine code — agents never fill in templates. v1 is text-substitution-only (no typed config bindings), so per-context human approval gates stay author-fixed and the existing per-context gate is the single approval point. Substitution happens once at seed, before the existing config resolver runs; runtime/agent-added content stays concrete. The mechanism is a general primitive usable by a wide variety of workflows; the Kiro spec pipeline (spec-init -> spec-requirements -> spec-design -> validate-design, parameterized by feature name + brief + additional context) is only an illustrative example, and no behavior may special-case Kiro or any single workflow.

## Boundary Context

- **In scope**:
  - A typed, declarative parameter-declaration block on the workflow semantic definition (each parameter: name, type, label, required, default, validation/enum options). Supported types: string, multiline text, and enum.
  - Deterministic `{{inputs.x}}` substitution into content fields (task instructions; context title, description, acceptance criteria) and every charter text field rendered into implementer/validator prompts or materialized docs (mission, conventions, non-goals, vocabulary, ownership map, test strategy, known ambiguities, and each source-of-truth's label, locator, description, and appliesTo), performed once at seed time.
  - Start-time validation of supplied input values against the declared parameter schema, before any agent tokens are spent.
  - Accept-time lint that enforces the placeholder grammar and rejects any `{{...}}` occurrence that is not a `{{inputs.<name>}}` reference to a declared parameter when a definition is saved.
  - Re-validation of the substituted concrete definition through the same accept-time/spec-lint path a hand-authored definition passes.
  - Execution audit fields: the seed definition id and revision, the bound raw input snapshot, and the existing resolved working definition (which, because substitution runs before resolution, already records the concrete post-substitution graph the run executes).
  - Start interfaces: the HTTP start request accepts an optional `parameters` payload alongside `definitionId`; a new MCP `start_graph_workflow` tool for agents; the planner/create-tool extended so authoring agents can declare parameters.
  - A launch surface (capabilities/behaviors only, visual design owned downstream) generated from the parameter schema, plus a parameter-declaration editing capability in the builder.
  - Zero-input (static) definitions continue to launch and run with no parameter payload and no behavior change.
- **Out of scope**:
  - Typed config bindings (per-run approval-gate toggles, per-run model/validator selection).
  - Secrets as input values.
  - Cross-project/global template storage tier and start-time pre-flight prerequisite checking (owned by the separate `global-workflow-templates` spec).
  - Parameterizing context/task identifiers or graph topology (substitution is content-only; IDs and graph shape are not parameterizable).
  - Mid-run parameter fill; presets / saved parameter sets; promote/fork transfer flows.
  - Conditional edges, expansion nodes, `propose_graph_patch`, or a deterministic "command node" step type.
  - `boolean` and `number` parameter types (v1 is text substitution; string/text/enum cover the motivating cases — added later only if a concrete need appears).
  - An optional large free-form "run-inputs" blob / per-execution shared run-inputs document, and any generic "Run Inputs" echo section in prompts; substituted values are never echoed back to agents.
  - A separately persisted materialized-definition snapshot or a hash over it: substitution runs before resolution, so the already-persisted resolved working definition (plus the charter snapshot) records the concrete post-substitution graph; the bound-input snapshot completes the audit trail.
- **Adjacent expectations**:
  - Reuses the existing definition/execution split, the seed-time config cascade and resolver, the per-context human approval gate, the charter and ranked sources-of-truth injection, the scheduler/validators, and the execution audit trail — extended additively, not forked.
  - `global-workflow-templates` consumes the parameter-declaration schema and the substitution/validation path defined here unchanged.

## Requirements

### Requirement 1: Parameter Declaration on a Definition
**Objective:** As a workflow author, I want to declare typed launch inputs on a workflow definition, so that one definition can be launched repeatedly with run-specific values instead of being hand-edited per feature.

#### Acceptance Criteria
1. The Workflow Definition Service shall allow a definition to declare zero or more launch parameters, where each parameter specifies a name, a type, a human-readable label, a required flag, an optional default value, and type-appropriate validation options.
2. The Workflow Definition Service shall support parameter types string, multiline text, and enum.
3. Where a parameter is of type enum, the Workflow Definition Service shall require a non-empty list of allowed option values and shall reject a declared default that is not one of those options.
4. When a definition declares no parameters, the Workflow Definition Service shall treat it as a zero-input template and shall preserve its existing save, load, and launch behavior unchanged.
5. If two declared parameters share the same name, the Workflow Definition Service shall reject the definition at save time with a duplicate-parameter error identifying the conflicting name.
6. The Workflow Definition Service shall persist declared parameters as part of the definition so that they survive a save/load round-trip without loss or silent defaulting.
7. If a declared parameter default value does not satisfy that parameter's declared type and validation options, the Workflow Definition Service shall reject the definition at save time with an error identifying the parameter and the violated constraint.

### Requirement 2: Placeholder Reference Lint at Accept Time
**Objective:** As a workflow author, I want a precise placeholder grammar enforced and any invalid or undeclared placeholder caught when I save a definition, so that broken templates fail before launch rather than silently producing literal `{{...}}` text in agent prompts.

#### Acceptance Criteria
1. When a definition is saved, the Workflow Definition Service shall scan every scanned field for `{{...}}` occurrences, where the scanned fields are the content fields (task instructions; context title, description, acceptance criteria) and every charter text field rendered into implementer/validator prompts or materialized docs (mission, conventions, non-goals, vocabulary, ownership map, test strategy, known ambiguities, and each source-of-truth's label, locator, description, and appliesTo).
2. The Workflow Definition Service shall recognize as a valid placeholder only the exact token `{{inputs.<name>}}`, where `<name>` is the identifier of a declared parameter and no internal whitespace is permitted anywhere between the braces (the token is `{{`, then `inputs.`, then `<name>`, then `}}`, with no spaces).
3. If a scanned field contains a `{{...}}` occurrence that is not a valid placeholder per the grammar — including an unknown namespace (for example `{{execution.id}}`), malformed braces, internal whitespace, or a typo'd/undeclared parameter name — the Workflow Definition Service shall reject the save with a lint error identifying the offending field and the offending token.
4. The Workflow Definition Service shall accept a save when every `{{...}}` occurrence in scanned fields is a valid `{{inputs.<name>}}` placeholder resolving to a declared parameter.
5. The Workflow Definition Service shall apply the same placeholder grammar and reference lint regardless of whether the definition was authored through the builder or the planner/create tool.
6. Where a definition declares parameters but never references them in any scanned field, the Workflow Definition Service shall accept the save.
7. If a scanned field contains a valid `{{inputs.<name>}}` placeholder whose referenced parameter is declared but is neither marked required nor carries a default, the Workflow Definition Service shall reject the save with a lint error identifying the offending field and the parameter, because substitution would otherwise have no effective value to substitute.
8. The Workflow Definition Service shall treat a literal `{{` sequence in any scanned field as unsupported in this version (no escape mechanism is provided), so any `{{` that does not begin a valid `{{inputs.<name>}}` placeholder is rejected per criterion 3. This authoring-time rejection applies only when a definition is saved through the builder or planner; it is never applied to launcher-supplied input values at launch (Requirement 5). A pre-existing static definition whose stored content already contains a literal `{{` continues to load and launch unchanged with no migration (Requirement 10.2), and would require a one-time edit only if it is re-saved.

### Requirement 3: Start-Time Input Validation
**Objective:** As a person or agent launching a workflow, I want my supplied input values validated against the declared parameter schema before the run begins, so that invalid or missing inputs are reported immediately and no agent tokens are spent on a doomed run.

#### Acceptance Criteria
1. When a workflow launch is requested with input values, the Graph Workflow Start Service shall validate each supplied value against its parameter's declared type and validation options before seeding the execution.
2. If a required parameter has no supplied value and no declared default, the Graph Workflow Start Service shall reject the launch with a missing-required-input error identifying the parameter, and shall not seed an execution or start any agent turn.
3. If a supplied value violates its parameter's declared type or validation options, the Graph Workflow Start Service shall reject the launch with a validation error identifying the parameter and the violated constraint, and shall not seed an execution or start any agent turn.
4. When a parameter has a declared default and no value is supplied for it, the Graph Workflow Start Service shall use the declared default as the effective value for that parameter.
5. If a launch supplies a value for a name that is not a declared parameter, the Graph Workflow Start Service shall reject the launch with an unknown-parameter error identifying the name (the start-input payload is validated against a strict schema that rejects any unknown key).
6. When a zero-input definition is launched with no input values, the Graph Workflow Start Service shall proceed exactly as it does for a launch today, with no validation gate added.
7. Secrets in input values are policy-prohibited and out of scope in this version: there is no secret parameter type, the service applies no redaction, and it neither inspects nor rejects values for secret content. The strict payload schema rejects unknown *keys* only; it does not constrain the *content* of an accepted value. Authors and launchers MUST NOT place secrets in input values, because such a value would be persisted and surfaced unredacted (Requirement 6.3).

### Requirement 4: Deterministic Seed-Time Substitution
**Objective:** As a workflow operator, I want supplied inputs deterministically substituted into the definition once at seed, before the existing config resolver runs, so that the running execution is fully concrete with no remaining placeholders and no agent involvement in templating.

#### Acceptance Criteria
1. When an execution is seeded with validated input values, the Graph Workflow Substitution Service shall substitute every `{{inputs.<name>}}` placeholder with the effective value of the referenced parameter across the same scanned-field surface defined in Requirement 2 — the content fields (task instructions; context title, description, acceptance criteria) and every charter text field rendered into implementer/validator prompts or materialized docs (mission, conventions, non-goals, vocabulary, ownership map, test strategy, known ambiguities, and each source-of-truth's label, locator, description, and appliesTo).
2. The Graph Workflow Substitution Service shall perform substitution as deterministic engine code without invoking any agent.
3. The Graph Workflow Substitution Service shall not substitute placeholders into configuration command fields, including the script validator command and the pre-merge command.
4. The Graph Workflow Substitution Service shall not alter context identifiers, task identifiers, or the graph topology (edges) during substitution.
5. When the same definition is substituted with the same input values, the Graph Workflow Substitution Service shall produce the same concrete definition (deterministic; no run-dependent or locale-dependent output).
6. While an execution is running, the Graph Workflow Substitution Service shall not re-run substitution; content an agent adds or edits at runtime shall remain exactly as authored, with no automatic placeholder substitution applied to later-authored text.
7. When substitution completes, every `{{inputs.<name>}}` placeholder present in the template's scanned fields shall have been replaced. Substitution is a single simultaneous pass over the shared scanned-field set: bound values are inserted verbatim and are never re-scanned or re-substituted, so a literal `{{...}}` appearing inside a bound value (including a literal `{{inputs.<name>}}` typed into a value) is left intact and is not treated as an unresolved placeholder. Substitution shall run before the existing config resolver so the resolved working definition the execution persists is already concrete.

### Requirement 5: Re-Validation of the Substituted Definition
**Objective:** As a workflow operator, I want the substituted concrete definition checked by the same structural graph validation a hand-authored workflow passes, so that substitution cannot produce a graph that bypasses the engine's structural accept-time guarantees.

#### Acceptance Criteria
1. When substitution completes, the Graph Workflow Start Service shall validate the concrete definition through the same structural graph validation a hand-authored definition passes — the graph/spec-lint structural checks and the non-empty required-content checks — together with the residual-placeholder guarantee of Requirement 4.7. The Graph Workflow Start Service shall NOT re-apply the accept-time placeholder-grammar lint (Requirement 2) to the substituted content, because a substituted value is launcher-supplied data that may legitimately contain a literal `{{...}}` (for example a brief describing template syntax, or a GitHub Actions `${{ … }}` expression), and re-scanning data for the placeholder grammar would reject a legitimate launch.
2. If the substituted concrete definition fails that structural validation, the Graph Workflow Start Service shall reject the launch with a validation error and shall not start any agent turn.
3. If a substituted value produces an empty or whitespace-only required content field (for example, an empty acceptance criteria after substitution), the Graph Workflow Start Service shall reject the launch via the substituted-definition structural validation.
4. When the substituted concrete definition passes validation, the Graph Workflow Start Service shall seed and run the existing scheduler, validators, approval gate, charter, and audit machinery unchanged.
5. When a substituted value itself contains a literal `{{...}}` sequence that is not a placeholder the engine substituted, the Graph Workflow Start Service shall not reject the launch on that basis, because the placeholder-grammar lint of Requirement 2 is an authoring-time constraint on template text and is not re-applied to substituted data; at seed only the structural graph validation and the single-pass substitution guarantee of Requirement 4.7 apply.

### Requirement 6: Execution Audit of Bound Inputs
**Objective:** As a workflow operator or reviewer, I want the execution to record what definition and inputs produced the run, so that any run is auditable and reproducible without exposing input values to the agents.

#### Acceptance Criteria
1. When an execution is seeded from a parameterized launch, the Execution Audit Service shall record the seed definition id, the seed definition revision, and the raw bound input snapshot on the execution, alongside the existing resolved working definition and charter snapshot (which together record the concrete post-substitution graph the run executes).
2. The Execution Audit Service shall persist the bound input snapshot so that it survives a save/load round-trip without loss or silent defaulting.
3. The Execution Audit Service shall treat bound input values as non-sensitive and shall persist and surface the raw bound input snapshot unredacted for human inspection (audit and UI) without injecting it into any agent prompt; this version applies no redaction.
4. The Execution Audit Service shall not echo substituted input values back to agents outside of the content fields into which they were substituted.
5. When a zero-input definition is launched, the Execution Audit Service shall record an empty bound input snapshot, preserving a uniform audit shape across parameterized and zero-input runs.

### Requirement 7: Human Launch Surface Capabilities
**Objective:** As a person launching a parameterized workflow, I want a launch surface generated from the declared parameters, so that I can supply each value with the right input affordance and see required/invalid values surfaced before I launch.

#### Acceptance Criteria
1. When a person opens the launch surface for a definition, the Workflow Launch UI shall present one input affordance per declared parameter, using the parameter label and an affordance appropriate to its type.
2. Where a parameter is of type enum, the Workflow Launch UI shall constrain the input to the declared option values.
3. Where a parameter declares a default, the Workflow Launch UI shall pre-populate the input with that default value.
4. If a required parameter has no value, the Workflow Launch UI shall surface the missing-required condition and shall prevent launch until it is resolved.
5. If a supplied value fails its parameter's validation, the Workflow Launch UI shall surface the validation error against the offending input and shall prevent launch until it is resolved.
6. When a definition declares no parameters, the Workflow Launch UI shall allow launch without presenting any parameter inputs.
7. When the person submits a valid launch, the Workflow Launch UI shall send the supplied input values to the start interface and reflect the launch outcome, including any start-time rejection reason returned by the engine.

### Requirement 8: Parameter Declaration Editing in the Builder
**Objective:** As a workflow author using the builder, I want to declare and edit parameters as part of authoring a definition, so that I can make a workflow reusable and see declaration errors before saving.

#### Acceptance Criteria
1. When an author edits a definition in the builder, the Workflow Builder UI shall let the author add, edit, and remove parameter declarations, including each parameter's name, type, label, required flag, default, and type-appropriate validation options.
2. If the author declares two parameters with the same name, the Workflow Builder UI shall surface the duplicate-name condition before save.
3. If the author saves a definition whose content fields reference an undeclared parameter, the Workflow Builder UI shall surface the resulting accept-time lint error identifying the offending field and undeclared name.
4. Where a parameter is of type enum, the Workflow Builder UI shall let the author manage the allowed option values.
5. When the author saves a valid set of parameter declarations, the Workflow Builder UI shall persist them with the definition and reflect a successful save.

### Requirement 9: MCP Start Tool and Planner Parameter Declaration
**Objective:** As an authoring or orchestrating agent, I want to declare parameters when creating a workflow and to launch a parameterized run via an MCP tool, so that agent-driven workflows can be made reusable and launched without a human in the loop.

#### Acceptance Criteria
1. The Graph Workflow MCP Tools shall provide a `start_graph_workflow` tool that accepts a definition identifier and an optional set of input values and launches a run through the same start path used by the HTTP interface.
2. When an agent calls `start_graph_workflow` with input values, the Graph Workflow MCP Tools shall apply the same start-time input validation, substitution, and substituted-definition re-validation as a human launch, and shall return the start-time rejection reason when validation fails.
3. The Graph Workflow Planner/Create Tools shall allow an authoring agent to declare parameters on a definition it creates, subject to the same parameter-declaration and accept-time lint rules as a human author.
4. When an agent calls `start_graph_workflow` for a zero-input definition without input values, the Graph Workflow MCP Tools shall launch the run exactly as a human zero-input launch.
5. The Graph Workflow MCP Tools shall not provide any capability to fill or change parameter values after a run has started.
6. If `start_graph_workflow` references a definition that does not exist, the Graph Workflow MCP Tools shall return a not-found error and shall not seed an execution.
7. The Graph Workflow MCP Tools shall enforce the same pre-seed launch guards as the HTTP interface — the active-execution guard and the uncommitted-changes (dirty-worktree) guard — by routing through a single shared start path that runs those guards before any execution is seeded, so an agent launch cannot start a run in a state a human launch would reject.

### Requirement 10: General-Primitive and Backward-Compatibility Guarantees
**Objective:** As a maintainer, I want parameterization to be a general additive primitive, so that existing static workflows keep working without migration and no behavior is special-cased for any single workflow.

#### Acceptance Criteria
1. The Graph Workflow Engine shall apply parameter declaration, substitution, validation, and audit uniformly to any definition, with no behavior conditioned on a specific definition, feature name, or workflow identity.
2. While loading a previously saved static definition that predates parameter support, the Workflow Definition Service shall treat it as a zero-input template without requiring a migration step.
3. When a definition declares parameters but a run is launched against the engine's existing single approval point, the Graph Workflow Engine shall keep per-context human approval gates author-fixed and shall not introduce any per-run gate toggling.
4. The Graph Workflow Engine shall keep substitution confined to the scanned content and charter text fields defined in Requirements 2 and 4, never reaching configuration or command fields, identifiers, or graph topology, and leaving the configuration cascade, scheduler, validators, approval gate, and charter authority behavior otherwise unchanged.
