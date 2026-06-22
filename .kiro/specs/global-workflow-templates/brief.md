# Brief: global-workflow-templates

## Problem

Workflow definitions are stored per project, so a methodology-level workflow (usable across many projects) must be recreated in each project. There is no shared/global library, and a template authored for one project can't be launched in another. When a reusable template assumes project-specific prerequisites (directories, skills), running it in a project that lacks them fails mid-run with confusing, hard-to-attribute errors.

## Current State

- Workflow definitions persist per project key under the resolved Command Center config directory; a template saved in project A is invisible to project B.
- `workflow-parameterization` (prerequisite spec) adds launch-time inputs + deterministic seed-time substitution, so a single definition can be reused within a project.

## Desired Outcome

A global/cross-project template tier exists alongside project-level definitions: global templates are listed and launchable from any project, parameterized via the `workflow-parameterization` mechanism. Before scheduling, a deterministic start-time pre-flight check validates a template's declared prerequisites in the target project and halts with a precise diagnostic if any are missing — before any tokens are spent.

## Approach

Extend the existing per-project storage layer with a global tier (not a fork). List global + project templates together (no promote/fork transfer flows in v1). Reuse the parameterization substitution/validation path unchanged. Add a **general, declarative prerequisite block** on a template (required paths and skills; the `skill` kind covers both skills and slash-commands — no PATH-executable kind) plus a deterministic pre-flight probe that runs in the target session worktree at start and reports (does not auto-remediate).

## Scope

- **In**:
  - A global/cross-project template storage tier alongside project-level definitions.
  - A template library listing/browse surfacing both tiers, launchable into the current session's project.
  - A declarative prerequisite block on a template (required paths and skills) + a deterministic start-time pre-flight check that halts with a precise diagnostic when prerequisites are missing.
- **Out**:
  - Promote-to-global / fork-into-project transfer flows (parked for post-v1 in `graph-workflow-improvement-report.md`).
  - The parameterization engine itself (`workflow-parameterization`).
  - A PATH-executable prerequisite kind and a backend-child-process command probe (no motivating evidence).
  - Auto-installing or inferring missing prerequisites (the probe reports; inference is a possible later add).

## Boundary Candidates

- Global storage tier + scoping/key model (reserved key with a non-base64url character).
- Library listing/browse across tiers.
- Declarative prerequisite schema (`path` | `skill`).
- Deterministic pre-flight probe + halt diagnostics.

## Out of Boundary

- Parameterization mechanics (upstream spec).
- Promote/fork flows.
- Any runtime graph dynamism.

## Upstream / Downstream

- **Upstream**: `workflow-parameterization` (param schema + substitution/validation path), the per-project workflow storage layer, the existing execution start / halt-diagnostic machinery, and the dev-server/preflight patterns to mirror.
- **Downstream**: future promote/fork flows; future config-inference for missing prerequisites.

## Existing Spec Touchpoints

- **Extends**: none directly; layers on `workflow-parameterization`.
- **Adjacent**: `workflow-graph-builder` (storage + builder UI), `project-discovery` (project enumeration for the global tier), `dev-server-automation` (pre-flight/probe patterns to mirror).

## Constraints

- Additive; extend storage rather than fork it.
- General primitive — prerequisites declared generically (paths/skills); no Kiro special-casing.
- Deterministic pre-flight (no agent step); precise halt before tokens are spent.
- TypeScript strict, Zod-first, no `any`; round-trip durability for new persisted fields.
