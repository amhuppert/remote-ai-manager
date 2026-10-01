# Durable conversation notices (#171)

The first consolidation stage records spec review feedback and lost-background-task notices in the existing subscription inbox. Ordinary project and session conversations receive review feedback with their next user input, including input queued into an existing runtime. Lost-background-task notices are operational recovery context: every durable conversation role, including workflow lanes and generated turns, receives them when its next runtime is created. Both paths require real backend input acceptance; runtime creation alone is not a delivery receipt.

## Delivery contract

- Ordinary feedback producers record a passive source fact through one subscription service operation. That operation preserves existing pause, unfollow, event-filter and expiry controls. It neither wakes the conversation nor advances a source cursor past undispatched evidence.
- Spec feedback uses the canonical spec event ID as its occurrence ID and shares the spec adapter's fact projection. Direct feedback and automatic spec reconciliation therefore describe one inbox occurrence per recipient, source and event. Spec revisions, review threads and approval events remain canonical domain records.
- Runtime loss uses a narrow operational service port: only an own-conversation `background-tasks-lost` outcome can bypass ordinary recipient eligibility. It is quoted and escaped in new-runtime instructions, excluded from the ordinary user-input briefing, and claimed and settled in the same canonical inbox.
- Feedback follow controls do not silence internal runtime recovery. Existing pause, unfollow, event-filter and expiry values remain intact; the operational port does not restore or alter them. Public-source controls retain their existing behavior.
- The ordinary user-input briefing and the new-runtime recovery context each own their claims through backend input acceptance and settlement. Proven unsent input may retry; unknown acceptance remains inspectable as uncertain. An unaccepted runtime carrying recovery context is closed so it cannot later deliver a finalized reminder. Neither creating a runtime, rendering a human transcript notice nor reading the inbox acknowledges agent delivery.
- Human transcript notices remain independent of agent delivery. Question answers retain their protocol; document feedback retains its send boundary; workflow lane inputs retain their workflow gate and context policy.
- Notification source facts remain quoted context. Existing transcript presentation continues to hide machine notification envelopes from the conversation UI.

## Existing persisted notices

A one-time transactional migration imports nonempty `pending_agent_notices` arrays into the inbox and clears the arrays. Deterministic recipient-and-position occurrence IDs make reruns idempotent. Full legacy text remains available as inbox evidence; the prompt uses a bounded summary. The old runtime-instruction drain is removed, so it cannot compete with the inbox.

Legacy strings have no event ID, timestamp or revision identity. Repeated comments could produce identical strings. The migration preserves them without pretending to reconstruct missing provenance: it cannot determine whether an opaque old string also describes an already-recorded spec event. Canonical event deduplication applies to newly recorded feedback; this historical ambiguity remains visible rather than being resolved by deleting or guessing at evidence. The old field is empty migration-only storage, with no production append or delivery path.

## Completed consolidation stages

The remaining stages are implemented by #181 (notepad notices) and #182 (workflow results). The shared subscription inbox now owns ordinary-conversation delivery for all three stages. Details and final cutover evidence are in [Notepad and workflow notice cutover](notice-delivery-cutover.md).

Notepad accepted context remains a source baseline, while inbox rows own delivery claims. Workflow boundary snapshots remain canonical evidence, with unread/push/fallback effects recorded independently. The retired notepad tracker and origin-only workflow pre-turn claim no longer compete with the inbox. Workflow occurrences use `(executionId, graph event id)` for launcher, subscriber and explicit-wait deduplication. Passive delivery requires the next user input in either conversation scope.

The notepad cutover records accepted reference metadata separately from inbox delivery receipts: the exact rendered content revision, open-comment marker and observed comment IDs. The marker acknowledges awareness of review activity; it does not claim that comment bodies were read or that feedback was submitted. References with open comments include a separate `cctl notepad comment list --status=open` handle and a read-before-acting instruction. Comment bodies stay behind explicit reads and the existing Send feedback boundary. Accepted source context can supersede pending or proven-unsent redundant facts without fabricating an agent-delivery acceptance; uncertain receipts remain inspectable.

Legacy accepted notepad rows have only count/latest-time comment markers. They retain that aggregate comparison when first reconciled; equal-time comment replacement cannot be reconstructed exactly from historical metadata. New reads persist canonical comment identities, so addition, resolution, deletion and reopening are distinguished after restart without guessed equivalence.

## Workflow session deletion policy

Deleting a workflow's source session removes its canonical workflow result ledger
through the existing session foreign key. A surviving project conversation keeps
its copied inbox snapshots and acceptance receipts for inspection; source
reconciliation records a missing-source notice. Deleting a recipient's session
removes that conversation and blocks subsequent delivery through the ordinary
recipient eligibility check. Saved inbox evidence does not create or wake a
replacement conversation.

## Verification

Registered tests cover both conversation scopes, an already-created runtime, queued user input, machine turns leaving notices pending, canonical spec-event deduplication, restart/retry receipts, migrated legacy data, and unchanged human approval/answer boundaries.

- Lifecycle integration: `vrun-4560f933-55d6-4165-aee1-b30c60af8e4e` passed both scope cases. A machine turn leaves a notice pending; the next user input receives it once without recreating the runtime.
- Spec producer/notifier: `vrun-e75422e5-3c19-4f63-bbad-05892fef2337` and `vrun-abdc3ec3-aaac-442c-aa62-e05c74834216` passed canonical identity, both scopes, reconciliation, independent transcript failure, and project-boundary checks.
- Full inbox detail: `vrun-db00dcb9-df44-4cab-8627-6161ac7b50e7` passed 34 CLI tests, including bounded outline versus complete source text.
- Background loss: `vrun-982f3549-9508-4c78-90d6-53a910dc7a47` passed six tests, including long escaped source text and durable acceptance.
- Internal restore: `vrun-47c9bd96-49cc-4448-871b-1806791388a5` and `vrun-5f717703-1832-4ff5-979a-53c2d918e504` passed control and overview tests. Pending evidence survives restoration, future notices resume, and public-source controls retain their semantics.
- Final full typecheck (`vrun-84ee9755-3b1a-4608-aefd-83c92fbca316`), changed lint (`vrun-0291970a-c923-45c9-b2fa-e81d826c17c9`), and formatting (`vrun-36f76337-1743-4de5-8ff3-4ad377a1e3c6`) passed. Architecture seams passed in `vrun-11356b8e-da0f-431b-b5e4-900a846497de`.
- Broad changed-dependency regression (`vrun-a31a7fd5-3b4b-4e82-90af-1387581b4e80`) completed with 12,482 passing tests, six skipped and one migration-registry expectation failure. The registry fixture was updated for migration 0061; its complete suite then passed with one matched file in `vrun-afcbfd55-11c2-4d00-8d4a-165b171a26cc`. The broad run was not repeated after that expectation-only correction, and a separate full-suite run was not requested.

Live verification used real Codex turns on an isolated worktree dev server, with project `wakes-scratch`, a session conversation and a project conversation. Human comment endpoints produced canonical spec events while neither conversation was running. Both next user turns reported the expected `spec-review-commented` fact and source title. Another comment was recorded during an active session turn; the queued user input received it after that turn finished. Each fact had one acceptance attempt.

A further project comment remained pending across a dev-server stop/start, then reached the next user turn. The session conversation, whose notices had already been accepted, reported `NO_NEW_BRIEFING` after restart. Accepted timestamps and attempt counts remained unchanged. Evidence is under `.cc/temp/171-*.sse` and `.cc/temp/171-before-restart-evidence.json` / `171-after-restart-evidence.json` in this worktree. The test session was deleted, the project conversation archived, and the dev server stopped. Two unapproved test spec drafts remain in the isolated dev datastore; no human approvals were performed. Live backend verification was Codex; backend-neutral lifecycle and persistence tests cover the shared delivery contract.
