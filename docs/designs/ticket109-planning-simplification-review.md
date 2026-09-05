# Ticket #109 pre-implementation design review

Date: 2026-09-05

Reviewed: revision 2 of `docs/designs/ticket80-native-sdd-planning-simplification.md`, sections 3.3, 3.4, 3.7, 5 and 6, against the current session worktree. Decisions D-A through D-F remain approved. This review concerns gaps in their execution contracts, not reconsideration of those decisions.

Verdict: approved for implementation after Alex accepted all three recommended choices on 2026-09-05. R1 keeps whole-context GO; R2 uses one indexed claims document with context-section pointers; R3 requires fresh v4 sign-off for unlaunched v3 candidates. The other findings have bounded remedies within the ticket's existing scope. No production code or persisted application state has been changed.

## Accepted decisions

### R1 — A passing validator result cannot cite a successful criterion

Disposition: **accept**, clarify section 3.3 and live scenario S4 before implementing evidence attribution.

`src/lib/workflow-graph/validator-runner.ts:184` builds the model-facing output schema. `criterionId` belongs to a blocking issue; a result with no issues passes (`:696`). `src/lib/workflow-graph/validator-runner.test.ts:672` explicitly verifies that a cited criterion travels with a failing outcome. A passing result has no positive criterion-citation collection. Specialist blocking seats may also raise issues without any criterion citation.

The delivery gate consumes `AuthoredContextOutcome`, whose satisfied variant has no record-level evidence (`src/lib/workflow-graph/authored-context-outcome.ts:20`). It attributes a satisfied context to its frozen claims (`src/lib/specs/delivery-gate-v2.ts`, `evaluateLinkedExecution` and `recordVerdicts`). Consequently, a "GO citing one record" cannot be represented today. Interpreting issue citations as successful evidence would invert their meaning; interpreting an uncited record as passing while its context fails would change the gate policy.

Recommended decision: keep GO as whole-context certification. Derive and freeze the union of each stable context's selected `covers`; a satisfied context proves that union. Map a cited failure to only that record's covered spec criteria where presenting failure attribution, without granting partial delivery from a failed context. Amend S4 to prove frozen claim derivation, exact failure attribution, and passing-context attribution to its covered union.

Alternative: add explicit positive record citations and define their completeness, cohort aggregation, persistence, and gate semantics. Keep spec IDs out of the model output: the server still maps record IDs through frozen coverage. This requires an extension to the validator contract and a bounded design pass on that extension before implementation.

### R2 — One immutable claims document cannot put each reader first

Disposition: **accept-reduced**, settle presentation without introducing mutable lane-specific copies.

`src/lib/specs/execution-claims-document.ts:12` renders one document from the immutable ownership projection. It has no reader context input. `src/lib/specs/execution-service.ts:2566` supplies it once at launch through the shared seeded-document channel. The current rendering contract deliberately keeps these bytes independent of runtime state. Section 3.4 simultaneously requires one global claims document, no per-context claims documents, and each reading context's claims first. A single ordering cannot satisfy that for two distinct contexts.

Recommended decision: retain one canonical document with a context index and deterministic context sections. The context's prompt identifies its own section before referring to the full ownership map. Per-context spec excerpts remain separate as D-C requires. This preserves one immutable claims artifact and gives readers direct access to their ownership.

Alternative: authorize per-context claims documents in addition to the global audit map. That meets literal reader-first ordering but changes the explicit one-document constraint and duplicates content.

### R3 — The v3 cutover omits approved and parked attempts

Disposition: **accept**, specify the behavior of every unlaunched state.

Section 5 covers draft/proposed attempts and launched history. The actual lifecycle also includes `approved` and `parked` (`src/lib/specs/schemas.ts:1838`); a parked candidate may already have approval. These states cannot silently become v4: their signed candidate bytes contain authored claims, and the graph may have no `covers`.

Recommended decision: every unlaunched v3 attempt must reopen/convert to a v4 draft and re-propose; previously signed candidates also need fresh human sign-off. Preserve frozen candidate history and its exact hashes. Refuse launching an approved/parked v3 candidate with the actionable reopen instruction instead of silently rewriting or discarding its approval. Launched v3 runs remain readable and use their frozen claims, as already authorized by the design.

Alternative: permit already-approved v3 candidates, including approved parked candidates, to launch unchanged through the historical contract. This expands the approved compatibility scope from launched history to additional v3 launches.

## Implementation corrections within the approved scope

### R4 — Review hashing must remove all server-owned augmentation

Disposition: **accept-reduced**.

`canonicalPlanDefinitionHash` currently delegates to the whole-definition hash (`src/lib/workflows/plan-review/schemas.ts:96`). Once SDD materialization uses `definition.seededDocuments`, generated spec/claims/excerpt contents also distinguish the managed definition from the planner's input. Removing only provenance, locks and source entries leaves unequal hashes.

Use one authored projection that removes generated documents as well as generated sources and managed fields. Preserve authored seeded-document contents in the digest. Preserve exact candidate/definition hashes for sign-off; this projection changes only advisory review identity. Test equality after draft finalization, candidate finalization and reopen, and inequality after any authored criterion or document content change.

### R5 — Ordinary plans can author the fields the hash proposal removes

Disposition: **accept-reduced**.

`workflowSemanticDefinitionSchema` publicly accepts `approvalRequired`, `origin` and `lockedRegions` (`src/lib/workflow-graph/definition-schemas.ts:529`). Section 3.7's assertion that ordinary definitions carry none is not a schema guarantee. Unconditional removal changes legal ordinary-plan hashes and erases authored semantics from their review identity.

Scope projection to managed ownership. Leave ordinary definitions' existing digest intact, including legal authored provenance/approval/lock fields and seeded documents. Share the ownership classification with finalization rather than creating an unrelated list in the hash module.

### R6 — Excerpt source ranks must round-trip exactly

Disposition: **accept**, routine implementation detail.

Charter ranks are positive and globally unique. `finalizeDeliveryPlanLaunch` currently allocates two injected ranks and shifts authored ranks by two. Allocate ranks consistently for all scoped excerpts and globals, and have `authoredDeliveryPlanSources` recover the original authored ranks after removing every injected entry. Prove idempotence over repeated finalization and reopen. This also protects R4's hash equality.

### R7 — Seeded-document limits need one byte-based contract

Disposition: **accept**, routine implementation detail.

`seededWorkflowDocumentSchema` (`src/lib/workflow-graph/schemas.ts:2447`) already owns the four requested fields but has no path or byte limits. It cannot be imported back into definition schemas without creating a cycle. Extract that existing contract into a focused module and compose it into definitions and the launch channel.

Enforce the required `.cc/graph-workflow-docs/` containment and UTF-8 byte caps: 262,144 bytes per document and 1,048,576 bytes per plan. Share the validation across local CLI and server acceptance. Validate the effective document set, including generated SDD documents, before candidate freeze so a signed candidate does not first discover a size refusal at launch. Reject conflicting duplicate destinations. Keep the existing durable reservation/materialization mechanism.

## Implementation and verification map

| Area | Main owners | Behavior-first checks |
|---|---|---|
| Coverage and v4 | `workflow-graph/criteria/criterion-records.ts`; `specs/delivery-plan.ts`, `delivery-plan-binding-lint.ts`, `delivery-plan-preflight.ts`, `delivery-plan-health.ts`, `delivery-plan-service.ts` | Covers retained/rendered; claims derived at freeze; each coverage refusal cleared via replace; validate/status/propose parity; lifecycle cutover per R3 |
| Evidence | `specs/execution-binding.ts`, `delivery-gate-v2.ts`; graph authored outcomes and validator result boundary | S4 according to R1; frozen mapping; no spec IDs in validator output; launched v3 history |
| Excerpts/documents | `specs/export.ts`, `execution-claims-document.ts`, `delivery-plan-finalization.ts`, `execution-service.ts`; `workflow-graph/definition-schemas.ts`, `workflow-manager.ts`, `execution-repository.ts`, `shared-documents.ts` | Scoped contents and sources; R2 presentation; Unicode caps locally and at acceptance; durable materialization; S5 in lane worktrees |
| Source lint | `workflows/committed-source-locator-lint.ts`; `workflow-graph/validation.ts` | Seeded locators skipped; accessPolicy absent; exemption deleted |
| Advisory review | `workflows/plan-review/schemas.ts`, status schemas; spec delivery view/service; CLI spec writes; `SpecDeliveryBridge.tsx` | Authored/managed hash equality and ordinary-hash stability; propose/sign-off/bridge verdict; acknowledgement gate remains create/replace only |
| Retirement/docs | CLI spec write/help/schema registry and synchronized CC/native-SDD/planning skill references | No plan edit verb/help/schema reference; covers and seededDocuments match schemas; one owning native-spec planning reference |
| Durability | `workflow-graph/storage.contract.test.ts`; `state-store/spec-delivery-plan-repo.contract.test.ts` and fixture | Maximal round-trip coverage for covers, seededDocuments, v4 binding and derived candidate claims |

After decisions: amend the bounded design passages and S4, implement each behavior with a confirmed failing single-file registered test followed by green, run relevant regression/typecheck/seams/lint checks, then execute S4 and S5 on the session's scratch CC instance using `cctl dev ensure` and fixtures. Read back candidate manifests, delivery evidence and lane documents. Do not count tests against the managing server as verification of worktree code.

The review pass was read-only except for this artifact; the accepted choices are now incorporated into the governing design. No tests were run: production behavior has not changed, and the requested design review precedes implementation.
