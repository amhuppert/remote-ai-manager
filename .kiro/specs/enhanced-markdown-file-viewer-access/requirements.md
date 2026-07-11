# Requirements Document

## Introduction

Command Center already surfaces Markdown files referenced by conversation tool activity as clickable cards and opens worktree-local files in the Markdown viewer. This feature makes those documents durable and discoverable from the session Docs panel, adds direct viewer actions to file autocomplete and prompt file-mention chips, and permits explicitly discovered Markdown documents outside the session worktree to be read safely.

The accumulated document list is session-scoped. It is shared by every conversation in the session and survives navigation, conversation changes, reloads, and process restarts.

## Requirements

### Requirement 1: Detect Markdown document activity

**Objective:** As a user, I want Markdown files used by an agent to be recognized consistently, so that conversation cards and the persistent document list represent the same activity.

#### Acceptance Criteria

1. When a visible session transcript entry contains a `Read`, `Write`, `Edit`, or `MultiEdit` tool use whose `file_path` ends in `.md` case-insensitively, the system shall produce one Markdown file reference for that canonical file path.
2. When a visible session transcript entry contains a bare or MCP-namespaced `register_document` tool use for a Markdown file, the system shall produce a registered Markdown file reference.
3. When a `run_codex` tool result identifies Markdown reference documents, the system shall continue to surface those documents through the existing registered-document flow.
4. The system shall not produce Markdown references for non-Markdown paths.
5. The system shall deduplicate repeated references to the same canonical file path within one message.
6. The conversation card shall label the detected operation as `read`, `wrote`, `edited`, or `registered`.

### Requirement 2: Persist a session-scoped Markdown document index

**Objective:** As a user, I want detected Markdown documents to accumulate for the session, so that I can return to them without finding the original message.

#### Acceptance Criteria

1. When a visible session transcript entry is durably appended, the system shall upsert every detected Markdown reference into a SQLite-backed index keyed by project path, session name, and canonical document path.
2. The index shall store the latest origin, first-seen timestamp, and last-seen timestamp for each document.
3. Repeated activity for the same canonical path shall update the latest origin and last-seen timestamp without creating a duplicate.
4. Documents detected in any conversation within the session shall appear in the same session index.
5. The index shall survive process restarts and shall be deleted automatically when its owning session is deleted.
6. A failure to update the document index shall be logged with structured session context and shall not prevent the transcript entry from being persisted or broadcast.
7. Project-level conversations shall not write to a session document index.

### Requirement 3: Browse accumulated documents in the Docs panel

**Objective:** As a user, I want the Docs panel to list all accumulated Markdown documents, so that I can select any one for viewing.

#### Acceptance Criteria

1. The system shall expose a session-scoped API that returns the union of indexed Markdown documents and registered reference documents.
2. The API shall normalize paths, deduplicate the union by canonical document path, and order documents by last-seen time descending with canonical path as the stable tie-breaker.
3. Each returned item shall include canonical path, title, latest origin, first-seen timestamp, last-seen timestamp, location (`worktree` or `external`), registration state, and the registered description when present.
4. The Docs panel shall display the returned documents as compact selectable rows with the path and operation metadata; registered descriptions shall remain visible as secondary text.
5. Clicking an available row shall open and activate that document in the existing multi-document Markdown viewer.
6. The panel shall visually distinguish external documents without presenting them as unavailable solely because they are outside the worktree.
7. The panel shall show loading, empty, and read-error states in operator-tone copy.
8. The list shall refresh after a live transcript message containing Markdown references is appended.

### Requirement 4: Open Markdown files from file autocomplete

**Objective:** As a user, I want to preview a Markdown file directly from prompt file autocomplete, so that I can inspect it without inserting or sending a mention.

#### Acceptance Criteria

1. Every `.md` file result in session file autocomplete shall display a trailing Open action; non-Markdown results shall not display the action.
2. Activating Open shall open and activate the file in the existing Markdown viewer without inserting a file mention into the prompt.
3. Activating Open shall dismiss the autocomplete popup and preserve the current prompt content.
4. Clicking the result row, or pressing Enter or Tab on the active result, shall continue to insert the file mention exactly as before.
5. The Open action shall stop pointer events from selecting the row and shall not blur or mutate the prompt editor before opening the viewer.
6. The active Markdown result shall also be openable by a documented keyboard command while focus remains in the combobox.
7. The Open control shall have an accessible name, visible focus treatment when focusable, a tooltip, and a mobile touch target consistent with the design system.

### Requirement 5: Open Markdown file-mention chips before sending

**Objective:** As a user, I want a Markdown file mention already inserted in the prompt to open the file, so that I can inspect it before submitting the message.

#### Acceptance Criteria

1. The label/body action of an inserted `.md` file-mention chip shall open and activate that file in the Markdown viewer.
2. Opening the file shall not remove, alter, or submit the chip or surrounding prompt content.
3. The chip's remove action shall remain a separate control and shall continue to delete only that chip.
4. Non-Markdown file-mention chips shall retain their current non-opening behavior.
5. The Markdown chip body action shall support pointer, Enter, and Space activation with a visible focus indicator and an accessible name.

### Requirement 6: View explicitly discovered Markdown files outside the worktree

**Objective:** As a user, I want an outside-worktree Markdown file surfaced by Command Center to open, so that valid agent-generated references are not dead ends.

#### Acceptance Criteria

1. The system shall canonicalize an absolute outside-worktree Markdown path, or a relative Markdown path that resolves outside the worktree, to an absolute document locator.
2. A conversation Markdown card for an indexed outside-worktree file shall be actionable and shall open that canonical locator in the Markdown viewer.
3. A registered outside-worktree Markdown document shall be actionable from the Docs panel.
4. The content endpoint shall read an outside-worktree path only when that exact canonical locator belongs to the session's indexed documents or registered reference documents.
5. The content endpoint shall continue to allow valid worktree-relative Markdown paths, including files opened from autocomplete, without requiring prior indexing.
6. The content endpoint shall reject non-Markdown paths, malformed paths, and unindexed outside-worktree paths without reading them.
7. Missing documents shall return a not-found response; unexpected read failures shall be logged without exposing file contents.
8. Outside-worktree documents shall render in read-only viewer mode: Markdown content, tabs, navigation, and activation remain available, while document comments and feedback controls are not loaded or shown.
9. Worktree-local documents shall retain the existing comment and feedback workflow.

### Requirement 7: Responsive, accessible, and design-system-consistent UI

**Objective:** As a user, I want the new access points to behave like native Command Center controls on desktop and mobile.

#### Acceptance Criteria

1. New UI shall use Tailwind utilities backed by existing theme tokens, `cn()`, and existing UI primitives; it shall add no global stylesheet, CSS module, raw color, or dynamically interpolated utility class.
2. Controls shall use mono typography, SVG icons with `currentColor` and 1.5 stroke, cyan focus indicators, and existing elevation/border states.
3. The Docs list and autocomplete Open actions shall remain usable at the established 1180px, 1080px, 960px, and 768px breakpoints.
4. Mobile controls shall provide 44px touch targets without hiding the Open action behind hover.
5. Listbox semantics and existing keyboard selection behavior shall remain valid; the additional Open operation shall be reachable without changing the combobox's managed-focus model.
6. Storybook shall include populated, external, empty, loading, and error document-list states; mixed autocomplete results with Markdown Open actions; and an openable Markdown file-mention chip.
7. Automated tests shall cover keyboard, pointer, propagation, focus, and accessible-name behavior for every new action.

## Non-Goals

- Sharing the accumulated index across sessions or reconciling divergent worktrees.
- Registering every discovered document as an agent reference document or adding it to agent system prompts.
- Editing outside-worktree files.
- Enabling document comments or feedback for outside-worktree files.
- Adding viewer actions to project-level conversations that do not have a session Docs surface.
- Indexing non-Markdown files or supporting MDX.
