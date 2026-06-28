# Implementation Plan

Tasks are ordered Foundation → Core → Integration → Validation. Order implies dependency; `(P)` marks tasks safe to run concurrently with their sibling peers. Cross-group dependencies are declared with `_Depends:_`.

- [ ] 1. Foundation: dependencies, schemas, persistence, and pure logic
- [ ] 1.1 Add the annotation library and a client-only render boundary (install/build spike)
  - Add `@recogito/text-annotator` and `@recogito/react-text-annotator` (4.2.5) plus the inherited `openseadragon` peer (pulled via `@annotorious/react`) to dependencies
  - Establish a `"use client"` boundary that dynamically imports the annotator so it never runs during SSR
  - Observable: a production build (Next/Bun) with the annotator actually imported succeeds — proving the OpenSeadragon peer resolves — and typecheck passes; a throwaway client mount of the annotator renders without an SSR error
  - _Requirements: 5.1, 6.1_

- [ ] 1.2 Define document-comment, anchor, content, and feedback schemas
  - Add Zod schemas + inferred types for a document comment (document-scoped identity: project, session, worktree-relative path), its anchor (section id, heading label, line, char offsets, exact quote, prefix, suffix, content revision), comment status (pending, sent), the document reference, and the feedback item/payload
  - Observable: schemas parse a maximal example object and reject a malformed one in a colocated unit test; types are exported via `z.infer`
  - _Requirements: 10.1, 10.2, 11.1_

- [ ] 1.3 Add the document_comments table to the schema floor
  - Add an idempotent `CREATE TABLE IF NOT EXISTS` for comments plus a lookup index on (project, session, document path) to the synchronous schema floor, with a cascade tie to the owning session
  - Observable: opening a fresh in-memory database exposes the table and index; no Umzug migration or schema-version bump is added
  - _Requirements: 10.3, 10.5_

- [ ] 1.4 Implement the comments repository with a durability contract
  - Implement a repo (find-by-document, find-by-session, scoped find-by-id-in-scope that returns a comment only when it belongs to a given project/session, upsert, delete) over the new table, wire it into the store factory, and re-export its public functions
  - Add a round-trip durability contract test asserting a maximal comment survives the SQLite round-trip, declaring derived-on-read fields (staleness) as non-persisted
  - Observable: the contract test passes against a real in-memory database, find-by-document returns the same comment set for one document path, and the scoped lookup returns null for an id that belongs to a different project/session
  - _Requirements: 10.1, 10.3, 10.4, 10.5, 11.1_

- [ ] 1.5 Implement pure anchoring logic with unit tests
  - Implement deterministic content-revision hashing, selection-anchor derivation, and exact-match re-anchoring that returns either an anchored offset range or a stale result, never relocating to a different match
  - Observable: unit tests show an unchanged document re-anchors exactly, a changed quote returns stale, and identical content yields an identical revision hash
  - _Requirements: 5.7, 11.1, 11.2, 11.3, 11.4_

- [ ] 1.6 Implement pure document helpers with unit tests
  - Implement worktree-relative path normalization (an absolute path inside the worktree normalizes to relative; an absolute path outside the worktree resolves to an explicit "unavailable" outcome) with markdown-only and traversal guards, markdown-file-reference extraction from message blocks (Write/Edit/MultiEdit on .md; register-document on .md detected by normalizing the full MCP tool name — strip any `mcp__<server>__` prefix, match the bare `register_document`, accepting the bare form — reading input.file_path; and `run_codex` reference documents read from its paired tool_result content JSON `referenceDocuments[].filePath` for .md entries, correlated by tool_use_id; de-duped by path within a message), and feedback-prompt formatting that embeds quote, path, heading, and line per item
  - Observable: unit tests cover absolute-inside→relative, absolute-outside→unavailable, spec paths, rejection of non-markdown/traversal paths, correct detection (MultiEdit, MCP-suffixed `mcp__cc-session-tools__register_document`, and `run_codex` paired-result reference documents; non-detection of non-md/other tools) with de-duplication, and feedback text that contains the path, heading, line, and quote for each item
  - _Requirements: 4.1, 4.2, 8.1, 10.1, 10.4_

- [ ] 2. Core: server endpoints
- [ ] 2.1 (P) Build the document-comments CRUD endpoints
  - Add list (by document path), create, update (note and/or status), and delete handlers over the repo, validating bodies and the document path at the boundary; create persists with the route's project/session (not body-supplied scope); update and delete resolve project→session then use the scoped lookup so an id outside the route's project/session returns 404 (never mutates/deletes out-of-scope)
  - Observable: each endpoint round-trips through the repo and returns the persisted comment (or list); an invalid path or missing id returns a 4xx; a PATCH/DELETE with an id belonging to a different project/session returns 404 and leaves that comment unchanged
  - _Requirements: 5.3, 6.4, 6.6, 7.5, 8.3, 10.1, 10.5_
  - _Boundary: document-comments route handlers_
  - _Depends: 1.4_

- [ ] 2.2 (P) Build the markdown content-by-path endpoint
  - Add a read endpoint that returns the content of any markdown file addressed by a worktree-relative (or normalized absolute-inside-worktree) path, confined to the session worktree and markdown-only, with a new `{ content, docPath }` response schema (distinct from the existing shared `{ content }` schema — define it explicitly)
  - Observable: a valid `.md` path returns `{ content, docPath }`; a missing file or an absolute path outside the worktree returns 404; a non-markdown or traversal path returns 400
  - _Requirements: 1.6, 4.3, 4.4_
  - _Boundary: documents content route handler_
  - _Depends: 1.6_

- [ ] 3. Core: client data layer
- [ ] 3.1 (P) Add comment queries and mutations
  - Add a query for a document's comments and create/update/delete mutations with optimistic updates and cache invalidation keyed by document path
  - Observable: creating, editing, and deleting a comment updates the cached list without a manual refetch; status changes are reflected
  - _Requirements: 5.3, 6.4, 6.6, 7.5, 10.3, 10.5_
  - _Boundary: document-comments client_
  - _Depends: 2.1_

- [ ] 3.2 (P) Add the document content query
  - Add a query that loads markdown content by worktree-relative path, with loading and error states
  - Observable: the query returns content for a valid path and surfaces a distinct error state for an unreadable path
  - _Requirements: 1.6, 4.3, 4.4_
  - _Boundary: documents client_
  - _Depends: 2.2_

- [ ] 4. Core: comment-enabled renderer and selection
- [ ] 4.1 (P) Apply prototype styling, decorative markers, and source-position stamping
  - Restyle the shared markdown viewer (background, text color, type scale, spacing, headings, blockquote, code blocks, cyan selection tint) using design-system tokens, and render unordered list items with a cyan chevron marker instead of default discs; preserve the existing Mermaid code-block handling (only non-Mermaid code styling changes); leave conversation-message markdown untouched
  - Add a rehype step that stamps each rendered block with its source line and nearest-heading section id, plus a resolver that returns a selection's section id, heading label, and line from those stamped attributes
  - Observable: the viewer renders the prototype's typography/spacing and cyan chevron bullets in a Storybook story; a rendered block exposes its source line and section, and the resolver returns the correct heading label and line for a selection within it; message-markdown rendering is visually unchanged
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 5.7_
  - _Boundary: markdown-components, MarkdownViewer_

- [ ] 4.2 Integrate the annotation overlay into the renderer
  - Mount the annotator over the rendered markdown, paint highlights styled by comment status (pending vs sent), render left-gutter comment markers for anchored comments, and re-sync on document/content change
  - Observable: with fixture comment props, a passage with an anchored comment shows a highlight and a gutter marker; pending and sent comments are visually distinct; switching documents re-syncs highlights
  - _Requirements: 2.1, 2.2, 2.3, 6.1, 6.2_
  - _Boundary: AnnotatedMarkdown_
  - _Depends: 1.1, 4.1_

- [ ] 4.3 Build the selection-to-comment flow
  - Surface a comment affordance on a valid single-block in-document text selection, open a popover showing the selected-passage preview and a note input with queue and immediate-send actions disabled while the note is empty, derive the single-block anchor on confirm, and dismiss cleanly on cancel/outside-click; a selection spanning more than one rendered block is rejected (no affordance shown)
  - Observable: selecting text within one block shows the affordance and confirming with the queue action creates a pending comment carrying the exact quote and its heading/line reference; a selection spanning two blocks shows no affordance; an empty note keeps both actions disabled
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_
  - _Boundary: use-text-selection-comment, CommentPopover_
  - _Depends: 4.1, 4.2, 1.5, 3.1_

- [ ] 5. Core: comment state and management UI
- [ ] 5.1 Load, re-anchor, and group comments for a document
  - Load a document's comments, run exact-match re-anchoring against the current content, expose anchored vs stale state, group anchored comments by block for highlighting, and provide the active-document comment count
  - Observable: opening a document highlights matching comments and marks non-matching ones stale; the header comment-count reflects the active document's comments
  - _Requirements: 1.4, 6.1, 11.2, 11.3, 11.4_
  - _Boundary: use-document-comments_
  - _Depends: 3.1, 1.5_

- [ ] 5.2 (P) Build the comment card
  - Build a card to view a comment (status, location, quote, note) and edit, remove, or send-now a pending comment; changing the note of an already-sent comment returns it to pending; the card works for stale comments
  - Observable: editing and saving updates the note; editing a sent comment's text flips it back to pending; remove deletes it; a stale comment can still be viewed, edited, removed, and sent
  - _Requirements: 6.3, 6.4, 6.5, 6.6, 6.7, 11.5_
  - _Boundary: CommentCard_
  - _Depends: 5.1_

- [ ] 5.3 (P) Build the pending-comments tray
  - Build a tray that appears only when pending comments exist, shows the pending count, lists each pending comment with its location/quote/note, jumps to a passage, clears only pending comments, and exposes a bulk-send action
  - Observable: the tray shows the correct pending count and list; jumping scrolls the passage into view; clear removes pending comments but leaves sent ones; the tray is hidden when none are pending
  - _Requirements: 7.1, 7.2, 7.3, 7.5, 7.6_
  - _Boundary: PendingCommentsTray_
  - _Depends: 5.1_

- [ ] 6. Core: conversation target and feedback sending
- [ ] 6.1 (P) Build the conversation target picker
  - Build a picker listing all conversations across projects, defaulting to the most-recently-viewed conversation, allowing search/filter and selection of a different target, and retaining the chosen target as a full target identity (project, project path, session, conversation, backend, status) rather than a bare conversation id
  - Observable: opening the picker pre-selects the most-recently-viewed conversation; the user can search and choose another from any project/session; the retained selection carries the full routing identity for subsequent sends
  - _Requirements: 9.1, 9.2, 9.3, 9.4_
  - _Boundary: ConversationTargetPicker, use-conversation-target_

- [ ] 6.2 Build the feedback-send orchestration
  - Build a hook that assembles the feedback payload from selected comments and POSTs it directly to the chosen target's own project/session/conversation prompt/queue endpoints (target-aware low-level calls — NOT the mounted-view `useSendPrompt`, so it never mutates the current view's optimistic store or depends on its `sending` gate), queuing when the target conversation is running and otherwise sending, with a race fallback that re-routes an immediate send to the queue endpoint if the target turned running between picker render and submit; when no target is available it starts a new conversation in the document's own session and uses it as the target; it marks comments sent on success and keeps them pending while surfacing the error on failure
  - Observable: sending delivers the payload to the chosen conversation (including one in a different session/project than the document) without altering the mounted view's optimistic state, and flips the comments to sent; a running target is queued (and an immediate send that races a now-running target falls back to queue); with no target a new conversation is created in the document's session; a failed send leaves comments pending with an error surfaced
  - _Requirements: 7.4, 8.1, 8.3, 8.4, 8.5, 9.4, 9.5_
  - _Boundary: use-send-document-feedback_
  - _Depends: 6.1, 1.6, 3.1_

- [ ] 7. Integration: feedback in the transcript
- [ ] 7.1 Thread the feedback payload through the immediate-send conversation actor path
  - Add a feedback content block to the message content model and an optional feedback payload to the prompt request schema and route handlers; thread it into the conversation actor's submit-prompt event and active-turn input; in the user-turn block construction, append a feedback content block (and derive the agent-facing prompt text from the payload when no explicit text is supplied), leaving existing text/image turns unchanged
  - Observable: an immediate prompt carrying the feedback payload produces a user turn whose transcript content includes a feedback block and whose agent text contains each item's quote, path, heading, and line; a prompt without the payload produces the same text/image turn as before
  - _Requirements: 8.1, 8.2_
  - _Boundary: message-content-schemas, prompt schemas and route handlers, conversation actor event + turn input + user-turn block construction_
  - _Depends: 1.2, 1.6_

- [ ] 7.2 Carry the feedback payload through the durable message queue and drain
  - Add the optional feedback payload to the queue enqueue schema and persist a feedback content block in the durable pending-queue entry; make the queued-batch-to-submit conversion stop dropping that block so the drained submit re-emits it, and make live delivery + next-turn drain record a feedback block and derive agent text; extend the conversations round-trip durability contract to cover the queued feedback block
  - Observable: a queued feedback item survives the persistence round-trip and, on delivery (live or drained next turn), produces a user turn containing a feedback block plus derived text; the durability/drain tests fail if the queued feedback block is dropped on round-trip or during the submit conversion
  - _Requirements: 8.2, 8.4_
  - _Boundary: prompt queue, message-queue-schemas, conversation-row-codec, conversation manager drain conversion_
  - _Depends: 7.1_

- [ ] 7.3 Render the feedback card in the transcript
  - Render the feedback content block as a document-feedback card listing each item's file path, heading and line, quoted passage, and note
  - Observable: a transcript containing a feedback block renders the card with every item's path, location, quote, and note
  - _Requirements: 8.2_
  - _Boundary: DocumentFeedbackCard, MessageContent_
  - _Depends: 7.1_

- [ ] 8. Integration: viewer assembly and wiring
- [ ] 8.1 Assemble the multi-document viewer shell and its state
  - Assemble the viewer (header with file icon, title, comment-count badge, and directory path; open-document tabs; annotated body; pending tray) and the focused store state for open documents, the active document, tray expansion, and the selected target; flash and scroll on activation; show an empty/error state when content cannot load
  - Observable: opening a second document adds a tab and activates it; switching tabs preserves each document's scroll and comment state; the header badge and directory path reflect the active document; activation flashes the body; an unreadable document shows an error state
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 7.1, 7.6_
  - _Boundary: DocumentViewer, DocumentTabs, session-detail.store_
  - _Depends: 4.2, 5.1, 5.3, 3.2_

- [ ] 8.2 (P) Re-implement the registry Docs surface on the viewer
  - Re-implement the Docs right-pane surface to enumerate registered documents and open them by normalized worktree-relative path in the new viewer; a registered doc whose absolute path is inside the worktree normalizes to relative, and one outside the worktree shows the unavailable state instead of opening
  - Observable: selecting a registered document opens it in the multi-document viewer with commenting available; a registered doc outside the worktree shows the unavailable state
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 10.4_
  - _Boundary: DocsPanel_
  - _Depends: 8.1_

- [ ] 8.3 (P) Route the Kiro specs surface through the annotated renderer
  - Render the selected spec/steering file through the annotated renderer so specs get identical selection, highlighting, and commenting, opened by worktree-relative path
  - Observable: selecting a spec file shows the same commenting capability, and a comment made on a spec persists and reappears on reopen
  - _Requirements: 2.1, 2.2, 2.3_
  - _Boundary: SpecBrowser_
  - _Depends: 8.1, 4.2_

- [ ] 8.4 (P) Render markdown file cards in conversation messages
  - Render a clickable file card for markdown files surfaced by Write/Edit/MultiEdit operations and registered documents, opening the referenced file by path in the viewer and indicating when a file is unavailable (incl. outside-worktree), without altering the message's other content; cards remain visible when consecutive tool-use blocks are collapsed into a grouped rendering
  - Observable: a message that wrote/edited (or MultiEdited) a `.md` file (or registered a doc) shows a card even when its tool-uses are grouped/collapsed; clicking it opens that file as the active document; an unreadable or out-of-worktree file is indicated rather than opening empty
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - _Boundary: MarkdownFileCard, MessageContent_
  - _Depends: 8.1, 1.6_

- [ ] 8.5 Wire the create, immediate, bulk, and send-now flows end to end
  - Connect the popover create path, the immediate-send action, the tray bulk-send, and the card send-now to the send orchestration and target picker, marking comments sent on success
  - Observable: immediate-send creates and sends a single comment in one step; tray bulk-send delivers all pending comments as one feedback submission and flips them to sent; card send-now sends a single pending comment; sending to a running target is queued and still renders the feedback card
  - _Requirements: 5.3, 5.4, 6.7, 7.4, 8.3_
  - _Boundary: DocumentViewer, CommentPopover, CommentCard, PendingCommentsTray_
  - _Depends: 4.3, 5.2, 5.3, 6.2, 7.1, 7.2_

- [ ] 9. Validation
- [ ] 9.1 Add integration tests for the comment and feedback lifecycle
  - Test, over a real-store fixture, create/edit/delete, the sent-to-pending transition on editing a sent comment, bulk-send marking all selected comments sent, clear removing only pending comments, the immediate-send path recording a feedback block plus derived agent text (and unchanged behavior without the payload), the queue path persisting the feedback payload and recording a feedback block on drain, and ownership scoping (a PATCH/DELETE with an id from a different project/session returns 404 and leaves the comment unchanged)
  - Observable: the suite passes and fails if a comment field is dropped on round-trip, if a sent comment does not revert on edit, if the feedback block/derived text is missing on immediate send, if a queued feedback payload is dropped or fails to emit a feedback block on delivery, or if an out-of-scope id can mutate/delete a comment
  - _Requirements: 6.5, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4, 10.1, 10.3, 10.5_
  - _Depends: 7.1, 7.2, 8.5_

- [ ] 9.2 (P) Live end-to-end verification of the document review flow
  - Drive the running app to select a passage, queue and bulk-send comments to a chosen conversation, confirm the feedback card appears in that conversation and comments flip to sent, open a document from a transcript file card, verify pending vs sent highlights, and confirm a comment becomes stale (yet actionable) after its document changes
  - Observable: the live run confirms feedback reaches the chosen conversation, the file card opens the viewer, highlights distinguish pending/sent, and a changed document marks the affected comment stale while it remains editable/sendable
  - _Requirements: 4.3, 5.1, 5.3, 5.4, 6.7, 7.4, 8.2, 9.1, 9.2, 9.5, 11.3, 11.5_
  - _Depends: 8.5_
