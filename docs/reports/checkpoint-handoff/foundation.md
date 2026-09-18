# Capture contracts and durable storage handoff

This context implements the foundation for #132 under approved Design 7. Capture remains unavailable in registered descriptors until the adapter contexts implement it. No model request or new runtime/queue owner is introduced here.

## Canonical interfaces

- `agent-backends/conversation.ts` exposes optional `captureHandoff(input)` and `initialPurpose: {kind: "checkpoint_handoff", captureId, mode}` on the existing factory input. Ordinary callers omit the purpose. Check both declared capability and method presence before dispatch.
- Neutral schemas in `agent-backends/schemas.ts` own mode, availability, limits, result, activity coverage, capture-only usage and omission reasons. Results include `correlatedCompletion`; candidate text requires established mode, submitted/correlated completion, settled execution, complete transport coverage, non-incomplete native coverage, and no observed/unknown prohibited activity. Native coverage may explicitly be unavailable. Costs and their basis are either both present or both null.
- `conversation-checkpoints/budget.ts` owns `CHECKPOINT_CAPTURE_POLICY_VERSION` and frozen `CHECKPOINT_CAPTURE_LIMITS`: one submission, 60,000 ms execution, 5,000 ms settlement, 8,192 added input bytes, 6,144 answer bytes, and native inspection bounded by 8 MiB/2,000 ms. Existing seed budgets and outer payload version 1 are unchanged.
- Checkpoint schemas own `CheckpointHandoff`, the bounded public `CheckpointHandoffReceipt`, explicit `CheckpointHandoffRequest {mode}`, claim/candidate schemas, stages and source coverage. Each category (`plan`, `hypotheses`, `failedApproaches`, `blockers`, `nextStep`) has at most eight claims; text is 1–2,000 UTF-8 bytes; each claim has up to four original references. `reported_observation` requires references. The builder/evidence context still owns semantic reference validation and rendering.
- Transcript origin is `{source: "checkpoint_capture", checkpointCapture: {operationId, captureId, part}}`, with part `control | output | activity | settlement`. This schema preserves existing user/workflow origins; lifecycle owns stamping and evidence context owns filtering.

## Repository calls for lifecycle and recovery

All methods run on the existing serialized SQLite boundary. The production singleton's publication decorator forwards both new methods. Capture receipt projection and committed capture events remain assigned to receipts-http.

1. Pass optional `handoff` to `admitOperation` / `admitRecovery`. Omission/null is baseline. Supplied metadata must be pending and bind `captureId` to `${operationId}:capture` and `admissionSourceBasis` to the admitted basis. All result/stop fields start empty. Request-ID reuse returns the original operation before inspecting a retransmitted choice.
2. `beginCapture({key, operationId, captureId, expectedSourceBasis, at})` persists running intent before submission. Identical retries reuse the row; changed scope, identity, basis, phase or start time is refused.
3. `settleCapture` takes that same identity plus `expectedStage: pending | running | settling` and a settlement union:
   - `{kind: "stop", intent: "skip" | "cancel"}` persists settling; cancel can supersede skip. Stop intent is not proof execution stopped.
   - `{kind: "result", handoff}` supplies the complete validated captured/omitted record after execution and required audit writes settle. Preserve pinned request/model/identity/start/stop fields. Set `settledAt` equal to the call's `at`, `executionSettled` and `auditDurable` true, and `finalSourceBasis`. Capture coverage must be after admission and inside that final boundary. This atomically stores outcome and the one permitted source-basis update. A pending request can omit unavailable capture without submission. A stopped request settles omitted with skipped/cancelled reason. Identical result replay is idempotent; a changed result or second source update is refused.
4. `freezePayload` additionally takes `handoffDecision: included | seed_budget` for captured output. A settled omission supplies no decision. The working-state `agentHandoff` member must be present exactly for inclusion. Payload insert, retiring phase and final outcome are one transaction. Candidate text is discarded only after the recorded audit is durable; hash, coverage and usage remain. Exact duplicate freeze reuses the saved result; changed bytes/decision are refused.
5. Existing failed/cancelled outcomes turn a captured candidate into audit-only omitted `checkpoint_failed`, `cancelled` or `interrupted` (existing restart failure code `interrupted`). Already omitted reasons remain unchanged. Unsettled running/settling capture cannot be terminally released.
6. For unknown capture cleanup, use `recordOutcome` from building to needs_reconciliation with failure code `capture_interrupted` or `capture_cleanup_unverified`. The durable omission retains the maintenance gate. The existing outcome method accepts `captureExecutionStopAttestation: {at, source: cli | ui | api}` only for this capture-cleanup hold, with expected/target phase both needs_reconciliation. It records operator assurance, marks uncertain continuity for clearing, and keeps reconciliation ownership. It does not clear the conversation row, deliver a seed, or drain input; recovery owns those existing lifecycle effects. Duplicate acknowledgement preserves the original receipt.

`handoff_json` is nullable and explicitly mapped. Migration `0052-add-checkpoint-handoff` and additive floor preserve existing rows, with forward compatibility barrier 19. Saved v1 seeds are read without rerendering. Tests use isolated databases only.

## Verification

The unmodified full-suite baseline and its exact first JSON verdicts are in [baseline.md](baseline.md). Implementation used failing behavioral reproductions for result/claim/state constraints, persistence, guarded transitions, decorator composition, migration and cleanup holds.

- Capture transitions, both scopes: `vrun-569169e6-1f11-4e53-9d07-3cda84e92e9a` — passed, 1 matched files.
- Core repository, durability, transitions, readiness: `vrun-0e84da9a-a344-455c-bfef-73bc05aa3c41` — passed, 4 matched files.
- Publication, receipt, actor projection, admission, trusted schemas: `vrun-67c5b55d-39d4-4eb6-95e7-3ea38691f84f` — passed, 5 matched files.
- Full typecheck: `vrun-fb12f9a7-3e5c-4b5a-9465-39992092cfc0` — passed.
- Full seams: `vrun-41bb40e0-28d1-4288-81d2-108e0a912d42` — passed.
- Changed lint: `vrun-a93b8e3f-d1ab-46b3-86bc-edde0238be9f` — passed.

Baseline maintenance/restart/recovery/fork integration: `vrun-b9c7e1fb-6987-434e-a5d2-2537197ca270` — passed, 4 matched files.

Migration and backend-descriptor evidence is recorded in the workflow task summaries. The maximal mapping test deliberately populates a synthetic handoff row to cover mutually exclusive fields without claiming a reachable lifecycle; real transition tests independently cover reachable captured, included, omitted and cleanup-attested outcomes.

Invariant audit: inspected added production lines in repository, transitions, publication, backend port and DDL. No new table, state manager, runtime/queue owner, process launcher or provider-identity branch was added. The existing manager/repository/backend seam remains the owner. No adapter implementation, source-generation filtering, UI/CLI wiring or live certification is claimed by this foundation context.

## Context review follow-up

Accepted both blocking findings. Submitted persisted capture metadata now requires a durable start timestamp and a bound mode even for omitted output. Field-specific schema tests cover missing start/mode independently, with and without correlated completion; both-scope SQLite tests prove rejected pending submissions leave the operation and payload unchanged.

Reserved `seed_budget` for atomic `freezePayload` finalization. `settleCapture` rejects that reason from both pending and running without changing the row or source basis. Existing captured-to-included/seed-budget tests continue to prove identical freeze retries reuse the frozen result. Both defects were reproduced with failing registered tests before fixes.

Advisory disposition: defer late observed cleanup persistence to capture-recovery/reconcile-attestation, as assigned by the validator. That context must add a guarded deterministic cleanup/audit settlement path for needs_reconciliation; observed cleanup must not be represented as operator attestation. Current settleCapture intentionally accepts only building, and operator attestation is a separate evidence source.

Follow-up registered verdicts (test runs require matches):
- contract-red: `vrun-7f2559f3-6338-4b84-8812-72b9ada56c32` — expected reproduction failure.
- contract-green: `vrun-916e9fc3-d53e-4e9d-bfd4-5593ae530475` — passed, 2 matched files.
- freeze-red: `vrun-0e34a3ce-313b-42c4-b60f-d52a979a177d` — expected reproduction failure.
- final-tests: `vrun-c29501db-d19f-4933-aed1-68de0b5ce641` — passed, 4 matched files.
- format: `vrun-bdcf743b-4ced-4180-a3d9-debd7b40bde4` — passed.
- typecheck: `vrun-72722dbd-16c1-4b73-943e-3c14cc3aaea3` — passed.
- seams: `vrun-70ba1f59-3f35-44f3-b1ee-615f77088151` — passed.
- lint: `vrun-885c6052-cf29-48e6-8ad4-e275cf5b9e2d` — passed.

Rechecked the one-owner invariant against added production lines: these changes add only schema and existing repository guards; no owner, table, process or provider branch. Production forwarding and payload schema version 1 remain intact.
