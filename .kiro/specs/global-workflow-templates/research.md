# Research & Design Decisions

## Summary

- **Feature**: `global-workflow-templates`
- **Discovery Scope**: Extension (existing system) — integration-focused discovery over the workflow storage layer, the execution start path, and the deterministic probe patterns.
- **Key Findings**:
  - The per-project storage layer (`src/lib/workflow-graph/storage.ts`) keys definitions by `base64url(projectPath)` under `<configDir>/workflows/<projectKey>`. A global tier is a single sibling scope reachable by the same read/write code; no fork is needed. The reserved global key must contain a character outside the base64url alphabet (`A–Za–z0–9-_`) so it is structurally unequal to `base64url(projectPath)` for any path — e.g. a key with a `.` segment, not `__global__` (which is itself valid base64url).
  - The execution start path already has a sequence of deterministic gates in `START` (`execution-route-handlers.ts`): active-execution guard → uncommitted-changes (`readSessionWorktreeDirtyPaths`) guard → `startExecution`. The pre-flight prerequisite check is one more deterministic gate inserted before `startExecution`, mirroring the dirty-path guard's "report precise diagnostic, seed nothing" shape.
  - `workflow-parameterization` owns the parameter block on `workflowSemanticDefinitionSchema`, the seed-time substitution + re-validation (in `createExecutionFromSeed`), the start-input service, the start request shape `{ definitionId, parameters? }`, and the audit field `boundInputs`. This spec consumes all of that unchanged; it must only add a tier discriminator on the start request, prerequisites on the definition, and a tier annotation on the execution audit.

## Research Log

### Per-project storage layer and the global scope seam

- **Context**: The brief requires extending storage additively with a global tier, not forking it.
- **Sources Consulted**: `src/lib/workflow-graph/storage.ts`, `src/lib/config/loader.ts` (`getConfigDirPath`, `resolveConfigDir`), `src/lib/workflows/schemas.ts` (`workflowDefinitionRecordSchema`, `workflowSemanticDefinitionSchema`).
- **Findings**:
  - `getProjectStorageDir(configDir, projectPath)` = `path.join(configDir, "workflows", base64url(projectPath))`. Every CRUD op resolves a path through it.
  - `create`/`update`/`list`/`get`/`delete` are pure path-plus-fs over `WorkflowDefinitionRecord`; accept-time validation runs through `assertValidDefinition` → `validateWorkflowDefinition`.
  - The record shape is shared (`workflowDefinitionRecordSchema`); a global template is the same record, just stored in a different scope.
- **Implications**: Introduce a scope abstraction so a storage call resolves to either a project scope (`base64url(projectPath)`) or the single global scope. The global scope key must never collide with a `base64url(projectPath)` value; choosing a reserved key that contains a character outside the base64url alphabet (e.g. a `.` segment) makes collision impossible by construction (no runtime guard needed) — a key like `__global__` does NOT work because it is itself valid base64url. CRUD, validation, and atomic write are reused verbatim.

### Start path gates and halt-before-tokens

- **Context**: The pre-flight check must be a deterministic engine gate that halts before tokens are spent and produces a precise diagnostic.
- **Sources Consulted**: `src/lib/workflow-graph/execution-route-handlers.ts` (`START`, `startExecutionSchema`, `readSessionWorktreeDirtyPaths` guard, `respondToManagerError`), `src/lib/workflow-graph/workflow-manager.ts` (`start`), `src/lib/dev-server/liveness.ts` (deterministic probe + DI setter pattern), `src/lib/git/worktree.ts` (`readWorktreeDirtyPaths`).
- **Findings**:
  - The dirty-path guard is the canonical model: read a deterministic signal from the worktree, and on failure return a 409 with `code` + structured `details` and seed nothing. The prerequisite check should follow the same return shape with its own `code` and itemized `details`.
  - `START` already short-circuits before `deps.startExecution`. The prerequisite gate slots in right after the dirty-path guard and before `startExecution`.
  - Probes in this codebase are deterministic, DI-injectable (`liveness.ts` setter pattern, `classifyPortOwnership`), and never call agents — the right model for path/skill probes.
- **Implications**: The pre-flight check is pure-ish engine code with injected fs/skill probes (DI for testability, no `vi.mock` of internal modules). It runs in the HTTP `START` handler and the MCP start tool, both before the upstream start-input/substitution path, so a prerequisite failure is attributable distinctly.

### Skill resolution scope

- **Context**: Required-skill prerequisites must be checked against the same scope the workflow run would use. Command Center is phasing out slash-commands in favor of skills and treats both uniformly, so this spec models one `skill` prerequisite kind covering both (no separate command-executable kind).
- **Sources Consulted**: `src/lib/commands/service.ts` (`discoverCommands(worktreePath, backend)`, `discoverClaudeItems`, `discoverCodexItems`, the Codex `.system` root at ~line 384); `src/lib/shared/schemas.ts` (`AgentBackendId`).
- **Findings**: Skill discovery is backend-dependent and already centralized in `discoverCommands`, which returns BOTH skills (`type: "skill"`) and slash-commands (`type: "command"`). For Claude it scans `.claude/commands` + `.claude/skills` (worktree + user-global); for Codex it scans the Codex skill roots including the built-in `~/.codex/skills/.system`. A naive hand-listed root set would omit `.system` and false-fail on built-in skills.
- **Implications**: The skill probe REUSES `discoverCommands(worktreePath, backend)` rather than re-enumerating roots, so the pre-flight roots mirror the run exactly. A skill prerequisite matches a discovered item of that name of either type. Because discovery is backend-dependent, a backend-unscoped skill prerequisite must be discoverable on every backend in the used-backend set; the probe takes a backend and is injected as a dep so tests exercise real discovery over a fixture tree, not a mock.

### Library listing across tiers and project enumeration

- **Context**: The library must list both tiers; a global template is launchable into any discovered project.
- **Sources Consulted**: `src/lib/workflows/definition-route-handlers.ts` (per-project LIST/CRUD handlers + DI), `src/lib/projects/discovery.ts` (`discoverProjects`), `src/lib/workflow-graph/planner-tools.ts` (`list_graph_workflows`, `PlannerToolContext`), `src/lib/mcp-gateway/session-server.ts` (tool registration).
- **Findings**: The per-project listing is a thin handler over `storage.list(projectPath)`. A unified listing is the project list plus the global list, each item tagged with its tier. Project enumeration already exists via `discoverProjects`; this spec does not need to re-enumerate for launch (launch targets the current session's project), but the global tier itself is project-independent.
- **Implications**: Add a combined-listing service that calls storage twice (global scope + project scope) and tags items. Expose it through an HTTP listing handler and an MCP list tool. The launch identifier becomes `{ tier, definitionId }`.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Sibling scope in existing storage | Add a `WorkflowScope` (project vs global) the storage service resolves to a directory; reuse all CRUD/validation | Zero fork; preserves per-project behavior; one validation choke point | Must reserve a global key that can't collide with any `base64url(projectPath)` | **Selected** — matches the additive constraint |
| Separate global storage module | A new module duplicating CRUD for the global dir | Clear separation | Duplicates CRUD + validation; drifts from per-project behavior; violates additive constraint | Rejected (fork) |
| New template/instance entity | Model templates as a new entity distinct from definitions | Explicit | Upstream already treats a definition as the template (zero-input/parameterized); a new entity contradicts the roadmap | Rejected |
| Pre-flight as an agent step | Ask an agent to verify prerequisites | Flexible phrasing | Burns tokens before the gate; non-deterministic; violates the deterministic-gate constraint | Rejected |

## Design Decisions

### Decision: Global tier as a reserved sibling scope, not a fork

- **Context**: R1 requires a global tier alongside per-project storage without forking.
- **Alternatives Considered**: 1) sibling scope in the same service; 2) a parallel global storage module.
- **Selected Approach**: Introduce a `WorkflowScope` discriminator (`{ kind: "project"; projectPath } | { kind: "global" }`). The storage service resolves a scope to a directory: project → `base64url(projectPath)` (unchanged), global → a reserved sentinel directory name that is not a valid `base64url` of any path. All CRUD, accept-time validation, and atomic writes are reused.
- **Rationale**: One code path, one validation choke point, no per-project behavior change, no migration.
- **Trade-offs**: A small surface change to the storage signature (scope instead of bare `projectPath`); existing per-project callers pass a project scope.
- **Follow-up**: Confirm the sentinel key cannot equal any `base64url(projectPath)`; add a durability/contract test for global records.

### Decision: Pre-flight as a deterministic gate before the upstream seed

- **Context**: R5/R6 require a deterministic, halt-before-tokens prerequisite check distinct from other launch errors.
- **Alternatives Considered**: 1) gate in the start handler before the upstream start path; 2) gate inside `createExecutionFromSeed`.
- **Selected Approach**: Insert the prerequisite check into the upstream shared start path (`workflowManager.start`, called by both the HTTP handler and the MCP tool), after the active-execution and dirty-worktree guards and before the upstream start-input/substitution path. Probes (path/skill) are injected deps over real fs/skill-resolution. On failure, return a dedicated `prerequisites_unmet` result with an itemized list (each item tagged `absent` or `probe_error`); seed nothing.
- **Rationale**: Keeps failure attribution distinct (R6.2), guarantees no tokens spent (R5.1, R6.3), and leaves `createExecutionFromSeed` (owned upstream) untouched.
- **Trade-offs**: HTTP and MCP both launch through the upstream **shared start path** (`workflowManager.start`), into which the prerequisite gate is inserted once — so the gate, the existing guards, and the upstream input/substitution path apply to both surfaces with no per-surface duplication.
- **Follow-up**: Ensure the gate ordering test asserts prerequisites run before substitution (R5.9).

### Decision: Prerequisites as a general declarative block; tier as an additive audit field

- **Context**: R4/R9 require general prerequisites and no special-casing; R3.3 requires tier attribution without changing the upstream audit contract.
- **Selected Approach**: Add a `prerequisites` array (kind-discriminated: `path` | `skill`, where `skill` covers both skills and slash-commands and carries an optional `backend` scope) to `workflowSemanticDefinitionSchema`, defaulting to `[]` so existing definitions are unaffected. Add a single additive `launchedTier` annotation to the execution audit, alongside (not replacing) the upstream `boundInputs`.
- **Rationale**: General primitive; additive; no Kiro special-casing (a `.kiro/` path + skill/slash-command declarations are merely examples). No PATH-executable kind — no motivating evidence for one.
- **Trade-offs**: Two persisted-field additions need round-trip durability coverage (definition `prerequisites` in `storage.contract.test.ts`; execution `launchedTier` in `sessions-repo.contract.test.ts`).
- **Follow-up**: Extend the storage contract maximal fixture (prerequisites of every kind) and the `sessions-repo` execution durability coverage (`launchedTier`).

## Risks & Mitigations

- Global-scope key collision with a project key — Mitigate with a reserved sentinel directory name that is not valid `base64url` output, plus a guard asserting the global key is never produced by the project-key encoder.
- Pre-flight false-negatives wedging legitimate launches (e.g. a transient probe error) — A probe returns a `ProbeOutcome` tagged `absent` vs `probe_error`; both fail closed and halt the launch (never silently pass), but the diagnostic distinguishes "could not be evaluated" from "definitively absent" so the launcher can tell a transient error from a genuine miss (R5.10).
- Drift from the upstream start contract — Treat the start request shape, substitution, and the `boundInputs` audit field as read-only contracts; only add a `tier` discriminator and a `launchedTier` audit annotation. Re-validate this spec's file-level claims against `workflow-parameterization` once it has actually shipped (the two specs share several files).
- Secret leakage via prerequisite declarations — Secrets are policy-prohibited and out of scope (R4.7); the service applies no redaction or secret-content inspection and surfaces declared strings unredacted as non-sensitive. The `.strict()` schema rejects unmodeled fields but does not prevent a modeled string from containing a secret. Authors MUST NOT place secrets in prerequisite declarations.

## References

- `.kiro/specs/workflow-parameterization/requirements.md`, `.kiro/specs/workflow-parameterization/design.md` — consumed contracts (parameter block, substitution/re-validation, start request, start-input service, audit field `boundInputs`).
- `.kiro/steering/workflows.md` — XState workflow orchestration conventions.
- `.kiro/steering/engineering-principles.md` — composable primitives, DI over `vi.mock`, deterministic gate before agent turn.
- `PERFORMANCE.md` — focused accessors/setters when touching the state store (execution audit field).
