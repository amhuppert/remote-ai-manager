# Implementation Plan

- [ ] 1. Foundation: parameter and audit schemas
- [x] 1.1 Add the typed parameter-declaration schema to the workflow semantic definition
  - Add a `type`-discriminated parameter-declaration schema (string, multiline text, enum) with name, label, required, optional default, and per-type validation options (enum options list; string/text min/max-length bounds), deriving all types via `z.infer`.
  - Add an optional `parameters` block to the semantic definition schema that defaults to an empty list so static definitions parse as zero-input templates with no migration.
  - Observable completion: a definition with declared parameters of every type parses and re-serializes without loss; a legacy definition with no `parameters` field parses with an empty parameter list.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 10.2_
  - _Boundary: Definition Schema_

- [x] 1.2 Add the execution audit field for bound inputs
  - Add a bound-input snapshot field (name → string value, default `{}`) to the execution schema. All supported parameter types (string/text/enum) bind to string values, so the value type is `string`. The `.default({})` is a safe additive default that legacy execution rows satisfy on read-back — no nullable field and no separately persisted definition snapshot or hash is added (the resolved working definition + charter snapshot already record the concrete post-substitution graph).
  - Observable completion: an execution object carrying a bound-input snapshot parses and re-serializes without loss; a pre-feature execution record that omits the field parses with `boundInputs = {}`; a zero-input feature-created execution carries an empty `boundInputs`.
  - _Requirements: 6.1, 6.5, 10.2_
  - _Boundary: Definition Schema_
  - _Depends: 1.1_

- [ ] 2. Core pure logic: validation and substitution
- [x] 2.1 (P) Implement parameter-declaration shape validation
  - Validate declarations for duplicate names, enum types with a non-empty options list, and declared defaults that conform to the parameter's type and options; return graph-validation-shaped errors with a parameter locator.
  - Observable completion: unit tests show duplicate-name, empty-enum-options, and non-conforming-default declarations each rejected with the offending parameter identified, and a valid declaration set accepted.
  - _Requirements: 1.3, 1.5, 1.7_
  - _Boundary: Parameter Validation_
  - _Depends: 1.1_

- [x] 2.2 (P) Implement the placeholder-grammar + reference lint over the closed content and charter field set
  - Scan, via a single shared scanned-field traversal, task instructions, context title/description/acceptance criteria, and every agent-rendered charter text field (mission, conventions, non-goals, vocabulary, ownership map, test strategy, known ambiguities, and each source-of-truth's label, locator, description, appliesTo — per `charter/render.ts`) for every `{{...}}` occurrence. Enforce the grammar: the only valid token is exactly `{{inputs.<name>}}` with no internal whitespace; reject any other `{{...}}` (unknown namespace such as `{{execution.id}}`, internal whitespace, malformed braces, or bare/literal `{{` — there is no escape mechanism) with the offending field and token; reject a valid reference to an undeclared parameter; and reject a valid reference to a declared parameter that is neither required nor defaulted (substitution would have no effective value).
  - Define the scanned-field surface ONCE as a single exported constant (`SUBSTITUTION_FIELD_SET`) consumed by both this lint and substitution (task 2.4); neither module may enumerate fields independently. This is the load-bearing anti-drift mechanism — if the lint scan and substitution diverge, either a `{{...}}` escapes to an agent as literal text or a rendered field is substituted unlinted.
  - Observable completion: unit tests show — for each scanned field type — an undeclared reference rejected with a locator; grammar violations (unknown namespace, internal whitespace, malformed/bare braces) rejected; a reference to a declared-but-neither-required-nor-defaulted parameter rejected; all-declared-and-required/defaulted references accepted; and declared-but-unused parameters (including optional with no default) accepted. A drift-guard unit test asserts the charter portion of `SUBSTITUTION_FIELD_SET` equals exactly the charter text fields `charter/render.ts` renders, so a newly rendered charter field that is not registered as substitutable fails the suite.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 2.8_
  - _Boundary: Parameter Validation_
  - _Depends: 1.1_

- [x] 2.3 (P) Implement launch-input schema derivation
  - Derive a per-launch `.strict()` object schema keyed by parameter name, choosing each field schema from the declared type (string/text → `z.string()` with optional length bounds; enum → `z.enum(options)`) and applying required/default constraints; the `.strict()` schema rejects any unknown key (a field that is not a declared parameter). It applies no redaction or secret-content check — secrets are policy-prohibited / out of scope (no secret parameter type), not enforced by the schema.
  - Observable completion: unit tests show the derived schema enforces enum membership and required presence, applies defaults when a value is omitted, and rejects any unknown key; a declared `string`/`text` parameter value passes through unredacted (no secret-content rejection).
  - _Requirements: 3.1, 3.3, 3.4, 3.5, 3.7_
  - _Boundary: Parameter Validation_
  - _Depends: 1.1_

- [x] 2.4 (P) Implement deterministic content substitution
  - Substitute every `{{inputs.<name>}}` across the shared scanned-field set — read from the single shared `SUBSTITUTION_FIELD_SET` constant established in task 2.2 (never enumerate fields independently), which covers content fields plus every agent-rendered charter text field (mission, conventions, non-goals, vocabulary, ownership map, test strategy, known ambiguities, and each source's label/locator/description/appliesTo) — with the bound value, leaving IDs, task order, edges, and command/config fields untouched. Return the concrete `WorkflowSemanticDefinition` and assert no residual placeholder remains in substituted fields. All values are strings, so substitution is plain string replacement (no locale/number/boolean rendering).
  - Observable completion: unit tests show substitution into all content + every agent-rendered charter field, IDs/order/edges/command/config fields unchanged, deterministic output for identical inputs, and no residual `{{inputs.}}`.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.7_
  - _Boundary: Substitution_
  - _Depends: 1.1_

- [ ] 3. Accept-time integration: lint and shape checks in the storage choke point
- [x] 3.1 Wire parameter shape checks and grammar/reference lint into the accept-time validation path
  - Invoke the parameter shape validation and the grammar/reference lint from the single accept-time validation used by both human and planner saves, and confirm the same path validates a substituted concrete definition.
  - Observable completion: saving a definition (human or planner path) with a duplicate parameter name, a grammar-violating token, an undeclared reference, or a referenced-but-neither-required-nor-defaulted parameter is rejected through the shared validation, and a clean definition is accepted.
  - _Requirements: 1.5, 2.5, 5.1_
  - _Boundary: Parameter Validation, Storage Validation_
  - _Depends: 2.1, 2.2_

- [ ] 4. Start-time integration: input validation service and seed wiring
- [x] 4.1 Implement the shared start-input service
  - Validate a launch payload against a definition's parameters using the derived `.strict()` schema, apply defaults, and return a discriminated rejection for missing-required, invalid-value, and unknown-parameter (the `.strict()` rejection of any unknown key — a non-declared field); apply no redaction or secret-content check (secrets are policy-prohibited / out of scope, not enforced); return bound inputs on success.
  - Observable completion: tests show each rejection kind returned with the offending name, defaults applied, a zero-input definition returning empty bound inputs, an unknown key rejected by the strict schema, a declared-parameter value passing through unredacted, and no execution-seeding side effect on rejection.
  - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 9.2_
  - _Boundary: Start Input Service_
  - _Depends: 2.3_

- [x] 4.2 Wire substitution, re-validation, and audit persistence into the execution seed
  - In the execution seed, run substitution on the raw definition with the bound inputs (single simultaneous pass; bound values inserted verbatim and never re-scanned or re-substituted), re-validate the concrete definition through the STRUCTURAL graph validation only (the graph/spec-lint structural checks + non-empty required-content checks, NOT the authoring-time placeholder-grammar lint — a launcher value may legitimately contain `{{`), resolve from the concrete definition, and persist the bound-input snapshot; throw without seeding if structural re-validation fails.
  - Observable completion: a parameterized seed produces a resolved working definition and charter snapshot with no template placeholders and persists the bound-input snapshot; a substituted definition that fails structural validation (including empty required content after substitution) seeds nothing; a launch whose input value contains a literal `{{...}}` (e.g. `${{ x }}`) re-validates and seeds successfully (the grammar lint is not re-applied to data).
  - _Requirements: 4.6, 4.7, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.5, 10.4_
  - _Boundary: Execution Repository Seed_
  - _Depends: 1.2, 2.4, 3.1, 4.1_

- [ ] 5. Launch surfaces: HTTP, MCP, and planner authoring
- [x] 5.1 Establish the shared start path and route the HTTP start request through it
  - Make `workflowManager.start` the shared start path that both HTTP and MCP call: relocate the active-execution and uncommitted-changes (dirty-worktree) guards out of the HTTP handler into this shared path (dirty-path reader injected as a dep), running them in order before any seed, then invoke the start-input service, then seed. Extend the HTTP start request payload to accept optional parameters, and make the HTTP handler thin — parse the payload, call the shared start path, and map guard/input rejections to client errors (4xx / 409).
  - Observable completion: the active-execution and uncommitted-changes guards now run inside the shared start path (HTTP behavior unchanged); a start request with invalid/missing inputs returns a client error with the offending parameter and seeds nothing; a valid request starts a parameterized run; a zero-input request behaves exactly as today.
  - _Requirements: 3.2, 7.7, 9.2, 9.7_
  - _Boundary: HTTP Start Handler, Workflow Manager (shared start path)_
  - _Depends: 4.1, 4.2_

- [x] 5.2 Add the MCP `start_graph_workflow` tool
  - Register a `start_graph_workflow` tool accepting a definition id with optional parameters, routing through the SAME shared start path as HTTP so it inherits the identical active-execution + uncommitted-changes guards, start-input validation, and substitution; return structured validation/not-found/guard errors; expose no mid-run fill capability.
  - Observable completion: the tool launches a parameterized run, returns the same rejection reasons as the HTTP path for invalid inputs, returns not-found for an unknown definition with nothing seeded, is rejected on an active execution or a dirty worktree exactly like the HTTP path, and launches a zero-input definition like a human zero-input launch.
  - _Requirements: 9.1, 9.2, 9.4, 9.5, 9.6, 9.7_
  - _Boundary: MCP Start Tool, Workflow Manager (shared start path)_
  - _Depends: 4.1, 4.2, 5.1_

- [x] 5.3 (P) Extend the planner create/replace tools to declare parameters
  - Add an optional parameter-declaration field to the planner create/replace tool input, carry it into the inflated semantic definition, and rely on the shared accept-time lint and shape checks for rejection.
  - Observable completion: a planner-authored definition can declare parameters and is rejected for an undeclared reference exactly like a human-authored definition.
  - _Requirements: 1.1, 2.5, 9.3_
  - _Boundary: Planner Tools_
  - _Depends: 3.1_

- [ ] 6. UI capabilities (data/behavior per design; visual design supplied downstream)
- [x] 6.1 (P) Implement the generated launch surface behavior
  - Render one input affordance per declared parameter keyed by type, constrain enum inputs to declared options, pre-populate defaults, surface missing-required and per-field validation states and block launch until resolved, allow launch with no parameters for zero-input definitions, and submit values to the start interface reflecting the outcome including engine rejection reasons.
  - Observable completion: with a declared parameter set, the surface presents typed inputs, blocks launch on a missing required or invalid value, allows a valid launch, and shows an engine start-time rejection; a zero-input definition launches with no parameter inputs.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
  - _Boundary: Launch UI_
  - _Depends: 5.1_

- [x] 6.2 (P) Implement the builder parameter-declaration editor behavior
  - Let the author add/edit/remove parameter declarations (name, type, label, required, default, and enum options), surface a duplicate-name condition before save and the accept-time lint error (offending field + undeclared name) on save, and persist declarations with the definition on success.
  - Observable completion: the editor manages declarations of each type, surfaces a duplicate name before save and an undeclared-reference lint error on save, and a valid set persists with the definition.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
  - _Boundary: Builder UI_
  - _Depends: 3.1_

- [ ] 7. Validation: durability contracts and end-to-end verification
- [x] 7.1 Extend round-trip durability coverage for new persisted fields
  - Extend the definition storage durability contract's maximal fixture (`storage.contract.test.ts`) to declare every parameter type. Separately, extend the execution durability fixture in `sessions-repo.contract.test.ts` (which round-trips `graphWorkflowExecution`) with a non-empty bound-input snapshot, and confirm the additive default admits pre-feature rows.
  - Observable completion: the durability contracts fail if a declared-parameter field or the bound-input snapshot is dropped on the persistence round-trip, pass for the maximal fixtures, and a pre-feature execution record without the bound-input field loads with `boundInputs = {}`.
  - _Requirements: 1.6, 6.2, 10.2_
  - _Boundary: Definition Schema, Execution Repository Seed_
  - _Depends: 1.1, 1.2, 4.2_

- [x] 7.2 End-to-end verification of a parameterized run and general-primitive guarantee
  - Verify a parameterized launch end-to-end (using an example workflow such as the Kiro pipeline as a fixture only) runs through the existing scheduler/validators/approval gate/charter unchanged, the bound-input snapshot is human-visible and absent from agent prompts, and no code path is conditioned on a specific workflow identity.
  - Observable completion: the example run completes through the unchanged engine, the bound-input snapshot is visible to humans but appears in no agent prompt, and substitution/validation/audit behave identically for a non-example definition.
  - _Requirements: 6.3, 6.4, 10.1, 10.3, 10.4_
  - _Boundary: Execution Repository Seed, Launch UI, MCP Start Tool_
  - _Depends: 4.2, 5.1, 5.2, 6.1_
