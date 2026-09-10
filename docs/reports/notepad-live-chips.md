# Notepad live chips

Implemented directly for command-center#90 following Alex's interview decisions and authorization to use UI design autonomy without native SDD.

Ticket, conversation, and specific workflow execution references show current titles and readable statuses across the shared editor and Markdown rendering paths. Hover or focus opens a preview; clicking pins it with Open and Copy reference actions. Editor removal is a separate control. Execution chips retain their run identity and flag pending human decisions while other work continues.

Visible chips share cached results and batch lookups, polling every three seconds and refreshing on focus or reconnect. Offline chips retain their last known state with a Stale label. Deleted targets remain referenceable and display Unavailable. Refreshing never rewrites reference XML or creates a Notepad revision. Execution references can be inserted through the reference picker or copied from the execution's desktop header or mobile sheet.

Agent delivery adds timestamped state summaries after first-level Notepad expansion. Direct and embedded references are deduplicated, and each lookup has a two-second failure bound. Normal turns, next-turn queues, and in-turn delivery use current state at delivery; unavailable entities produce explicit results while the remaining prompt proceeds. Saved prompt text and Notepad content retain their canonical references.

## Verification

Real worktree-server checks used the isolated `chip-lab` project and `fx-citrine` session, with all fixture worktrees inside this session worktree. The fixture session, ticket, and Notepad were deleted afterward, the dev configuration was restored, and the verification browser and dev servers were stopped.

| Live delivery | Observed result |
| --- | --- |
| Claude: direct ticket plus the same ticket in an attached Notepad | Current title/status and exactly one entity summary: `LIVE-CHIPS-EMBER-73\|Done\|1` |
| Codex: ticket changed after a next-turn prompt was queued | Delivery used the later state: `LIVE-QUEUE-CITRINE-91\|Blocked` |
| Claude: in-turn delivery containing a valid and a missing ticket | Valid state and explicit missing result: `LIVE-IN-TURN-AMBER-42\|Done\|missing` |

[Delivery evidence](visual/notepad-live-chips/delivery-evidence.json) records conversation identities, timestamps, and persistence checks. The stored source retained its captured title and contained no injected state summary. Notepad content and revision were unchanged.

Live UI checks covered shared updates in an old transcript and Notepad edit/read views, offline retention and reconnect, execution picker insertion, exact archived-execution navigation, desktop/mobile clipboard copying, Escape focus return, and outside dismissal preserving focus on the clicked composer. No browser runtime errors were observed. Targeted axe scans of the chips and open previews passed for resolved, loading, unavailable, and stale states.

Behavior-level regression tests cover extraction and deduplication, bounded lookup failures, queued delivery, reference serialization, picker scopes, shared rendering, keyboard dismissal, and execution copying. Tests used the registered validation command with exact file paths and `--require-match`.

| Check | Evidence |
| --- | --- |
| Final chip and execution-panel tests | `vrun-a65a119c-3691-44ff-b77d-e929dce2ab56` |
| Reference/picker/parser and Notepad/delivery checks | `vrun-b84ec50a-1c62-4f30-9409-fc7dcff40091`, `vrun-91e7792e-b507-4740-87bb-f27dd7f97509` |
| Picker scope and late results | `vrun-c3a21622-1c0f-4b94-96f2-5ce1e3969dd3`, `vrun-87cf35f9-43c2-4473-8abb-d1af49910b9c` |
| Regression files affected by broad-run timeouts | `vrun-2319621e-e017-416c-8284-18023735952f` — all three files passed separately |
| Typecheck | `vrun-f9331d44-2a9b-4f9f-99d8-77e1fa105c84` |
| Lint | `vrun-da4144ab-43a6-4e70-8a85-09b513db2467` |
| Format | `vrun-6dc8c8ee-0bbb-4bc1-98cc-e79cc490e643` |
| Architecture seams | `vrun-dc6d7243-edec-40df-b54d-bea78e95a414` |

The broad changed-scope suite does **not** have a clean aggregate verdict. Its first run identified two test-fixture regressions, which were fixed and passed in `vrun-f88e7266-f9dd-4412-821d-16b87c486e81`. The subsequent broad run (`vrun-3595693c-88f9-4d20-85b2-e9e13bd8a310`) terminated with test and Vitest worker timeouts while the host used over 11 GB of swap. The three implicated files passed when rerun separately; this report does not count the interrupted broad run as a pass.

## Visual evidence

Screenshots were opened and inspected at desktop (1440×900) and mobile (390×844) sizes. The compact chips preserve status visibility as titles truncate, and the preview keeps secondary details and actions legible within the viewport.

- [Notepad beside the conversation](visual/notepad-live-chips/app-notepad.png) and [live ticket preview](visual/notepad-live-chips/app-preview.png).
- [Desktop reference composition](visual/notepad-live-chips/desktop.jpg) and [execution preview](visual/notepad-live-chips/execution-preview.jpg).
- [Mobile execution preview with a pending decision](visual/notepad-live-chips/mobile-preview.jpg).
- [Loading](visual/notepad-live-chips/loading.jpg), [unavailable](visual/notepad-live-chips/unavailable.jpg), and [stale](visual/notepad-live-chips/stale.jpg) previews.
- [Archived execution destination](visual/notepad-live-chips/execution-destination.png) and [mobile execution copying](visual/notepad-live-chips/mobile-execution.png).

The Storybook stories are under **References / Live chips**: NotepadDashboard, Loading, Unavailable, and Stale.
