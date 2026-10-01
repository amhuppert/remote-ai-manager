# Notepad and workflow notice cutover (#181, #182)

The shared subscription inbox owns delivery to ordinary conversations. Canonical notepad revisions/comments and workflow boundary snapshots continue to own source evidence. A source changing, a human reading the inbox, and the backend accepting input remain different acts.

## Notepads

Accepted source context records rendered revisions, open-comment markers and observed comment identities. Out-of-order receipt retries retain the highest accepted revision and the union of actually observed comment IDs. The marker stays one genuinely rendered count/timestamp pair, chosen as an awareness high-water mark; it is not a current comment count or proof that comment bodies were read. This is a source baseline, not another pending-notice queue. A source cursor tracks ingestion independently, while inbox claims track attempts and acceptance.

New comment UUIDs produce distinct comment-added facts; resolving, deleting, renaming, pinning or archiving does not manufacture feedback. Existing comment identities do not become new additions when reopened. Own edits remain suppressed. Newly rendered references cover only their exact content/comment snapshot: facts covered by that snapshot can share its input receipt, but later changes remain pending. A prepared or rejected input never advances accepted source context.

Legacy aggregate comment markers cannot recover original UUID membership. The migration preserves their accepted revision/marker, seeds history conservatively, and uses exact identities for subsequent reads. It must not replay all historical comments as newly submitted feedback.

## Workflow results

Each boundary has identity `(executionId, graph event id)`. The canonical result ledger freezes its outputs, references, pending actions, halt information and abandonment evidence at that transaction, including runs without an origin conversation. The same frozen projection feeds the launcher and other subscribers. A compact notice provides an exact inbox-detail command for the complete frozen evidence; reading current workflow status is not a substitute for that snapshot.

The existing ledger remains the owner of boundary evidence and independent unread/push/fallback effect receipts. Its competing origin-only pre-turn delivery claim is retired. Migration transfers known backend acceptance to the inbox, preserves unresolved claims as uncertain, and never treats a human fallback notification as agent acceptance. Existing delivery IDs and read/wait references survive canonical deduplication.

Passive workflow results now accompany the next **user** input in both conversation scopes. The former origin-only path also appeared on generated turns; that trigger is intentionally removed. Explicit finite waits still request a turn, but share the canonical boundary occurrence so a wake and a passive follow cannot deliver the same result twice.

## Verification obligations

Use durable repository tests for migrations, canonical identity/receipt merging, pause/unfollow, acceptance versus uncertain/not-sent outcomes, and restart. Exercise notepad reference/comment races and both conversation scopes through the conversation lifecycle. Run a real small workflow in the isolated dev instance, compare launcher/subscriber evidence, and check that previously accepted results do not replay after restart. Leave question answers, submitted document feedback, lane inputs and human approvals on their established paths.

## Implementation and verification

Migration 0062 preserves existing accepted notepad baselines and adds optional observed-comment identities without inventing historical membership. Migration 0063 transfers workflow delivery receipts and normalizes proven terminal-wait identities to canonical boundary IDs, keeping delivery/read/wait links and immutable full evidence. Ambiguous old wait identities remain uncertain. Both migrations run transactionally and can be rerun. The schema compatibility floor advances to 27 before structural changes; older binaries cannot open the upgraded datastore.

Focused durable checks cover migration rollback, idempotence, receipt precedence, retained evidence, ownerless workflows, source/recipient deletion, accepted versus uncertain results, explicit-wait reuse, comment withdrawal, coalesced revision coverage and source context accepted independently of unrelated policy-write failures. Review found and fixed two recovery races: identity normalization overwriting existing full evidence, and an older accepted-reference retry overwriting newer notepad awareness.

- Workflow migration: `vrun-3f6c71f0-0bac-48b6-944e-850c6611413d` (11 cases).
- Shared launcher/subscriber and wait receipt integration: `vrun-c8551173-ca21-49d6-ad6b-becb735d29d6`.
- Runtime queue, acceptance, source adapter and both-scope passive integrations: `vrun-132f7515-4d78-4e86-91ee-1e25524eb07d` (four matched files).
- Source-only schema-cutover regression: `vrun-9ba2d433-f84a-4fe4-a299-bc170d097c70`. This corrected a test expecting version 27 from a fixture that needed only the existing version 26 source-constraint rebuild; production did not change.

Live verification ran real Codex turns against the worktree dev server's isolated datastore. Two small read-only workflows completed and captured the scratch README's review code. The launcher and a project-scoped subscriber received byte-equivalent frozen evidence for the shared completion boundary. Both conversation scopes received a newly added notepad comment exactly once. A second comment stayed pending across a server stop/start, then reached each next user input with one acceptance attempt. The previously accepted comment and workflow evidence retained their delivery IDs, attempt IDs, acceptance timestamps and attempt counts; neither agent reported those old events as new input.

Evidence is recorded under `.cc/temp/consolidation-*-state.json`, `consolidation-*-before-restart.json`, `consolidation-*-after-restart.json`, `consolidation-live-restart-evidence.json` and the matching SSE streams. Live backend verification was Codex; backend-neutral lifecycle and durable repository tests cover the common contract. No production server state or human approvals were changed by these fixtures.

Final typecheck (`vrun-c09eb835-9749-4e41-8fbd-625f1b2a2732`), lint (`vrun-385b22d7-f847-42b3-bd7d-692e8e11b117`), architecture seams (`vrun-473faada-653a-4bda-a97c-35d4f30a6abe`) and formatting (`vrun-c9848cc3-0db4-4e08-9f56-03f9322e12be`) passed. The source reader passed after the out-of-order acceptance fix in `vrun-3553cd70-a9a6-4600-b080-439bdc5b4595`.

The scratch session and its worktree were deleted, the project conversation archived, the test notepad deleted and the dev server stopped. The isolated project conversation retains copied inbox evidence for inspection; production data was not used for these fixtures.


The final broad changed-dependency regression run passed: `vrun-e297961f-b075-4174-a337-f00733aa31ee`. The initial broad run exposed two test expectations (schema-version fixture and explicit cleanup of a deliberately failed required receipt); both were corrected, their focused suites passed, and the broad suite was then rerun successfully. A separate full-suite scope was not run.
