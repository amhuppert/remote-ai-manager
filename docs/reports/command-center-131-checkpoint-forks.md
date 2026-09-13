# Checkpoint forks: implementation and verification

Ticket: command-center#131. Date: 2026-09-12. Alex approved the implemented UI after confirming that “Next task” becomes an editable draft and starts the agent only when sent. Implementation, verification and final UI review are complete.

## Delivered behavior

The selected saved checkpoint can create an ordinary conversation in the same session or project scope. Creation copies the exact immutable checkpoint bytes and saves the next task as an editable draft; it runs no model request. The target backend and model remain editable until first submission, including a change to another supported backend. Claude and Codex are enabled; Cursor remains disabled.

The source provider continuation is untouched. The target starts fresh, with its own durable delivery and acceptance receipt. Queued or admitted first submissions lock the backend even before prompt count advances. Cancellation before admission leaves it editable; unknown delivery blocks automatic replay. Restart, recovery, idempotent retry and source deletion preserve the target's seed obligation.

Migration `0045-add-checkpoint-forks` stores origin metadata in both conversation tables and advances schema compatibility to version 16. Older builds refuse that schema through the existing compatibility gate.

References identify a ticket, a spec task at an exact revision, or a workflow assignment with its owner and use site. These associations grant no execution ownership. Session forks share the existing session worktree and restore no files. Source checkpoints, complete tool results and images remain available through source-owned coordinates. Later target checkpoints preserve the original fork lineage.

The selected checkpoint panel hosts the form. Both normal composers show provenance and acceptance and allow supported backend changes before submission. Historical selection, focus return, preserved inputs on refusal, mobile layout and disabled backend reasons are covered. CLI operations are `conversation checkpoint fork-check` and `conversation checkpoint fork`, using a shared JSON request schema and explicit mutation scope.

## Real provider evidence

The scratch project and database are inside this worktree. The fixed continuity corpus establishes expectations independently of the generated checkpoint: an excluded column, scheduler identifier, superseded bucket, rejected library and reason, failing shard, finance blocker, alert threshold, next CLI flag, full tool result and original chart. Each source continued after its checkpoint before that historical checkpoint was forked.

| Scope | Source → target | Frozen seed bytes | Direct first-turn recall | Durable result |
| --- | --- | ---: | --- | --- |
| Session | Claude → Codex | 6,906 | 7/8 text expectations | Applied; missing identifier recovered from the archive |
| Session | Codex → Claude | 6,093 | 8/8 text expectations | Applied; second turn did not reaccept the seed |
| Project | Claude → Codex | 6,881 | 8/8 text expectations | Applied; second turn did not reaccept the seed |
| Project | Codex → Claude | 5,892 | 7/8 text expectations | Applied; missing identifier recovered from the archive |

Both omissions were the scheduler ID `RCN-4417`, absent from the generated frozen seed. Forking preserved those bytes exactly. Recovery used the production history readers to retrieve the full original entry at seq 2 and the chart at seq 11, then submitted that evidence in a normal provider turn. Both providers answered `RCN-4417` and chart value `812`; the acceptance record and target provider reference were unchanged. This proves retrieval and subsequent use of original evidence, not autonomous CLI retrieval by the model. Original image SHA-256: `a2e0297531a6b95def14138c3da1423fe966082089cc0ed30fa09b468668b695`.

An earlier session Claude → Codex sample also applied with a 5,508-byte seed and the same 7/8 direct recall. Its probe stopped on an overly strict comparison of a source activity timestamp changed by finalization. An independent durable audit confirmed exact copied seed, fresh accepted reference, preserved source corpus and retrievable tool/image evidence. That sample is retained, not counted as a perfect recall run. Three preliminary configurations failed model admission before provider execution; those attempts are not certification evidence.

The wrapper is separately bounded at 4,096 UTF-8 bytes; these matrix wrappers measured 934–936 bytes. The immutable checkpoint ceiling remains 32,768 bytes. Source generation usage is separate from target creation and delivery. Available first-turn measurements include 28,941 context tokens and $0.1671255 for session Claude, 17,541 and $0.09436 for project Codex, and 28,747 and $0.1691905 for project Claude. These include ordinary system context. No per-message seed token attribution or universal savings percentage is claimed; unavailable receipt metrics remain null.

The enabled models exercised were Claude `opus` with effort `high` and Codex `gpt-6-astra` with reasoning `high`, fast `false`. Other model variants remain subject to their configured admission; this report does not claim individual certification of every model.

## Live UI and CLI

The branch dev server reported `http://localhost:3001`; its source-built CLI and server had matching build stamps and a valid isolated token. The production database was not used.

The project form created `e819a5af-692b-4c6c-9694-9464a4b7d286` from checkpoint `55b59a42-2242-41b0-a572-b7ec34511e14`. Its normal composer initially selected Claude, then switched to Codex. The first ordinary message ran on GPT-6 Astra and correctly answered `payer_tax_id`, `ledger-exports-v2` and `--since`. The backend selector became locked, and the durable receipt retained the exact 6,881-byte seed and correlated acceptance.

The CLI created session fork `a8a60803-57ab-489f-bc22-1491041fd373` from checkpoint `8d291b31-84c5-4e1c-b417-6c9cc6a970c8`. The session composer initially selected Codex, switched to Claude/Opus 5, then ran its first message. The same three facts were correct. The receipt retained the exact 6,093-byte seed and fresh accepted reference. Both source provider references matched their pre-UI database snapshots.

CLI preflight returned eligible. Project creation returned `ab91cf66-5636-46ca-9885-a94e7217eb6c` with a ready receipt; the identical retry returned the same conversation with `reused: true`. No prompt was submitted to that CLI-only draft.

The UI project fork was checkpointed again, producing ordinal 2, operation `f1a68e81-ef00-425f-bce5-773aebda0662`, ready with a 2,298-byte seed. Its original ordinal-1 fork receipt remained applied, and the provenance action still opened the original source's ordinal-1 checkpoint and 6,881-byte handoff. Source coordinates were not used as target transcript coordinates.

Screenshots were inspected in the actual project and session hosts at desktop and 390px mobile widths. Storybook inspection covered the fork form, cross-backend composer, invalid model, creation failure, spec task, workflow assignment and unresolved provenance. The form focuses the next task, Back preserves the draft and restores the trigger, and Escape cannot dismiss an in-flight creation. Mobile failure feedback stays in the fixed footer. The changed mobile surfaces had no horizontal overflow. Representative captured images are attached to the ticket: project draft `26c1c2be-1487-4687-b996-683b03cabaab` and accepted mobile session `ada4c346-26c0-46bf-8e9c-49cea171f26c`. Structured evidence is attachment `8695a17f-a3ef-418f-827a-fc87292aed27`; retrieve it with `cctl ticket attachment get command-center#131 8695a17f-a3ef-418f-827a-fc87292aed27`.

## Validation

Behavior tests exercise real SQLite persistence, real actor lifecycle with injected provider boundaries, real client hooks over HTTP fixtures, source-scoped routes and CLI dispatch. They cover copied payload integrity, atomic creation, idempotency, cross-provider selection, queued submission, cancellation races, restart, uncertain acceptance, source evidence, exact work references, historical selection and retry.

The integration runs found checkpoint logging disclosure, Tailwind registration and shared multiline-input wiring issues; all were fixed. The shared input supplies the established keyboard and dictation controls, and keyboard submission is exercised through the actual form and mutation. Final desktop and 390px screenshots were inspected after this adapter was added. A browser Command+Enter submission sent the current task exactly once and retained it after refusal; the mobile error and retry button remained visible together without horizontal overflow. The final mobile form is ticket attachment `749a9fc2-31ff-4b37-a61d-4c6295fe5449`.

Regression coverage also caught queue-backend, schema-version, migration-order, persisted model-selection bounds and CLI help contracts that needed integration updates. Each corrected contract passed its exact-file follow-up, including offline help and failure of its optional context lookup. The final broad changed-scope regression passed after these fixes.

Two architecture scans timed out at 15 seconds while dev servers and other validation work were active. Both unchanged scans subsequently passed after stopping the dev servers. The runner rejected a timeout override because forwarded arguments are restricted to paths; no timeout or assertion was weakened.

| Check | Result | Registered run |
| --- | --- | --- |
| Broad regression, changed scope | Passed | `vrun-38e4f5c6-243e-47ae-99a1-dd6d865761e8` |
| Typecheck, full scope | Passed | `vrun-9553181d-d468-4fc5-bebd-732ebafee607` |
| Lint, changed scope | Passed | `vrun-0f3a1fcd-fa3e-47d5-ae9b-8f9572a876bd` |
| Formatting, changed scope | Passed | `vrun-28d9efc0-fe55-44d0-830a-e3fddedec881` |
| Seams, full scope | Passed | `vrun-04c442e5-be70-4fa9-a0a1-4308b4d4b91a` |
| Queue contract, exact file | Passed | `vrun-24a16a04-b7b6-47cf-b757-df8634152489` |
| Schema compatibility, exact file | Passed | `vrun-f2731c65-1d34-40e1-8ce9-3dd05b344992` |
| Shared task keyboard submission, exact file | Passed | `vrun-32e34c05-cca7-4981-a03a-b9b8ac233467` |
| Exact work-reference resolution, exact file | Passed | `vrun-fd124611-bbf4-448c-90c0-5ec42dde7850` |
| Persisted collection bounds, exact file | Passed | `vrun-c0314796-1981-4ca1-8fb2-13aa62adf975` |
| Migration registration order, exact file | Passed | `vrun-386233dc-7230-4fff-b719-27349abd10ad` |
| Fork help, offline and optional-context failure, exact file | Passed | `vrun-d6f41b02-a043-4d8b-8fd5-fa2c789bda55` |
| Shared CLI help registry, exact file | Passed | `vrun-eb89132d-dd3f-41a2-9e38-abcd178a2124` |

Scoped test runs use `--require-match`; a zero-match result is not counted as a pass. Earlier broad runs stopped on the integration failures above. The runner retains no run-associated list of passing and skipped files, so its historical Vitest cache could not establish remaining coverage; the final broad pass above completed the required scope.

## Review surfaces

- Form and variants: `Components/CheckpointFork` in Storybook.
- Normal composer states: `Components/CheckpointForkComposer` in Storybook.
- Main UI files: `src/components/conversation/CheckpointForkForm.tsx`, `CheckpointForkProvenance.tsx`, `CheckpointRelatedWorkPicker.tsx` and their colocated stories.
- Integration: session/project checkpoint controls, normal backend/model selection, draft navigation and source evidence panels use existing design-system controls and tokens.

No merge or deployment is part of this verification. Alex's final UI approval completes the delivery review.
