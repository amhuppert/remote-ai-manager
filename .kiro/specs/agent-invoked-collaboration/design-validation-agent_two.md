# Design Validation — agent-invoked-collaboration

## Design Review Summary

The design is directionally strong: it reuses the workflow MCP tool registry, collaboration policy, config cascade, and halt machinery instead of inventing a parallel runtime. I would not approve it as-is because two implementation-facing gaps can cause the feature to miss required configuration and observability behavior.

## Critical Issues

### Critical Issue 1: Global defaults are assigned to the wrong schema/module

**Concern:** The design repeatedly says to add `WorkflowDefaults.collaboration` in `src/lib/workflows/schemas.ts`, but the actual `workflowDefaultsSchema` and raw config schema live in `src/lib/config/schemas.ts`; defaults are also seeded in `src/lib/config/loader.ts` and `src/lib/workflow-graph/resolve-config.ts`.

**Impact:** Implementers following the design can update workflow/per-node overrides while forgetting the raw/global config path. That would break R2.1-R2.3 and R2.5 because the documented global fallback and provenance source cannot be reliably parsed, defaulted, or logged.

**Recommendation:** Update the design to explicitly modify `src/lib/config/schemas.ts` (`workflowDefaultsSchema` and `rawWorkflowDefaultsSchema`), `src/lib/config/loader.ts` (`defaultConfig()` / merge defaults), `src/lib/workflow-graph/resolve-config.ts` (`SEEDED_DEFAULTS`, `coerceGlobalDefaults`, `resolveWorkflowConfig`, `resolveContext`), and `src/lib/workflows/schemas.ts` only for workflow/per-context overrides and halt/result schemas.

**Traceability:** R2.1-R2.5.

**Evidence:** `design.md` File Structure Plan and Data Models sections; actual code has `workflowDefaultsSchema` in `src/lib/config/schemas.ts`.

### Critical Issue 2: "Workflow run log" requirements are mapped only to structured logger/SSE, not execution logs

**Concern:** R2.5 and R5.2 require recording resolved settings, source layer, failure status, brief, and conflicts in the workflow run log. The design maps these mainly to `logger.info("graph-workflow.tool.request_collaboration.*")` and SSE events, but the project has a separate workflow forensics log under `workflow-logs/{executionId}/` via `execution-logger.ts`.

**Impact:** Operators and post-hoc agents may not find collaboration decisions in the canonical workflow execution log. This weakens the debugging goal of the feature and can technically satisfy global diagnostics while missing the requirement's workflow-run-log surface.

**Recommendation:** Add an explicit execution-log contract: write invocation/completion/failure entries to the workflow execution logger, likely `contexts/<contextId>/iterations.jsonl` or `decisions.jsonl`, including `parentImplementerTurnId`, resolved settings with provenance, terminal status, rounds consumed, and `openConflicts` summary. Keep structured logger and SSE as additional observability, not the only record.

**Traceability:** R2.5, R5.2, R6.1, R6.4.

**Evidence:** `design.md` Event Contract, Monitoring, and Data Contracts sections; `.kiro/steering/logs.md` defines dedicated `workflow-logs/{executionId}/` files for graph workflow forensics.

### Critical Issue 3: Envelope persistence shape is inaccurate for `parentImplementerTurnId`

**Concern:** The design says "Workflow collab envelope JSONL records gain `parentImplementerTurnId` and `origin: "workflow"`", but the current primitive envelope is a session-state record with fixed top-level fields and an opaque `featureSnapshot`. Adding top-level fields is not the established shape.

**Impact:** Implementers may add fields that are dropped by parsing or not surfaced consistently, leaving R6.2's transcript/envelope linkage incomplete. It also risks modifying primitive envelope vocabulary for a feature-specific concern that should stay inside the collaboration snapshot or artifact metadata.

**Recommendation:** Revise the design to store `origin`, `parentImplementerTurnId`, and any collaboration-specific linkage inside the collaboration envelope `featureSnapshot` (or a collaboration-specific artifact record), and only use primitive `parentWorkflowId` if there is a real parent workflow envelope ID. Add schema/tests at the collaboration layer that validate the feature snapshot.

**Traceability:** R6.2.

**Evidence:** `design.md` Technology Stack and Physical Data Model sections; `workflowEnvelopeSchema` currently has top-level lifecycle fields plus `featureSnapshot`, not arbitrary feature fields.

## Design Strengths

- The sibling workflow envelope plus shared helpers is the right boundary for preserving `/collab` behavior while making the no-user-pause invariant reviewable.
- The pre-dispatch `pendingHaltReason` check directly addresses the hard R5.3/R5.4 ordering problem and fits existing workflow-manager halt handling.

## Final Assessment

**Decision: NO-GO.**

The core architecture is sound, but the design needs revision before task generation because configuration defaults and workflow-run observability are easy to implement incorrectly from the current document. After updating those contracts and the envelope persistence shape, this should be a straightforward GO.

## Next Steps

1. Revise `design.md` to correct the config/default file ownership and exact resolver surfaces.
2. Add a concrete execution-log persistence contract for invocation, completion, and collaboration-failure entries.
3. Move workflow-collab linkage fields into the collaboration feature snapshot/artifact schema rather than top-level primitive envelope fields.
4. Re-run `/kiro-validate-design agent-invoked-collaboration`.
