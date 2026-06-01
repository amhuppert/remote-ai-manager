# Design Validation Report — agent-invoked-collaboration

_Consolidated review by agent_one and agent_two (Collaboration Mode, round 1, agreement reached)._

## Design Review Summary

The design's core composition pattern is sound: sibling workflow envelope, additive schema changes, and a pure status translator are the right architectural direction. It reuses the workflow MCP tool registry, collaboration policy, config cascade, and halt machinery instead of inventing a parallel runtime, and enforces R4 ("no user pause") by construction. However, five gaps prevent approval as-is: the file plan misidentifies the config schema location, workflow execution logging is under-specified for the canonical `workflow-logs/{executionId}/` surface, the persistence shape for `parentImplementerTurnId` targets the wrong layer, R5.3 enforcement under multi-tool-call turns is unspecified, and the `envelope.ts` extraction surface is unbounded.

## Critical Issues

### 🔴 Critical Issue 1: Global defaults assigned to the wrong schema/module

**Concern**: Design's File Structure Plan extends `WorkflowDefaults.collaboration` in `src/lib/workflows/schemas.ts`, but `workflowDefaultsSchema` actually lives in `src/lib/config/schemas.ts:27`, with defaults seeded in `src/lib/config/loader.ts` and the cascade in `src/lib/workflow-graph/resolve-config.ts`.

**Impact**: R2.1–R2.5 cannot be satisfied without extending all three config surfaces; implementing only the workflows-schema modification leaves the default cascade half-wired and provenance reporting incomplete.

**Suggestion**: Update §File Structure Plan to add the `collaboration` block to `workflowDefaultsSchema` in `src/lib/config/schemas.ts`, seed defaults in `src/lib/config/loader.ts`, and extend the cascade in `src/lib/workflow-graph/resolve-config.ts`. `WorkflowConfigOverride` and per-context `collaboration` blocks remain in `src/lib/workflows/schemas.ts`. Update §Allowed Dependencies and §Revalidation Triggers accordingly.

**Traceability**: R2.1, R2.2, R2.3, R2.5
**Evidence**: design.md §File Structure Plan > Modified Files (schemas.ts row); verified at `src/lib/config/schemas.ts:27`.

### 🔴 Critical Issue 2: Workflow run log requirements mapped only to structured logger + SSE

**Concern**: R2.5 ("record resolved settings + source layer") and R5.2 ("failure recorded with brief, settings, conflicts") require workflow run log records. The design relies on `logger.info` and SSE events, but the project has a dedicated per-execution forensic log at `workflow-logs/{executionId}/` (lifecycle.jsonl, decisions.jsonl, contexts/<id>/tasks.jsonl, validation.jsonl, prompts/) implemented by `src/lib/workflow-graph/execution-logger.ts`.

**Impact**: Operators and post-hoc agents investigating a workflow halt will not find collaboration decisions in the canonical forensic surface. R2.5 and R5.2 will be partially satisfied at best.

**Suggestion**: Add a §Workflow Execution Logging subsection that names the exact entries written to `workflow-logs/{executionId}/`: invocation event with `resolvedConfig` provenance, completion event, halt entry on `pendingHaltReason = collaboration_failure`, and conflict summary. Specify which file (existing `decisions.jsonl` or new `collaboration.jsonl`) each event lands in.

**Traceability**: R2.5, R5.2, R6.3
**Evidence**: design.md §Monitoring; verified at `src/lib/workflow-graph/execution-logger.ts:1-12`.

### 🔴 Critical Issue 3: Envelope persistence shape targets the wrong layer

**Concern**: Design adds `parentImplementerTurnId` and `origin: "workflow"` at the top level of the workflow-collab envelope JSONL record. The primitive envelope (`src/lib/workflows/primitives/workflow-envelope-vocabulary.ts`) has fixed lifecycle fields plus an opaque `featureSnapshot`; collaboration-specific linkage belongs in the feature snapshot/artifact schema, not the primitive layer.

**Impact**: Implementing R6.2 against the primitive envelope vocabulary leaks collaboration concerns into shared infrastructure and conflicts with the design's own boundary commitment to preserve primitive schemas.

**Suggestion**: Move `parentImplementerTurnId` and `origin: "workflow"` into the collaboration-specific `featureSnapshot` schema. Update §Physical Data Model and §Workflow Collaboration Envelope > State Management. Add the Zod extension to the collaboration featureSnapshot type, not the primitive envelope vocabulary.

**Traceability**: R6.2
**Evidence**: design.md §Physical Data Model; verified at `src/lib/workflows/primitives/workflow-envelope-vocabulary.ts`.

### 🟡 Major Issue 4: R5.3 enforcement under multi-tool-call turns is unspecified

**Concern**: The pre-dispatch read of `pendingHaltReason` enforces "no further tool calls in the current iteration" cleanly only if tool_use blocks within a single assistant turn are dispatched sequentially. The Claude Agent SDK can emit multiple tool_use blocks in one turn; the design does not state the dispatch model.

**Impact**: A parallel `complete_task` issued in the same turn as `request_collaboration` (non-converged) could slip past the halt check and silently violate R5.3.

**Suggestion**: Document the per-turn dispatch model in §System Flows or §Pre-Dispatch Halt Check. If concurrent, replace the pre-dispatch read with either an atomic "halt-or-claim-slot" check or a turn-level serialization rule around `request_collaboration`. Add an integration test for the multi-tool-block scenario.

**Traceability**: R5.3, R5.4
**Evidence**: design.md §Pre-Dispatch Halt Check; §Failure path sequence diagram.

### 🟡 Major Issue 5: `envelope.ts` extraction surface is unbounded

**Concern**: Design refactors `envelope.ts` (855+ lines; imports `pauseForHumanApproval` at line 36, uses it at line 855) by extracting `runNegotiationRound` + collaborator-invocation helpers into `shared-round.ts`. The extraction is described abstractly; the design does not enumerate which functions move, their signatures, or how existing `envelope.test.ts` coverage gates the refactor.

**Impact**: R7.1 ("`/collab` UX unchanged") regression risk through a poorly-bounded extraction.

**Suggestion**: Either (a) defer the extraction — duplicate the round/collaborator logic into `workflow-envelope.ts` for the first cut, dedupe in a follow-up; or (b) add §Envelope Extraction Surface enumerating exact functions to move, their pre-extraction signatures, closure dependencies on envelope state, and the gating tests.

**Traceability**: R7.1, R7.2
**Evidence**: design.md §File Structure Plan > Modified Files (envelope.ts row); verified at `src/lib/workflows/collaboration/envelope.ts:36, :855`.

## Design Strengths

1. **R4 enforced by construction, not runtime**: the combination of a separate `workflow-envelope.ts` module, an ESLint `no-restricted-imports` rule, and a transitive-import test promotes "no user pause" from an aspirational invariant to a CI-gated property — exemplary application of the engineering-principles agent-offloading guidance.
2. **Additive schema extension + single translator**: the pre-dispatch `pendingHaltReason` check directly addresses the hard R5.3/R5.4 ordering problem, and centralizing all status mapping in a pure `decisionToWorkflowResult` translator keeps the change reviewable, testable in isolation, and exhaustiveness-checked by TypeScript at every consumer.

## Final Assessment

**Decision**: **NO-GO** — design revision required before `/kiro-spec-tasks`.

**Rationale**: The core architecture is sound, but the file plan misidentifies the config schema location (Critical Issue 1), the persistence shape targets the wrong layer (Critical Issue 3), and the canonical workflow forensic log surface is omitted (Critical Issue 2). These are structural revisions, not specification clarifications. Major Issues 4 and 5 add specification gaps around R5.3 and R7 that should be resolved in the same pass.

**Next Steps**:
1. Revise §File Structure Plan to put `WorkflowDefaults.collaboration` in `src/lib/config/schemas.ts` with loader seeding and resolver extension.
2. Add §Workflow Execution Logging naming the `workflow-logs/{executionId}/` entries.
3. Relocate `parentImplementerTurnId` / `origin` into the collaboration `featureSnapshot` schema.
4. Specify per-turn tool dispatch model and add a multi-tool-block integration test.
5. Bound or defer the `envelope.ts` extraction.
6. Re-run `/kiro-validate-design agent-invoked-collaboration`, then proceed to `/kiro-spec-tasks`.
