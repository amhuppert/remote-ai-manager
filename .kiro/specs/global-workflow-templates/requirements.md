# Requirements Document

## Introduction

Graph workflow definitions in Command Center are stored per project: a definition saved in project A is invisible to project B, so a methodology-level workflow meant for use across many projects must be hand-recreated in each project. There is no shared/global library, and a template authored for one project cannot be launched into another. Separately, when a reusable template assumes project-specific prerequisites (directories, skills), launching it in a project that lacks them fails mid-run with confusing, hard-to-attribute errors after tokens have already been spent.

This feature adds three capabilities, all additive over the existing graph workflow system and the already-completed `workflow-parameterization` spec:

1. A **global/cross-project template storage tier** that lives alongside the existing per-project workflow definitions, as a sibling scope rather than a fork.
2. A **template library** that lists and browses both tiers together and can instantiate (launch) any template — global or project-local — into the current project.
3. A **declarative prerequisite block** on a template plus a **deterministic start-time pre-flight check** that validates the template's declared prerequisites in the target session worktree and halts with a precise diagnostic when any are missing, before any agent tokens are spent. The probe reports; it does not auto-remediate.

A global template is parameterized and launched through the upstream `workflow-parameterization` mechanism unchanged. Prerequisites are declared generically (required paths, required skills) so the mechanism serves a wide variety of workflows; a Kiro-style template that expects a `.kiro/` directory and certain skills/slash-commands is only an illustrative example, and no behavior is special-cased for Kiro or any single workflow.

> **Prerequisite kinds — note on "skill"**: Command Center models discoverable agent capabilities (`.claude/skills`, `.claude/commands`, and the Codex skill roots) uniformly through one discovery service (`discoverCommands`), and slash-commands are being phased out in favor of skills. This spec therefore models a **single** `skill` prerequisite kind that covers both skills and slash-commands; there is no separate "command" prerequisite kind and **no PATH-executable prerequisite kind** (no motivating evidence). The two prerequisite kinds are `path` and `skill`.

### Implementation order / upstream dependency

This spec **must be implemented after** `workflow-parameterization`. It consumes that spec's contracts as already-shipped: the parameter-declaration schema, the deterministic seed-time substitution + substituted-definition re-validation path, the start request shape (`{ definitionId, parameters? }`), the start-input validation pipeline, and the execution audit field (`boundInputs`). It also consumes the upstream **shared start path** (`workflowManager.start`), into which `workflow-parameterization` consolidates the active-execution and uncommitted-changes guards so both the HTTP and MCP start surfaces enforce them identically (`workflow-parameterization` R9.7); this spec inserts its deterministic prerequisite gate into that single shared chain rather than into either surface separately, which is how R6.1/R6.4/R8.2 are satisfied. It also **extends** the upstream-created `start_graph_workflow` MCP tool and the upstream-created `startExecutionSchema` rather than creating them. The additive `tier` discriminator this spec adds to `startExecutionSchema` is the sanctioned downstream extension point on that shared schema (the top-level start request schema is not `.strict()`, so adding `tier` is purely additive and does not modify the upstream payload contract). Both specs are independently generated and marked ready, but the contracts above are owned upstream and consumed here unchanged; this spec does not redefine, fork, or alter them, and it should be re-validated against what `workflow-parameterization` actually shipped before its own start.

## Boundary Context

- **In scope**:
  - A global/cross-project template storage tier as a sibling scope to the existing per-project workflow storage, keyed under a stable reserved global scope under the resolved Command Center config directory; full create/read/list/update/delete of global templates.
  - A unified template listing that surfaces both the global tier and the current project's tier together, with each item carrying its tier/origin so a person or agent can tell where a template lives.
  - Launching (instantiating) a global template into the current project's session through the upstream start path, applying the upstream parameter-declaration/substitution/validation path unchanged.
  - A declarative, general prerequisite block on a workflow definition: required filesystem paths (worktree-relative, traversal-rejected at accept time) and required agent skill references (covering skills and slash-commands), each declaratively named with a documented cross-backend matching rule, with skill prerequisites carrying an optional `backend` scope, validated through strict (unknown-field-rejecting) declaration schemas, treated as literal (a `{{...}}` occurrence in any prerequisite field is rejected at accept time; prerequisites are never a substitution target), with no auto-remediation.
  - A deterministic start-time pre-flight check that evaluates the launched template's declared prerequisites against the target session worktree — mirroring the actual runtime skill-discovery of the backend(s) the resolved workflow uses (skill discovery via the same runtime skill-discovery service), never reimplementing or hardcoding it — before seeding an execution, and halts the launch with a precise, itemized diagnostic (which prerequisites are missing and of what kind) when any are unmet, before any agent tokens are spent.
  - Surfacing the pre-flight pass/fail outcome — including the specific missing prerequisites — to the launcher (human via the launch surface, agent via the start interfaces).
- **Out of scope**:
  - The parameterization engine itself (parameter declaration, substitution, substituted-definition re-validation, start-input validation, audit field) — owned by `workflow-parameterization` and consumed here unchanged.
  - Promote-to-global / fork-into-project transfer flows between the two tiers.
  - Auto-installing, inferring, or remediating missing prerequisites; the probe only reports.
  - A PATH-executable prerequisite kind and a backend-child-process command probe (no motivating evidence; out of scope).
  - Secrets in prerequisites or anywhere else.
  - Any runtime graph dynamism, conditional edges, expansion nodes, or mid-run prerequisite re-checking.
  - Concrete visual/layout/component design of the library and launch surfaces (owned downstream by Claude Design); this spec specifies capabilities, consumed/produced data, required states, validation/error conditions, and behavioral acceptance only.
- **Adjacent expectations**:
  - Consumes the `workflow-parameterization` parameter-declaration schema, the deterministic seed-time substitution + substituted-definition re-validation path, the start request shape (`{ definitionId, parameters? }`), the start-input validation pipeline, and the execution audit field — unchanged. This feature must not redefine, fork, or alter those contracts.
  - Extends the existing per-project workflow storage layer additively with a sibling global scope; the existing per-project behavior is preserved without migration.
  - Reuses the existing execution start path and its halt/diagnostic and dirty-worktree guard behavior; the pre-flight check is an additional deterministic gate at start, not a replacement for existing guards.
  - A global template is launched into the **current session's project** through the existing start path (which already targets the session's project/worktree); this spec does not add a project picker and does not change how the start path resolves its target project.

## Requirements

### Requirement 1: Global Template Storage Tier

**Objective:** As a workflow author, I want to store a workflow definition in a global cross-project tier, so that one methodology-level template is usable from any project without being recreated per project.

#### Acceptance Criteria

1. The Workflow Template Storage Service shall persist a global template under a stable reserved global scope in the resolved Command Center config directory that is a sibling of the existing per-project workflow scopes and is not bound to any single project key. The reserved global-scope directory key shall contain at least one character outside the base64url alphabet (`A–Za–z0–9-_`), so it can never equal `base64url(projectPath)` for any project path — making a collision structurally impossible rather than relying on a runtime guard.
2. The Workflow Template Storage Service shall support create, read, list, update, and delete operations on global templates using the same definition record shape used for per-project workflow definitions.
3. While reading or writing a global template, the Workflow Template Storage Service shall apply the same accept-time definition validation that a per-project workflow definition passes, including the upstream parameter-declaration shape checks and placeholder-reference lint.
4. The Workflow Template Storage Service shall preserve all existing per-project workflow storage behavior unchanged, so that a project-local workflow continues to save, load, list, update, and delete exactly as before.
5. When a previously saved per-project workflow definition is loaded after the global tier is introduced, the Workflow Template Storage Service shall load it without requiring any migration or schema change to its stored record.
6. The Workflow Template Storage Service shall persist any fields it introduces on a definition record so that they survive a save/load round-trip without loss or silent defaulting.

### Requirement 2: Unified Template Library Across Tiers

**Objective:** As a person or agent choosing a workflow to run, I want to browse global templates and the current project's templates in one listing that distinguishes their origin, so that I can find and select a template regardless of which tier holds it.

#### Acceptance Criteria

1. When a template listing is requested for a given project, the Template Library Service shall return both the global tier's templates and that project's templates in a single combined listing.
2. The Template Library Service shall annotate each listed template with its tier/origin so that a consumer can distinguish a global template from a project-local template.
3. Where the global tier and a project's tier each contain a template, the Template Library Service shall list each as a distinct item and shall not merge, deduplicate, or hide either based on name similarity.
4. When the global tier contains no templates, the Template Library Service shall still return the project's templates, and when a project contains no project-local templates, the Template Library Service shall still return the global templates.
5. The Template Library Service shall expose enough per-item metadata for a consumer to launch the item, including its tier/origin, its identifier, and its declared launch parameters.

### Requirement 3: Instantiating a Template Into a Project

**Objective:** As a person or agent, I want to launch any template — global or project-local — into the current project's session, so that a shared template runs in my project using the existing parameterized launch mechanism.

#### Acceptance Criteria

1. When a launch is requested for a template identified together with its tier, the Graph Workflow Start Service shall load the template from the indicated tier and launch it into the current session's project through the existing start path.
2. While launching a global template, the Graph Workflow Start Service shall apply the upstream parameter-declaration, start-input validation, deterministic substitution, and substituted-definition re-validation path unchanged, exactly as it does for a project-local template.
3. The Graph Workflow Start Service shall record the launched template's tier/origin alongside the existing execution audit fields, so that an execution is attributable to the tier it was launched from without altering the upstream audit contract's existing fields.
4. If a launch references a template that does not exist in the indicated tier, the Graph Workflow Start Service shall reject the launch with a not-found error identifying the tier and identifier, and shall not seed an execution.
5. When a global template is launched into a project, the Graph Workflow Start Service shall not copy, move, or modify the stored global template, preserving its single shared definition for reuse by other projects.
6. The Graph Workflow Start Service shall preserve all existing launch guards, including the active-execution guard and the uncommitted-changes guard, applying them to a global-template launch exactly as to a project-local launch.

### Requirement 4: Declarative Prerequisite Block on a Template

**Objective:** As a workflow author, I want to declare a template's prerequisites generically, so that any reusable template can state what a target project must provide without being tied to a specific workflow or methodology.

#### Acceptance Criteria

1. The Workflow Template Storage Service shall allow a definition to declare zero or more prerequisites, where the supported prerequisite kinds are a required filesystem path and a required agent skill reference (the `skill` kind covers both skills and slash-commands; there is no separate command-executable kind).
2. The Workflow Template Storage Service shall require each declared prerequisite to specify its kind and the identifier it requires (the path or the skill reference), and shall allow an optional human-readable label or rationale.
2a. The Workflow Template Storage Service shall allow a `skill` prerequisite to declare an optional `backend` (`"claude"` or `"codex"`) scoping the prerequisite to that backend; a `skill` prerequisite that omits `backend` is backend-unscoped and applies to every backend the launched workflow uses. A `path` prerequisite has no `backend` field (filesystem presence is backend-independent).
2b. The Workflow Template Storage Service shall define the `skill` prerequisite identifier as a backend-neutral skill reference matched against the names returned by the runtime command-discovery service after normalizing both sides with the same rule: trim ASCII whitespace and remove at most one leading invocation sigil (`/` or `$`). Namespace separators such as `:` remain part of the reference and must match exactly. For example, `kiro-spec-design`, `/kiro-spec-design`, and `$kiro-spec-design` share the same normalized reference `kiro-spec-design`, while `kiro:spec-init` matches `/kiro:spec-init` but does not match `kiro-spec-init`. The invocation sigil shall never select the backend; only the optional `backend` field and the used-backend set control which backend roots are checked.
2c. The Workflow Template Storage Service shall not use fuzzy matching for skill prerequisites: no case folding, suffix matching, namespace stripping, colon-to-hyphen translation, or basename fallback is permitted. If the same conceptual capability has different normalized references on different backends, the author shall declare backend-scoped prerequisites for each backend-specific reference rather than relying on a backend-unscoped prerequisite.
3. When a definition declares no prerequisites, the Workflow Template Storage Service shall treat it as having an empty prerequisite set and shall preserve its existing save, load, and launch behavior unchanged.
4. If a declared prerequisite omits its kind or its required identifier, the Workflow Template Storage Service shall reject the definition at save time with an error identifying the offending prerequisite.
5. The Workflow Template Storage Service shall persist declared prerequisites as part of the definition so that they survive a save/load round-trip without loss or silent defaulting.
6. The Workflow Template Storage Service shall apply the prerequisite declaration rules uniformly to global and project-local definitions, with no rule conditioned on a specific definition, project, or workflow identity.
7. Secrets in prerequisite declarations are policy-prohibited and out of scope in this version: there is no secret prerequisite field, and the service applies no redaction or secret-content inspection. Prerequisite-declared strings (the path, skill reference, and any label/rationale) are arbitrary strings persisted and surfaced exactly as declared; the Workflow Template Storage Service shall treat them as non-sensitive and shall log and surface them unredacted. Authors MUST NOT place secrets in prerequisite declarations, because a secret so placed would be retained and shown in the clear. (The `.strict()` declaration schema of Requirement 4.9 rejects unknown *fields* but does not, and is not claimed to, prevent a modeled string field from *containing* a secret.)
8. While accepting a definition that declares a required-path prerequisite, the Workflow Template Storage Service shall require the declared path to be worktree-relative, and shall reject the definition at definition-accept time with a precise error identifying the offending prerequisite if the path is absolute or contains any `..` (parent-directory) segment, so a path prerequisite can never be authored to reference a location outside the target worktree.
9. The Workflow Template Storage Service shall treat each prerequisite declaration schema as strict, rejecting at definition-accept time any prerequisite carrying a field not modeled for its kind, so there is no channel to carry an unmodeled value through a prerequisite declaration. (Secrets in prerequisite declarations are addressed by Requirement 4.7, not by this strict-schema rule.)
10. Prerequisites are literal, environment-level declarations and are never a substitution target: the upstream `{{inputs.<name>}}` substitution and grammar lint scan only content and charter text fields (`workflow-parameterization` Requirements 2 and 4) and never scan prerequisite fields, and the deterministic pre-flight check (Requirement 5) runs before any upstream substitution. Because a `{{...}}` occurrence in a prerequisite field would therefore be evaluated literally rather than substituted, the Workflow Template Storage Service shall reject the definition at definition-accept time with a precise per-prerequisite error if any prerequisite field (the path, the skill reference, or the label/rationale) contains a `{{...}}` occurrence, using the same `{{...}}` detection the upstream accept-time placeholder lint uses (`workflow-parameterization` Requirement 2) so the two lints stay consistent.

### Requirement 5: Deterministic Start-Time Pre-Flight Prerequisite Check

**Objective:** As a person or agent launching a template, I want its declared prerequisites verified deterministically in the target worktree before the run begins, so that a missing prerequisite is reported immediately and no agent tokens are spent on a doomed run.

#### Acceptance Criteria

1. When a launch is requested for a template that declares prerequisites, the Pre-Flight Prerequisite Service shall evaluate each declared prerequisite against the target session worktree before any execution is seeded and before any agent turn starts.
2. The Pre-Flight Prerequisite Service shall evaluate prerequisites using deterministic engine code only, without invoking any agent or language-model step.
2a. The Pre-Flight Prerequisite Service shall compute the **set of backends the launched workflow actually uses** — the distinct backends across all per-context implementers and all context-validators across all execution contexts, as determined by the resolved config cascade (per-context override → workflow override → global default; the same resolution the run uses). Backends are NOT a parameterizable field, so this set is resolvable before substitution. The pre-flight check uses this used-backend set to scope backend-dependent (skill) prerequisites; it shall not assume a single launch backend.
3. While evaluating a required-path prerequisite, the Pre-Flight Prerequisite Service shall resolve the declared worktree-relative path against the target session worktree via realpath and shall treat it as satisfied only when the resolved real path exists and stays contained within the target session worktree; a path that resolves (for example, through a symlink) to a location outside the worktree shall be treated as unmet/invalid, never satisfied.
4. While evaluating a required-skill prerequisite, the Pre-Flight Prerequisite Service shall treat it as satisfied only when the normalized skill reference is **discoverable** for the relevant backend(s) (Requirement 5.4a), where "discoverable" means `discoverCommands(worktreePath, backend)` returns a skill or slash-command item whose normalized `name` exactly equals the normalized declared reference (Requirement 4.2b), and where discoverability is NOT a function of the skill's dynamic enabled/disabled runtime state.
4a. The Pre-Flight Prerequisite Service shall scope a skill prerequisite by backend: a skill prerequisite carrying a declared `backend` (Requirement 4.2a) is checked only on that backend's roots; a backend-unscoped skill prerequisite shall be satisfied only when it is discoverable on **every** backend in the used-backend set (Requirement 5.2a). For each backend, discoverability shall be determined by reusing the existing runtime skill-discovery service rather than re-enumerating roots: a skill reference is "present" when it is discoverable via the same discovery the run uses (`discoverCommands(worktreePath, backend)` / the `discoverClaudeItems` and `discoverCodexItems` scans in `src/lib/commands/service.ts`, which return both skills and slash-commands), so the pre-flight roots mirror the run exactly — including the Codex built-in/system root `~/.codex/skills/.system` (`src/lib/commands/service.ts` ~line 384) so built-in skills do not false-fail. The check shall never consider a backend's roots that is not relevant to the prerequisite.
4b. The Pre-Flight Prerequisite Service shall resolve backend-dependent (skill) prerequisites against the backend(s) that will actually run the launch, deterministically computed from the resolved config cascade before probing (Requirement 5.2a) — never against an arbitrary single backend and never against a union of backends the workflow does not use.
5. If any declared prerequisite is unmet, the Pre-Flight Prerequisite Service shall halt the launch with a precise diagnostic that itemizes each missing prerequisite and its kind, and shall not seed an execution or start any agent turn.
6. When every declared prerequisite is satisfied, the Pre-Flight Prerequisite Service shall allow the launch to proceed to the existing start path with no behavior change.
7. When a launched template declares no prerequisites, the Pre-Flight Prerequisite Service shall allow the launch to proceed with no added gate.
8. The Pre-Flight Prerequisite Service shall report only the outcome of the prerequisite check and shall not attempt to install, create, infer, or otherwise remediate any missing prerequisite.
9. The Pre-Flight Prerequisite Service shall run the prerequisite check before the upstream seed-time substitution and re-validation so that a prerequisite failure is reported as a distinct prerequisite diagnostic rather than as a substitution or validation error.
10. If a declared prerequisite cannot be definitively evaluated because its deterministic probe errors (for example a filesystem error other than not-found, or a skill-discovery failure), the Pre-Flight Prerequisite Service shall treat the prerequisite as unmet (fail closed) and shall itemize it in the prerequisites-unmet diagnostic with a reason distinguishing "could not be evaluated" from "definitively absent"; it shall never treat a probe error as satisfied. A path the realpath probe reports as not-found is "definitively absent" (the normal missing-path case), not a probe error.

### Requirement 6: Pre-Flight Ordering and Failure Attribution

**Objective:** As a workflow operator, I want a prerequisite failure to be clearly attributable and to leave no partial run, so that I can act on the precise cause without confusing it with other launch errors.

#### Acceptance Criteria

1. The Graph Workflow Start Service shall order the start-time gates in the upstream shared start path so that the existing active-execution and uncommitted-changes guards and the prerequisite check all run before any execution is seeded, and so both the HTTP and MCP start surfaces traverse the same ordered chain.
2. If the prerequisite check fails, the Graph Workflow Start Service shall return a prerequisite-failure result that is distinguishable from a missing-input, invalid-input, not-found, active-execution, and uncommitted-changes result.
3. When the prerequisite check fails, the Graph Workflow Start Service shall leave no seeded execution, no agent conversation, and no started agent turn for that launch attempt.
4. The Graph Workflow Start Service shall apply the same prerequisite check and the same failure attribution regardless of whether the launch came from the human launch surface or from the agent start interface.

### Requirement 7: Template Library and Launch UI Capabilities

**Objective:** As a person using Command Center, I want to browse templates across tiers and launch one into my project, seeing prerequisite results before a run starts, so that I can confidently run a shared template and understand any failure without prescribing how the screen looks.

#### Acceptance Criteria

1. When a person opens the template library for a project, the Template Library UI shall present both global and project-local templates in one browsable listing and shall indicate each template's tier/origin.
2. Where a template declares prerequisites, the Template Library UI shall make those declared prerequisites visible to the person before launch.
3. When a person launches a selected template, the Template Library UI shall send the launch to the start interface together with the template's tier/origin and any supplied launch parameter values.
4. If a launch is rejected by the start-time prerequisite check, the Template Library UI shall surface the precise missing prerequisites, itemized by kind, and shall reflect that the run did not start.
5. If a launch is rejected for a non-prerequisite reason (missing or invalid input, not-found, active execution, or uncommitted changes), the Template Library UI shall surface that distinct rejection reason and shall reflect that the run did not start.
6. When a launch passes all gates and starts, the Template Library UI shall reflect that the run started.
7. The Template Library UI shall consume the declared launch parameters and prerequisite metadata from the listing and produce the launch request data, without depending on any concrete visual layout, component structure, styling, or fixed copy specified in this document.

### Requirement 8: Agent Access to the Library and Prerequisite-Gated Launch

**Objective:** As an orchestrating agent, I want to discover templates across tiers and launch one with the same prerequisite gating a human gets, so that agent-driven runs of shared templates fail closed on missing prerequisites just as human-driven runs do.

#### Acceptance Criteria

1. The Graph Workflow MCP Tools shall allow an agent to list templates across the global tier and the current project's tier, with each item annotated by its tier/origin.
2. When an agent launches a template through the start tool, the Graph Workflow MCP Tools shall apply the same start-time prerequisite check, the same upstream start-input validation and substitution path, and the same gate ordering as a human launch.
3. If the prerequisite check fails for an agent launch, the Graph Workflow MCP Tools shall return a structured prerequisite-failure result that itemizes each missing prerequisite and its kind, and shall not seed an execution.
4. If an agent launch references a template that does not exist in the indicated tier, the Graph Workflow MCP Tools shall return a not-found result identifying the tier and identifier, and shall not seed an execution.
5. The Graph Workflow MCP Tools shall not provide any capability to bypass, disable, or re-check prerequisites after a run has started.

### Requirement 9: General-Primitive and Additive Guarantees

**Objective:** As a maintainer, I want the global tier, library, prerequisites, and pre-flight check to be general additive primitives, so that existing workflows keep working unchanged and no behavior is special-cased for any single workflow.

#### Acceptance Criteria

1. The Graph Workflow Engine shall apply the global tier, the unified library, the prerequisite declaration, and the pre-flight check uniformly to any definition, with no behavior conditioned on a specific definition, project, feature name, or workflow identity.
2. The Graph Workflow Engine shall reuse the upstream parameter-declaration, substitution, substituted-definition re-validation, start-input validation, and audit machinery unchanged, neither forking nor modifying those contracts.
3. While launching a template that declares no prerequisites and no parameters, the Graph Workflow Engine shall behave exactly as a static zero-input project-local launch behaves today.
4. The Graph Workflow Engine shall keep the prerequisite check confined to reporting whether declared paths and skills are present, leaving the scheduler, validators, approval gate, charter authority, and the upstream substitution path otherwise unchanged.
5. The Graph Workflow Engine shall preserve the upstream substitute-once semantics and static graph topology, introducing no runtime graph dynamism through the global tier, library, prerequisites, or pre-flight check.
