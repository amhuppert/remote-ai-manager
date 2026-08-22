# Execution plan

This plan preserves one intentional unresolved decision: the production
transport. The authenticated spike resolves it with evidence; it is not a
free-form implementation choice.

## 0. Re-establish the live baseline

1. Read the checkout's current `AGENTS.md`, steering, and active `.kiro/specs/`.
2. Compare the live HEAD with bundle baseline
   `fa6bf4306f52926be195bef101e09598494dac3e` and refresh the code map where
   files or contracts moved.
3. Confirm the Kiro phase/approval state with Alex. This bundle does not grant
   Requirements, Design, or Tasks approval.
4. Confirm access to an authenticated Cursor test account, supported macOS or
   Linux host, Node >=22.13 for the SDK candidate, and the host `agent` binary
   for ACP.
5. Record the exact Cursor CLI and `@cursor/sdk` versions used by fixtures.

## 1. Land the standalone unknown-backend validation fix

Change both command-discovery route handlers to parse the optional backend query
with `agentBackendSchema` and return a 4xx API error for invalid values. Preserve
the existing default only when the query parameter is absent. Tests must cover
absent, Claude, Codex, and unknown values.

This fix should remain independently reviewable and should precede adding the
Cursor enum member.

## 2. Run the transport bake-off

Build the thinnest isolated SDK-worker and ACP-child probes that share a fixture
capture format and exercise these ten categories:

1. **Isolation:** two concurrent conversations with distinct `CC_*`, cwd,
   credentials, refs, and process trees.
2. **Authentication:** CLI login/key and SDK key/env/`Cursor.auth.login()` store;
   unauthenticated, expired, and enterprise-disabled states; no secret leakage.
3. **Native event capture:** byte-preserving ACP lines or lossless SDK object
   serialization for text, reasoning, read/write/shell tools, permissions, MCP,
   subagents, images, unknown events, malformed input, and terminal errors.
4. **Continuity:** create → prompt → kill → new process → load/resume → prompt;
   stale/deleted/corrupt refs, cwd mismatch, model persistence, and replay
   deduplication.
5. **Cancellation:** during generation, shell execution, MCP, permission wait,
   ask/plan wait, EOF/stall, graceful timeout, forced process-group kill, and
   orphan-child inspection.
6. **MCP authority:** inject a real stdio MCP server, then test project/user
   ambient config merge, disable, filtering, approval, and optional transports.
7. **Models:** authenticated catalog, default/auto behavior, custom/invalid/
   removed IDs, model survival on load/resume, and model-specific params.
8. **Instructions/structured result:** first-turn instruction envelope, any
   process-scoped privileged channel, JSON-schema prompt contract, validation,
   and bounded repair.
9. **Filesystem:** direct, shell, absolute, temp, symlink, subprocess, deny
   precedence, MCP/custom-tool, and network attempts on each claimed platform.
10. **Usage/cost:** per-turn token fields, delayed settlement, charge correlation,
    retries/cancellation, and plan-based billing behavior.

## 3. Write and approve the transport decision

The spike output must contain:

- a requirements-by-transport table with pass/fail/unknown and fixture links;
- lifecycle/process-tree results;
- auth and deployment implications;
- wire stability and fixture-maintenance implications;
- the chosen transport and rejected alternative;
- exact Phase 1 capability declarations;
- unresolved vendor gates.

Select by this priority: isolation/cleanup, permissions, continuity, MCP
authority, models, usage/cost, authentication, then implementation burden.
Delete or quarantine losing production code. Do not support both transports in
Phase 1 for hypothetical flexibility.

Go/no-go:

- No Phase 1 if session load/resume, cancellation/cleanup, or event framing is
  unstable.
- No task facet if autonomous permissions and instruction delivery are not
  acceptable for the eligible profiles.
- No `fsWriteRestriction: "enforced"` without the exact adversarial suite.
- No governed/validator eligibility without both filesystem and privileged
  instruction gates.

## 4. Implement Phase 1 as coherent slices

### 4.1 Transport port and harness

- Keep the port Cursor-local and dependency-injected.
- Add deterministic fake transport fixtures for create/load, streaming,
  cancellation, unknown events, failures, and process exit.
- Add the authenticated native-frame contract fixture captured by the spike.

### 4.2 Runtime and continuity

- Implement create/load/resume and active-turn lifecycle.
- Map native events to neutral events while preserving raw envelopes.
- Implement bounded cancel → process-group kill.
- Normalize stale ref, auth, missing binary, unsupported version, network,
  protocol, and terminal Cursor failures.
- Reuse shared structured-output and stall/timeout mechanisms.

### 4.3 Descriptor and registration

- Add Cursor metadata and conservative capability literals.
- Register conversation facet only; omit task facet.
- Add Cursor MCP and managed-skills declarations that match actual behavior.
- Add production bootstrap wiring only when a viable factory/continuity/config/
  classifier set exists.

### 4.4 Canonical schemas and persistence

- Add `"cursor"` to `agentBackendSchema`.
- Extend config raw/normalized profiles and materialization.
- Extend client-safe catalog/maps without a static account catalog.
- Extend `AgentSessionRef` codec maps/arms and deep round-trip tests.
- Confirm no DB migration is needed by exercising repository persistence and
  restart round trips against text columns.

### 4.5 Product surfaces

- Make settings render registered backends instead of requiring exactly two.
- Add Cursor model/default/custom-ID configuration and an appropriate design
  system tone.
- Cover conversation/session/project selectors, quick-ticket/spawn selection,
  workflow assignment eligibility, command discovery, and transcript labels.
- Keep Collaboration Mode pair types, stores, flows, and UI Claude×Codex-only.
- Do not expose task/validator eligibility while the task facet is absent.

### 4.6 Verification

- Descriptor conformance matches declared behavior.
- Consumer-locality third-backend coverage remains green.
- Native transcript boundary and raw-envelope architecture checks pass.
- Config raw/normalized round trips, API catalog, settings, selectors, command
  discovery, session-ref storage/restoration, and restart tests pass.
- Live: two concurrent conversations, restart/load, cancellation in three
  states, invalid auth/version/model, real MCP behavior as declared, and durable
  transcript/ref round trip.
- Run seam checks and review each identity branch/baseline change.

## 5. Implement Phase 2 behind separate review

1. Prove and enable the shared `.agents/skills` managed-skills bridge.
2. Prove and declare MCP authority/disable/filter/apply behavior.
3. Add images with native fixtures and neutral contract tests.
4. Add asynchronous account/team model discovery without hard-coding the
   changing vendor catalog.
5. Add token usage and only correlated settled billed cost.
6. Add a task facet with a fail-closed eligibility gate for nongoverned
   profiles; test every profile category and unknown values.
7. Harden version drift, credential changes, enterprise policy, lifecycle, and
   live recovery.

## 6. Evaluate parity independently

Do not fold parity into Phase 2 estimates. Record per-platform filesystem proof
and vendor instruction-channel evidence. Only after both are reviewed should
the descriptor declarations and role-selection gates change. Cursor
Collaboration Mode participation remains a separate product proposal even if
both gates pass.

## Validation in the non-CC environment

`sources/project-context/CommandCenter.json` records the authoritative
validation commands. Repository rules require registered validation to run
through `cctl`. Because the target environment is explicitly outside Command
Center, the implementing agent must not silently bypass that rule: either make
`cctl`/the validation service available or ask Alex for explicit permission to
run the exact registered scripts directly. Keep validation output low-noise and
preserve full failures.

