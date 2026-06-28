# Requirements Document

## Project Description (Input)

Re-implement Command Center's markdown viewer to match the Claude Design Handoff Bundle at `memory-bank/markdown-document-selection-and-feedback/` (primary mock: `project/Markdown Feedback.dc.html`), and expand it with a document selection-and-commenting capability and an in-conversation markdown file card. The objective and all open design decisions were clarified up front; the locked decisions below are binding inputs.

### Scope overview

1. **Re-implement / restyle the markdown viewer** to match the prototype, enhancing the existing right-pane **Docs** tab (`src/features/session/conversation/DocsPanel.tsx`) into a multi-document, tabbed viewer. Both markdown-viewing surfaces — reference-registry docs (`DocsPanel`) and Kiro specs (`SpecBrowser`, `src/features/session/conversation/SpecBrowser.tsx`) — render through the shared `MarkdownViewer` (`src/components/MarkdownViewer.tsx`, react-markdown + remark-gfm), which is the single injection point for the new styling and the comment layer.

2. **Markdown file card in conversations** — when a markdown file appears in a conversation message, render a special clickable card (file icon + filename + open affordance) in the transcript. Clicking opens that file in the markdown viewer (reuse the existing `openDocById` / right-pane Docs deep-link wiring in `src/stores/session-detail.store.ts`). A "markdown file appears in a message" is triggered by **(a) Write/Edit tool operations targeting `.md` files** in the transcript, and **(b) agent-registered documents** (`register_document` MCP tool / the `reference_documents` registry). Card rendering hooks into `MessageContent.tsx` / the message content block model (`src/lib/conversations/message-content-schemas.ts`), following the existing `image_ref` externalized-block pattern.

3. **Document selections and comments** — the user selects a passage of a rendered markdown document and attaches a comment. Comments can be **sent immediately** to an agent or **queued and sent in bulk** (a pending-comments tray at the bottom of the viewer, matching the prototype). What is sent to the agent includes the **selected quote text plus a precise reference to where it came from** (file path + heading/section label + line number + the quote).

### Locked decisions (binding)

- **Annotation engine:** Adopt **`@recogito/text-annotator`** (v4.x, BSD-3, React 19 supported via `@recogito/react-text-annotator`) as the selection→highlight engine, rendered as an **overlay** over the react-markdown render tree (no `<mark>` injection into React's DOM). The comment UI, the heading/section/line references, persistence, and re-anchoring are built on top of it. It is client-only (guard against SSR). Heading and line references are derived from the remark AST position data + the rendered tree, since recogito supplies only quote/offset selectors.

- **Comment scope & identity:** Comments are **document-scoped, NOT conversation-scoped.** They are keyed on a **normalized worktree-relative file path** plus project/session — the common identity across both reference docs (which carry a `filePath`, possibly absolute → normalize) and Kiro spec files (addressed by `.kiro/<category>/.../<file>.md` paths). Comments follow the document regardless of which surface (Docs tab or Specs tab) it was opened from.

- **Persistence:** Comments persist durably in **`command-center.db`** (a new state-store repo + table, plus the appropriate schema-floor/migration work per the project's database-migration rules), stored **separately from the markdown files** (never embedded in the `.md`). Each comment stores a full anchor: **document revision indicator + section id + char offsets + exact quote + prefix/suffix context**, so the anchoring data exists for current and future re-anchoring needs.

- **Re-anchoring behavior (v1):** **Exact-match only.** On load, a comment re-anchors only when its stored quote still matches exactly at/near the stored offsets; otherwise the comment is preserved and marked **"stale / needs review"** (the passage is shown from the stored quote but not highlighted in-document). No fuzzy prefix/suffix search in v1 (the prefix/suffix data is still stored for the future).

- **Send-to-agent representation:** Introduce a **structured feedback message** type: rendered as the prototype's "Document feedback" card in the transcript (path · § heading · L&lt;line&gt; · quoted passage · the user's note), and serialized to the agent as **text** that includes the quote + path + heading + line. Delivered through the existing prompt/queue pipeline (`src/hooks/use-send-prompt.ts`, `src/lib/prompt/`, conversation message queue for bulk/queued sends). Once a comment is successfully sent, it is **removed from the document** (its highlight, gutter marker, and pending-tray entry); the feedback itself persists only as the transcript's "Document feedback" card. There is no retained in-document "sent" state — every comment shown in the document is unsent.

- **Conversation target picker:** Because comments are not bound to a conversation, sending requires choosing a target conversation. Provide a picker that **lists all conversations cross-project** (mirroring the prompt-input conversation autocomplete: `useAllConversationsQuery`, the `ui/Autocomplete` primitive, the existing autocomplete filter/scoring), **defaults to the most-recently-viewed conversation** (reuse the `cc-open-tabs` LRU recency signal, falling back to most-recent-by-activity), and **allows selecting a different one**. If a session has no conversation yet, sending starts a new one.

- **Viewer appearance (match the prototype where it differs from today):** Apply the prototype's styling to the **document viewer surfaces only** (the shared `MarkdownViewer` used by Docs + Specs); **leave conversation-message markdown** (`MarkdownContent`) **unchanged.** Use CC design-system tokens (the synced `ed3a3cc5` DS) via Tailwind utilities per the `cc-design-system` skill and `docs/tailwind-conventions.md`. Specifics from the prototype:
  - **Colors/surfaces:** panel on `--bg-surface`; body text `--text-primary`; `--cyan` accent; code blocks on `--bg-base` with a `--border-subtle` border; blockquote on `--bg-raised`; text-selection highlight is a cyan tint (`rgba(0,229,255,0.30)`).
  - **Fonts:** body = `--font-body` (Manrope); code = `--font-mono` (Geist Mono); headings use the **body** font, bold (not the display font).
  - **Type scale & rhythm:** body `0.9rem`; `h1` `1.42rem/700` with bottom border; `h2` `1.16rem/700` with bottom border; `h3` `1.0rem/700`; `~1.5em` top margins between sections; paragraphs `line-height 1.7` with `1em` bottom margin; blockquote 3px cyan left border, `--text-secondary`, `line-height 1.6`; code `0.78rem`, `line-height 1.6` (no syntax highlighting — matches the prototype and keeps the lighter `MarkdownViewer`).
  - **Spacing:** doc body padding `20px 26px 28px 50px` (the wide left gutter holds the comment pins/markers).
  - **Decorative bullets:** list items are **not** default disc markers — each is a flex row prefixed with a bold **cyan `›` chevron** (gap `~9px`, `line-height 1.7`); requires a custom `li` renderer in `MarkdownViewer`.

## Introduction

This feature re-implements Command Center's in-app markdown viewer to match the Claude Design handoff prototype and adds a document review loop: users read agent-produced markdown (reference-registry documents and Kiro specs), select passages, attach comments, and route those comments to an agent — either immediately or queued and sent in bulk — so the agent can fold the feedback back into the documents. Comments live with the document (not a conversation), persist durably, and carry a precise source reference (file, section, line, exact quote) both for the user's review and for what is sent to the agent. The viewer's appearance is updated to match the prototype, and markdown files surfaced in a conversation become clickable cards that open the viewer.

The requirements below describe user- and operator-observable behavior. Specific technology choices named in the input (annotation library, persistence engine, message pipeline, design tokens) are binding inputs for the design phase and are intentionally kept out of the acceptance criteria, which are written to be verifiable without naming those technologies.

## Boundary Context

- **In scope:**
  - A multi-document, tabbed markdown viewer that replaces/enhances the current right-pane Docs viewing experience, applied consistently to both reference-registry documents and Kiro spec documents.
  - Prototype-matching visual styling for the viewer's rendered markdown, including decorative list markers and selection highlight.
  - Clickable markdown file cards in conversation transcripts, triggered by Write/Edit operations on `.md` files and by agent-registered documents, that open the referenced file in the viewer.
  - Text selection, comment creation, in-document highlighting and gutter markers, comment view/edit/remove, a pending-comments tray, and immediate or bulk sending.
  - Document-scoped, durably persisted comments that carry a precise source reference and a stored anchor.
  - A conversation target picker for sending, defaulting to the most-recently-viewed conversation and listing all conversations.
- **Out of scope:**
  - Restyling markdown rendered inside conversation messages (that renderer is unchanged).
  - Editing markdown document content within the viewer (the viewer is read-only with respect to document text).
  - Fuzzy/semantic re-anchoring of comments when a document changes (v1 is exact-match only; mismatched comments are marked stale).
  - Commenting on non-markdown files or on arbitrary message text.
  - Syntax highlighting inside the viewer's code blocks (the viewer renders code as plain monospace, matching the prototype).
  - Multi-user / real-time collaborative annotation concerns beyond single-user use.
- **Adjacent expectations:**
  - Relies on the existing reference-document registry and Kiro spec serving to enumerate and read document content from disk; this feature does not change how documents are produced or stored on disk.
  - Relies on the existing prompt-send and message-queue pipeline to deliver feedback to a conversation/agent; this feature does not define agent execution behavior, only the content and routing of the feedback it submits.
  - Relies on the existing conversation list and recently-viewed-conversation signals to populate and default the target picker.

## Requirements

### Requirement 1: Multi-document markdown viewer shell

**Objective:** As a Command Center user reviewing agent output, I want a document viewer that can hold several open documents with clear identity and navigation, so that I can move between related documents without losing my place.

#### Acceptance Criteria
1. When the user opens a markdown document, the Markdown Viewer shall render the document's content and display the document's title and its source directory/path in the viewer header.
2. When the user opens a document while one or more documents are already open, the Markdown Viewer shall present the open documents as switchable tabs and make the newly opened document active.
3. When the user selects a different open-document tab, the Markdown Viewer shall display that document's content and preserve each document's own scroll position and comment state.
4. While the active document has one or more comments, the Markdown Viewer shall display a comment-count badge for that document in the header.
5. When a document becomes active as a result of opening it or switching to it, the Markdown Viewer shall briefly indicate the change with a visual flash on the document body and scroll the document to a defined position.
6. While a document's content cannot be loaded or read, the Markdown Viewer shall display a clear empty/error state for that document instead of blank content.

### Requirement 2: Commenting available across all markdown viewing surfaces

**Objective:** As a user, I want the same selection-and-comment capability wherever I view markdown, so that I can give feedback on reference documents and Kiro specs identically.

#### Acceptance Criteria
1. The Markdown Viewer shall provide identical selection, commenting, highlighting, and sending behavior for reference-registry documents and for Kiro spec documents.
2. While the same document is viewed from more than one surface, the Markdown Viewer shall display the same set of comments for that document regardless of the surface it was opened from.
3. Where a viewing surface renders markdown through the document viewer, the system shall make the selection-and-comment capability available on that surface.

### Requirement 3: Viewer appearance matches the prototype

**Objective:** As a user, I want the document viewer to look like the approved design, so that documents are legible and visually consistent with Command Center's design system.

#### Acceptance Criteria
1. The Markdown Viewer shall render document background, text color, text sizes, spacing, and fonts to match the design prototype, using Command Center design-system tokens.
2. The Markdown Viewer shall render unordered list items with a decorative cyan chevron marker in place of default bullet discs.
3. The Markdown Viewer shall render headings, paragraphs, blockquotes, and code blocks with the prototype's typography, section spacing, and surface/border treatment.
4. When the user selects text within a document, the Markdown Viewer shall display the selection with a cyan-tinted highlight.
5. The system shall leave markdown rendered inside conversation messages visually unchanged by this feature.

### Requirement 4: Markdown file card in conversations

**Objective:** As a user, I want markdown files that appear in a conversation to be presented as clickable cards, so that I can jump straight from the conversation into the document viewer.

#### Acceptance Criteria
1. When a conversation message contains a Write or Edit operation targeting a Markdown (`.md`) file, Command Center shall render a clickable file card identifying that file within the message.
2. Where the agent has registered a document, Command Center shall render a clickable file card for that document in the associated message.
3. When the user clicks a markdown file card, Command Center shall open the referenced file in the Markdown Viewer and make it the active document.
4. If a markdown file card refers to a file that can no longer be read, Command Center shall indicate that the file is unavailable rather than opening an empty viewer.
5. The system shall render the file card without altering the message's other content.

### Requirement 5: Text selection and comment creation

**Objective:** As a user, I want to select a passage and attach a note, choosing whether to send it now or save it for later, so that I can give targeted feedback efficiently.

#### Acceptance Criteria
1. When the user selects a contiguous passage of text within a rendered document, the Markdown Viewer shall display a comment affordance near the selection.
2. When the user activates the comment affordance, the Markdown Viewer shall present a comment editor showing a preview of the selected passage and an input for the note.
3. When the user confirms a comment with the queue action, the system shall save it as a pending (unsent) comment associated with the selected passage and shall not send it.
4. When the user confirms a comment with the immediate-send action, the system shall save the comment and send it to the selected target conversation in a single step.
5. If the note input is empty, the system shall keep the queue and send actions disabled.
6. When the user dismisses the selection, presses cancel, or clicks outside the editor, the Markdown Viewer shall hide the comment affordance and editor without creating a comment.
7. The system shall record, for each created comment, the exact selected quote and its source location (file path, section/heading label, and line number).

### Requirement 6: In-document highlights, markers, and comment card

**Objective:** As a user, I want commented passages to be visibly marked and individually manageable, so that I can see where my feedback is and revise it.

#### Acceptance Criteria
1. While a comment exists for a passage in the active document and its anchor still matches, the Markdown Viewer shall highlight that passage and display a comment marker in the document's left gutter.
2. When a comment is successfully sent, the Markdown Viewer shall remove its in-document highlight and gutter marker, so that only unsent comments remain marked.
3. When the user clicks a highlighted passage or its gutter marker, the Markdown Viewer shall open a comment card showing the comment's source location, the quoted passage, and the note.
4. When the user edits a comment's note from the comment card and saves a non-empty value, the system shall update the comment's note.
5. The system shall keep every comment shown in the document in the pending (unsent) state; once sent, a comment is removed, so there is no sent comment to edit in place or revert.
6. When the user removes a comment, the system shall delete the comment and remove its highlight and gutter marker.
7. When the user chooses "send now" on a pending comment from the comment card, the system shall send that single comment to the selected target conversation and remove it after delivery.

### Requirement 7: Pending-comments tray and bulk operations

**Objective:** As a user, I want to collect multiple comments and act on them together, so that I can review a whole document before sending feedback in one batch.

#### Acceptance Criteria
1. While one or more pending comments exist for the viewer, the Markdown Viewer shall display a pending-comments tray showing the pending count.
2. When the user expands the tray, the Markdown Viewer shall list each pending comment with its source location, quoted passage, and note.
3. When the user activates a pending comment's jump action from the tray, the Markdown Viewer shall make that comment's document active, scroll the passage into view, and focus the comment.
4. When the user chooses to send all pending comments, the system shall deliver all pending comments to the selected target conversation as a single feedback submission and remove them after delivery.
5. When the user clears pending comments, the system shall remove all pending (unsent) comments.
6. While no pending comments exist, the Markdown Viewer shall not display the pending-comments tray.

### Requirement 8: Sending comments to an agent

**Objective:** As a user, I want my comments delivered to an agent with full context and recorded in the conversation, so that the agent can act on them and I can see what I sent.

#### Acceptance Criteria
1. When the user sends one or more comments, the system shall include, for each comment, the exact quoted text and a reference to its source location (file path, section/heading label, and line number) together with the user's note.
2. When comments are delivered to a conversation, the conversation transcript shall display a document-feedback entry listing each included comment's source file path, section/heading and line, quoted passage, and note.
3. When a comment is successfully sent, the system shall remove that comment so it no longer appears in the document or the pending tray; the delivered feedback persists only as the conversation's document-feedback entry.
4. While a conversation is currently running and the target supports it, the system shall queue the comments for delivery rather than failing the send.
5. If sending fails, the system shall keep the affected comments in their pre-send (pending) state and surface the failure to the user.

### Requirement 9: Conversation target picker

**Objective:** As a user, I want to choose which conversation receives my comments, defaulting to the one I most recently viewed, so that feedback reaches the right agent with minimal effort.

#### Acceptance Criteria
1. When the user initiates sending comments, the system shall present a conversation target control listing available conversations across all projects.
2. When the target control is first presented, the system shall default the selected target to the most-recently-viewed conversation.
3. While the target control is open, the system shall allow the user to search/filter the listed conversations and select a different conversation as the target.
4. When the user selects a target conversation, the system shall use that conversation as the destination for subsequent immediate sends, "send now" actions, and bulk sends until the user changes it.
5. If no conversation is available as a target, the system shall start a new conversation to receive the feedback.

### Requirement 10: Document-scoped, durable comment persistence

**Objective:** As a user, I want my comments to belong to the document and survive reloads and restarts, so that my review state is not lost and is independent of any conversation.

#### Acceptance Criteria
1. The system shall associate each comment with its document by file location (and owning project/session) rather than with any conversation.
2. The system shall store comments separately from the markdown files and shall never modify the markdown file content to record a comment.
3. When the user reopens a document after a page reload or a server restart, the system shall display the comments previously created for that document (all such comments are pending; sent comments are not retained).
4. While a document is opened from different viewing surfaces that resolve to the same file location, the system shall present one shared set of comments for that document.
5. When a comment is created, updated, removed, or sent, the system shall persist that change durably.

### Requirement 11: Comment anchoring and exact-match re-anchoring

**Objective:** As a user, I want comments to stay attached to the right passage when possible and to be clearly flagged when the document has changed, so that I can trust the highlights and notice stale feedback.

#### Acceptance Criteria
1. When a comment is created, the system shall record an anchor for the passage that includes the document revision indicator, the section identifier, the character offsets, the exact quote, and surrounding prefix/suffix context.
2. When a document is loaded, the system shall re-anchor each comment whose stored quote still matches exactly at or near its stored offsets and shall highlight the matched passage.
3. If a comment's stored quote no longer matches the current document, the system shall preserve the comment, mark it as stale/needs review, and display its stored quoted passage without an in-document highlight.
4. The system shall not silently relocate a comment to a different passage when its stored quote does not match exactly.
5. While a comment is stale, the system shall allow the user to view, edit, remove, and send that comment.
