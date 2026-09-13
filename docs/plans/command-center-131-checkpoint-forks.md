# Fork the next phase from a checkpoint

Approved design for command-center#131. Alex approved the revised interaction on 2026-09-12, including editable backend/model until first submission and cross-backend forks, and subsequently approved the implemented UI. Implementation, automated/live verification and final UI review are complete. See `docs/reports/command-center-131-checkpoint-forks.md` for the evidence and registered check verdicts.

Alex's requested revision: the fork's backend remains editable until the first message is sent, and the target backend may differ from the source conversation's backend.

## Intended behavior

Alex selects a saved checkpoint, identifies the next task and its work reference, and chooses an initial backend/model. CC creates an ordinary conversation in the source conversation's scope, with a durable checkpoint seed waiting for its first message. The backend and model remain editable in the fork's composer until the first message is submitted; the source backend does not constrain the target choice. For session conversations, both conversations use the same session worktree. Project conversations remain at project scope.

The source checkpoint and archive retain their identities. The fork has its own delivery receipt and fresh provider continuation. Creating the fork sends no model request. The task text becomes an editable composer draft; sending it is the first ordinary turn.

The governing sources are ticket #131 (`cctl ticket get command-center#131`), its parent #129, and `.cc/session-alignment/charter.md`. The existing native `cc-checkpoint-compaction` spec covers the delivered same-conversation lifecycle and history zoom; this proposal composes those mechanisms for the selected fork feature.

## Proposed interaction

Place **Fork from this checkpoint** in the selected checkpoint's summary, above the history/evidence disclosures in `CheckpointPanel`. It operates on the visible selection, including a historical checkpoint. Keep the footer's conversation-wide checkpoint creation and recovery actions in their existing context.

Opening the fork form uses the existing dialog pattern, with a Back action to the checkpoint receipt. Avoid stacked modal focus traps. Display the source name, checkpoint ordinal, saved timestamp, captured boundary, and a link back to its evidence. The selected checkpoint is fixed while filling out the form; choose a different one by returning to checkpoint history.

```text
Fork from checkpoint                                     [×]

SOURCE
Compaction · checkpoint #3 · Sep 12, 10:30
Recorded through seq 482                       View evidence

NEXT TASK
[Implement the checkpoint fork flow…                      ]
[                                                        ]

RELATED WORK
[Ticket                 ▾] [command-center#131          ▾]

INITIAL AGENT · EDITABLE BEFORE FIRST MESSAGE
[Backend                ▾] [Model                       ▾]
[Model parameters supplied by the existing model picker   ]

This conversation shares the session's current worktree.
The task opens as a draft. Send it to start the agent.
You can change the backend and model in the conversation.

                              [Back] [Create fork]
```

Related work offers Ticket, Spec task, and Workflow assignment. Prefill the session's linked ticket when available. Otherwise require an explicit reference. Use bounded searchable selections and canonical server identifiers. For a spec task, persist the spec ID, task element ID and selected revision ID; show its `<slug>/T<n>` handle. For a workflow assignment, persist the execution, assignment ID, owning tier/context and implementer/validator use site; assignment IDs alone are not unique enough.

These are associations for a focused ordinary conversation. Selecting a workflow assignment does not claim a lane or grant permission to complete its tasks. Surface this directly beneath that selection: **“Linked for context. Workflow execution stays with its assigned conversation.”** Likewise, a spec task association does not establish approval or completion.

Related work supplements the session's linked ticket and governing charter. It does not retarget the whole session. For example, a fork focused on child #131 in this session still receives the #129 session charter; the ordinary task draft and explicit child reference identify the narrower work.

Default the initial choice to the source backend and atomic model selection when still admitted. An invalid selection remains visible with its diagnostic and blocks creation until Alex chooses a valid selection. The dialog sets an initial choice; after creation, the normal composer backend/model controls remain enabled. Alex can switch to any admitted backend with checkpoint-fork support, including Claude to Codex or Codex to Claude. Switching backend uses that backend's project-effective atomic model default through the existing picker and visibly updates the model and parameter controls. Compose the existing model catalog UI and admission rules; no fallback model substitution. Use the normal fresh-conversation profile policy because provider context is not inherited.

On success, close the dialog, select the created conversation, and focus its populated composer. A compact provenance row above the transcript reads **“From [source] · checkpoint #3”**, with **View checkpoint** and **View source history** actions. Its seed status is **Ready for first message**, then **Accepted** only after durable input acceptance. Delivery failures use the existing checkpoint recovery surface.

```text
From Compaction · checkpoint #3       Ready for first message
[View checkpoint] [View source history]

[Implement the checkpoint fork flow…                      ]
[Backend: Codex ▾] [Model: … ▾] [Parameters…]        [Send]
```

In this example the source conversation used Claude. Changing the draft fork to Codex keeps the same checkpoint and its source evidence. The provider continuation is created only when the first message is admitted. Disable backend switching immediately while that submission is pending, and enforce the same boundary on the server. Admission refusal before a turn is accepted leaves the draft editable. Once the first turn starts, use normal conversation backend locking and checkpoint recovery rules; model controls continue to follow normal model-change policy.

### Appearance and states

- Compose `Dialog`, `Button`, `FormField`, `StatusChip`, and the existing backend/model selectors. Keep the implementation under `src/components/conversation/` because session and project hosts share it.
- Use `font-display` for the title and `font-mono` for labels, controls, metadata, and explanatory text. Use existing `bg-base`/`bg-surface` elevations, `border-subtle`, text tokens, and spacing tokens. Cyan identifies the primary action; amber identifies unresolved delivery; red identifies errors. Backend identity retains its established treatment.
- Use a single column and a scrollable dialog body. On narrow screens keep all task and reference fields visible, wrap metadata, retain a visible action footer, and use 44px touch targets. Inspect desktop, the single-column session layout, and mobile.
- Creation shows immediate pending feedback and disables duplicate submission. Refusals appear at the relevant field or form, preserving all entered values. Back/Escape returns focus correctly. Source/payload disappearance produces a recoverable error; it never selects another checkpoint implicitly.
- Add Storybook states for default, historical checkpoint, each reference kind, invalid model, loading references, no eligible references, creation pending, creation failure, ready fork with an editable backend, cross-backend draft, first submission pending, and accepted/unresolved provenance. Verify behavior with real hooks and a network fixture, and inspect screenshots in both host contexts.

## Implementation boundaries

### Durable provenance and seed obligation

Extend the checkpoint domain with an explicit fork origin: source `ConversationTarget`, source operation/payload identity, checkpoint ordinal/version/hash, and captured source boundary. Persist the selected work reference and creation request identity with the target conversation. Public projections contain provenance and status, while payload text stays behind explicit seed disclosure.

Create the ordinary conversation and its ready seed obligation in one serialized state-store transaction. Retry the same request ID to retrieve the same fork; reject reuse with a different source or request body. Do not expose a target conversation that can accept a turn before its obligation is durable.

Reuse checkpoint operation storage and delivery/acceptance responsibilities. A fork-specific repository operation installs a ready obligation directly: its prior provider reference is null and it retires no source runtime. Persist a target-owned immutable payload copy with the exact saved seed bytes/hash, plus explicit source provenance. The copy allows a fork's pending seed to survive later explicit deletion of the source checkpoint. Keep source generation usage distinct from the fork's creation/delivery measurements.

The target starts with zero prompts and no provider reference. Saved source history does not increment its prompt count or lock its backend. The payload's generation model and source backend are historical provenance; the target's current backend/model are ordinary mutable conversation settings until first submission. Changing those settings does not regenerate the checkpoint, alter its seed hash, or create provider continuity.

The message-fork `forkedFrom` shape requires a message index, can carry provider references, and limits a synthetic seed to 24,000 characters. Do not force a checkpoint into that shape or pretend the source sequence boundary is a target message index. The checkpoint lineage has its own typed discriminator/field and participates in conversation lineage projections.

Extend repository mappings, public project/session projections, maximal round-trip fixtures, floor/migration behavior, and the schema-version gate as required by the final persisted shape.

### Admission and association

One service owns read-only preflight and creation admission. Both HTTP scopes and the CLI call it. Resolve the saved payload in the explicitly addressed source scope and verify its hash and supported version. A saved immutable payload can be used without stopping the source's current turn. Explicitly admit only non-archived ordinary source conversations with no workflow/collaboration owner, following the parent checkpoint scope. This is a checkpoint-fork rule: the existing message-fork service does not enforce those restrictions. Respect source visibility in both querying and creation. Do not require a resumable source provider reference.

Resolve the initial target backend through `assertBackendExecution` with the conversation facet and `ordinary-conversation` use case; resolve the atomic model selection through `admitConfiguredModelSelection`. Gate checkpoint forks by a descriptor capability that is enabled only after real fork continuation verification. Backend/model changes before first submission use normal selection controls and admission. At first submission, recheck execution admission, checkpoint-fork capability and the complete atomic model selection for the currently selected target backend, and persist that selection before dispatch. Never infer the target backend from the immutable payload's generation model or source provenance.

Compose `setConversationBackend`, the project prompt-entry adoption path and `useBackendModelSelection` as appropriate. Their existing prompt-count/running-state checks establish the ordinary editing behavior; the checkpoint fork must additionally prevent an admitted, queued or uncertain seed attempt from being retargeted by a concurrent backend change. Pin this with a submission-versus-change behavior test, rather than treating `promptCount === 0` alone as proof that switching is safe.

Validate the work reference against authoritative ticket/spec/workflow readers in the same project, and preserve the exact revision/task/assignment identifiers. Spec resolution uses `SpecsRepo` and its element/revision readers; assignment addressing follows `assignment-reference-labels.ts`. Store a reference, not copied task status or approval claims. The target remains ordinary (`role: null`, no workflow owner). Existing execution-owned lane bindings, profile restrictions, and visibility rules remain authoritative.

### First turn and recovery

Compose the existing actor pre-turn checkpoint path, which already binds the assembled input fingerprint and attempt before dispatch and requires both input acceptance and a fresh backend reference. The target uses fresh continuation regardless of source backend; neither native provider fork nor transcript-derived synthetic seeding runs for it.

Keep the frozen source seed verbatim. Its existing framing calls itself evidence from “this same conversation,” so wrap it in a separately bounded, deterministic fork-origin block explaining that the quoted seed belongs to the named source. The wrapper names the target, source checkpoint, work reference, and shared-worktree semantics. It does not rewrite or rehash the historical payload. Record the wrapper's byte count separately from the existing 32,768-byte checkpoint ceiling and include the complete assembled input in the delivery fingerprint. Cap the wrapper at 4,096 UTF-8 bytes; keep the editable task under the ordinary prompt contract.

Use normal fresh-context memory delivery. Neither seed history nor task association substitutes for current authoritative instructions. The broader current-work refresh and optional handoff remain the sibling-ticket work described by the charter.

Known non-delivery leaves the seed ready after retiring the attempted target runtime. Unknown delivery holds continuation for reconciliation without silently replaying the task. Acceptance repairs remain attempt-correlated. Process restart hydrates durable checkpoint authority before queue drain. Recovery after accepted divergence uses the existing explicit checkpoint recovery or another fork, never the source's provider reference.

### Evidence and retention

Source sequence/message/image coordinates remain source-owned. The fork receipt and provenance row open the original checkpoint/evidence reader with the source target; never window the target's transcript using source coordinates. CLI output includes source read/checkpoint/entry handles, with full tool and image recovery delegated to existing readers.

Archiving or compacting the source preserves access under existing retention rules. Explicit source deletion follows CC's existing destructive-deletion contract; the target retains its frozen seed and provenance, and reports unavailable original evidence honestly. No silently redirected links or reconstructed tool/image evidence. Deleting a fork deletes its own seed obligation and payload copy without changing the source. Later checkpoints in the target retain its original fork lineage and recovery links.

### API and CLI

Add checkpoint-scoped `fork/check` and `fork` operations to both existing conversation route families. The JSON request carries a stable UUID, name/task draft, work reference, and complete initial backend/model selection. That selection remains editable through the normal conversation/composer path before first submission; it is not a provider binding. The source conversation and checkpoint operation are path identities. Preflight is read-only; creation returns the target conversation identity and receipt after the durable transaction, with no background model generation to await.

Expose `cctl conversation checkpoint fork-check <conversation-id> <operation-id> --file <request.json>` and `cctl conversation checkpoint fork <conversation-id> <operation-id> --file <request.json>`. Creation uses explicit mutation scoping consistent with `compact-context`; it never discovers another session and writes there implicitly. Use one request schema and the existing help registry, transport, error taxonomy, bounded output, and generated skill reference. Return an exact follow-up command for reading the target receipt and its source history.

Publish through the existing typed event surface, invalidate the target conversation list, and update receipt caches with their existing timestamp ordering. Add structured `checkpoint.fork.*` lifecycle events for preflight refusal, durable creation/reuse and failure; reuse the existing checkpoint delivery events with source provenance identifiers. No seed, task contents, or provider-private references in logs.

## Delivery and verification

Implement in this order after interaction approval:

1. Pin durable creation/idempotency/provenance behavior with a real SQLite fixture; add schemas, repository operation, migration/floor changes and round-trip contracts.
2. Pin admission and work-reference resolution, including invalid model, wrong scope, missing task, restricted source and forbidden ownership/visibility changes; implement the shared service. Verify an unused fork's backend/model can change across providers without altering its checkpoint bytes or provenance.
3. Pin actor first-turn and restart behavior, including the latest selected backend/model, no source resume reference, exact saved seed, one accepted delivery, known non-delivery, uncertain delivery, queued input and acceptance-write recovery; compose the existing lifecycle. Test selection/submission races and refusal of backend changes after an attempt is admitted or its delivery is unresolved.
4. Add API and CLI behavior tests, shared contracts, help, logging and bounded lineage disclosure.
5. Implement the approved UI and stories, test behavior through the real query/mutation hooks, then inspect interactions and screenshots.
6. Run proportionate registered regression tests plus typecheck, lint and seams. Exercise the live branch's session/project routes with real Claude and Codex continuations, including cross-backend forks. Enable each target backend only after evidence passes.

Each behavior change follows red-green-refactor using a single explicit test-file path, `--require-match`, and `--json` with `cctl validate run test`. Scaffolding and visual-only story work can skip test-first because they add no behavior to pin. Broaden tests at integration checkpoints rather than repeating the full suite after each edit.

Live evidence must independently establish task expectations from the original archive: exact identifiers and constraints, a failed approach, the intended next action, a full tool result, and an image handle. Verify separate fresh provider references, exact seed/hash provenance, acceptance durability after reload, untouched source continuation, and the same session worktree. Create a fork with the source backend selected, switch to the other enabled backend in its composer, then send its first message and verify the actual provider used, frozen seed and durable receipt. Exercise both Claude-to-Codex and Codex-to-Claude directions in both scopes. Cover historical checkpoint selection after the source has continued and recovery links after the target is checkpointed again. Browser checks cover both host scopes, editable backend before first send, submission locking, keyboard focus, invalid model/refusal, and narrow layouts. Record measured bytes, latency and usage; leave unsupported metrics unavailable.

The implementation is complete only when these journeys and checks pass and the UI has received the required review. This proposal itself adds no runtime behavior and does not require executable tests.
