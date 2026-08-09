# Requirements Document

## Project Description (Input)

Standardize Command Center validation around one logical command name and an explicit execution scope. Every validation submission accepts `scope: "changed" | "full"`, defaulting to `"changed"`. A project registers a required full executable and, when supported, a separate changed executable under one command profile; Command Center selects the executable, so project wrappers do not parse Command Center's scope argument. A changed request falls back to the full executable when a command has no changed implementation. Explicit repository-relative path filters remain available as a narrower form of a changed run. This is a clean registry-schema cutover: old flat command registrations are rejected rather than supported through a compatibility layer.

## Introduction

Command Center currently represents changed and full validation inconsistently. Some wrappers choose changed behavior internally, commands without changed behavior happen to run fully, and the repository exposes `test` and `test-full-suite` as separate logical commands. This feature makes scope a first-class service contract while keeping scheduling policy, cost, timeout, and workflow selection attached to one stable logical command identity.

## Boundary Context

- **In scope**: project validation registration, CLI and API submissions, internal validation callers, service-side executable selection and fallback, path-filter validation, durable run metadata, command discovery, this repository's wrappers and `CommandCenter.json`, validation documentation, setup guidance, generated CLI help, and automated tests.
- **Out of scope**: changing the weighted FIFO scheduler, adding arbitrary command arguments, exposing executable paths to agents, changing validation policy semantics, or adding distinct cost/timeout values per scope.
- **Migration policy**: clean cutover for project configuration and public interfaces. Existing flat command registrations are invalid after this change. Existing durable validation history must remain readable without inventing scope facts that were not recorded.

## Requirements

### Requirement 1: One logical validation command profile

**Objective:** As a project maintainer, I want changed and full executions registered under one logical validation command, so that policies and callers select stable intent rather than implementation variants.

#### Acceptance Criteria
1. Each registered validation command shall have one logical name, one cost, one timeout, one description, and one path-argument policy.
2. Each registered validation command shall declare a full executable.
3. Each registered validation command may declare a distinct changed executable.
4. Workflow policies, validation gates, and agents shall select only the logical command name and shall not select executable-variant names.
5. Command Center shall execute registered executables without a shell and shall not accept arbitrary shell command strings as validation registrations.

### Requirement 2: Standard full and changed scope contract

**Objective:** As a validation caller, I want every command to accept the same scope vocabulary, so that I can request changed or full validation without knowing project-specific wrapper behavior.

#### Acceptance Criteria
1. Every public validation submission shall accept `scope` with the values `changed` and `full`.
2. When a caller omits `scope`, the system shall treat the request as `changed`.
3. When `scope` is `full`, the system shall execute the command's full executable.
4. When `scope` is `changed` and a changed executable is registered, the system shall execute the changed executable.
5. When `scope` is `changed` and no changed executable is registered, the system shall execute the full executable.
6. Command Center shall select the executable before admission and shall not forward its `scope` value as a positional argument to the project wrapper.

### Requirement 3: Explicit path filters remain a safe changed-run narrowing

**Objective:** As an agent working in a test-driven loop, I want to select explicit test files while retaining the scheduler's safety controls.

#### Acceptance Criteria
1. A command whose path policy allows paths shall accept validated repository-relative path filters in addition to `scope: changed`.
2. Path filters shall only narrow a native changed execution and shall never be forwarded to a full executable.
3. The system shall reject path filters combined with `scope: full` before admission.
4. The system shall reject path filters for a command that has no native changed executable before admission.
5. The system shall continue to reject option-like tokens, absolute paths, path traversal, and paths outside the target worktree.
6. Path filters shall not be able to alter workers, heap, pool, configuration, or any other resource-setting option.

### Requirement 4: All validation callers use the logical scope contract

**Objective:** As a Command Center maintainer, I want every validation entry point to use the same service contract, so that scope behavior cannot drift between agents and automated gates.

#### Acceptance Criteria
1. The `cctl validate run` command shall submit a logical command name and scope.
2. Smart Merge, Smart Commit, graph script validators, and graph lane-merge validation shall submit logical command names with the changed scope unless they explicitly require a full run.
3. Validation policy shall continue to authorize logical command names and shall not require separate rules for changed and full executions.
4. Every validation execution shall continue to enter the server-owned validation service and global capacity budget.

### Requirement 5: Scope support and execution are observable

**Objective:** As an operator, I want to see what scope a command supports and what scope a run used, so that validation results and timing data are interpretable.

#### Acceptance Criteria
1. Command discovery shall report whether changed requests execute natively or fall back to full.
2. Discovery and run/status APIs shall not expose registered executable paths.
3. Each newly submitted durable run shall record its requested scope and effective scope.
4. Active-run and lifecycle diagnostics shall distinguish requested changed runs that resolved to full from native changed runs.
5. Scope variants of one logical command shall use the same registered cost and timeout.
6. Historical rows that predate scope recording shall remain readable and shall be represented as unknown rather than assigned an unsupported inferred scope.

### Requirement 6: Clean repository and contract migration

**Objective:** As a maintainer, I want one unambiguous interface after rollout, so that compatibility code does not preserve two competing registration models.

#### Acceptance Criteria
1. The configuration parser shall reject the old flat validation command registration shape.
2. The repository's configuration, wrappers, API and CLI contracts, callers, tests, documentation, examples, and generated skill/help artifacts shall migrate atomically to the new interface.
3. The repository shall remove `test-full-suite` as a logical registration and register the changed and full test executables under `test`.
4. Commands such as type checking and building that do not support safe changed execution shall register only a full executable and shall use full fallback for changed requests.
5. The migration shall not add a temporary compatibility mode for old registry fields or old CLI scope syntax.

### Requirement 7: Existing validation safety and lifecycle guarantees remain intact

**Objective:** As an operator, I want scope standardization without weakening validation isolation, admission, or failure handling.

#### Acceptance Criteria
1. The system shall preserve worktree containment, canonical-root executable resolution, and executable-permission checks.
2. The system shall preserve nested-validation rejection, caller identity checks, and logical-name policy enforcement.
3. The system shall preserve fixed resource profiles, weighted FIFO admission, wait/fail-fast behavior, leases, cancellation, timeout, and process-group termination.
4. The system shall preserve quiet success output and complete colorless failure diagnostics from registered wrappers.
5. A live configuration change shall not alter the executable, cost, timeout, requested scope, or effective scope of an already admitted run.
