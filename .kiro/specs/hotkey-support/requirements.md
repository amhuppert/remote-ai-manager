# Requirements Document

## Introduction

Command Center (CC) needs a coherent keyboard command system for its common
navigation, creation, conversation, review, and view-management workflows. The
system must preserve ordinary browser and text-editing behavior, remain usable
while the conversation prompt is focused, expose contextual availability, and
make every command discoverable from one catalog.

The authoritative command catalog is `src/lib/shared/hotkeys.ts`. This
specification describes the behavior and design constraints that catalog and
its dispatcher must satisfy.

## Requirements

### Requirement 1: Central Command Catalog

**Objective:** As a developer, I want command metadata defined in one place, so
runtime dispatch, the command launcher, keyboard help, keycap hints, and tests
cannot drift apart.

#### Acceptance Criteria

1. CC shall define each app command in `HOTKEY_REGISTRY` with a unique ID,
   label, description, category, and either a key binding or `null`.
2. CC shall derive runtime sequence matching and discovery UI content from the
   same registry.
3. CC shall permit commands without direct keys so rarely used actions remain
   available from the command launcher without consuming global key space.
4. CC shall render key combinations with platform-appropriate modifier labels.
5. CC shall expose prompt-native editing shortcuts in the complete shortcut
   reference without registering them as app commands.

### Requirement 2: Central Context-Aware Dispatch

**Objective:** As a user, I want the same keys to perform only the action valid
for my current context, so shortcuts remain predictable across CC views.

#### Acceptance Criteria

1. CC shall process app shortcuts through one document-level capture-phase
   dispatcher owned by a root provider.
2. Feature components shall register command callbacks and availability
   predicates by catalog ID rather than attaching independent global keyboard
   engines.
3. CC shall support direct shortcuts and multi-stroke sequences.
4. The `G`, `C`, and `V` leaders shall wait up to 1 second for their next
   stroke during ordinary, non-editable use.
5. When a leader continuation does not match an available command, CC shall
   cancel the pending sequence without consuming the unmatched key.
6. CC shall allow a key sequence to have different commands in mutually
   exclusive contexts, such as `V` then `S` for session specs or project
   sessions.
7. If more than one registered callback for the same command is available in a
   context, CC shall fail closed, log the ambiguity, and invoke neither.
8. While a dialog, popover, menu, or equivalent overlay is open, CC shall
   suppress background app shortcuts and let the overlay own keyboard input;
   only commands explicitly registered by the focused overlay surface may
   remain active.
9. CC shall ignore repeated, composing, IME-process, and AltGraph key events
   that cannot be matched safely.

### Requirement 3: Prompt-Focused One-Shot Activation

**Objective:** As a user writing a prompt, I want to invoke one app shortcut
without blurring or modifying my draft, so I can operate CC without leaving the
composer.

#### Acceptance Criteria

1. While an identified CC prompt editor has focus, pressing literal
   `Control+;` shall arm app shortcuts for exactly one complete command.
2. The activation shall work as `Control+;` on every platform; it shall not map
   to `Command+;` on macOS.
3. CC shall wait for both activation keys to be released before accepting the
   armed command, preventing held keys from becoming the next stroke.
4. The armed state shall have no timeout.
5. The armed state shall accept direct shortcuts and complete `G`, `C`, or `V`
   sequences using the same contextual catalog as ordinary dispatch.
6. Pressing `Escape` or pressing `Control+;` again shall cancel the armed state.
7. An invalid or unavailable next stroke shall cancel the armed state without
   preventing the input's native behavior, so the character can still reach
   the prompt.
8. Arming, executing, or canceling one-shot mode shall preserve prompt focus,
   draft contents, attachments, and caret/selection.
9. CC shall cancel a pending one-shot when focus leaves the originating prompt,
   a pointer interaction occurs, composition starts, an overlay opens, the
   route changes, or the window loses focus.
10. CC shall show a compact awaiting-shortcut HUD while ordinary leader mode or
    prompt one-shot mode is pending.

### Requirement 4: Editable-Field Safety and Prompt Editing

**Objective:** As a user, I want app commands and editing controls to coexist
without breaking familiar prompt editing.

#### Acceptance Criteria

1. While any editable field has focus, CC shall suppress ordinary single-key
   and leader shortcuts unless one-shot mode is armed.
2. `Control+.` shall remain available in the prompt to stop an active turn.
3. `Control+Shift+.` shall remain available in the prompt to start or stop
   voice recording when voice input is available.
4. Prompt submission shall retain its platform-adaptive `Mod+Enter` binding.
5. Prompt editing shall retain the readline-style bindings `Control+A`,
   `Control+E`, `Control+U`, `Control+K`, `Control+W`, `Alt+B`, `Alt+F`, and
   `Alt+D`.
6. CC shall not assign any other app action to an `Alt`-modified shortcut.

### Requirement 5: Discovery and Command Execution

**Objective:** As a user, I want to find and run commands without memorizing
every binding.

#### Acceptance Criteria

1. Pressing `?` shall open keyboard help when app shortcuts are eligible.
2. Keyboard help shall offer “Available here” and “All commands” views.
3. The complete help view shall include descriptions, structured keycaps,
   unavailable-context labels, launcher-only commands, and prompt-editing
   shortcuts.
4. Pressing `.` shall open a searchable command launcher containing commands
   available in the current context.
5. The launcher shall support arrow-key selection, `Enter` execution, pointer
   selection, and `Escape` dismissal.
6. Clear prompt, toggle developer tools, and exit panes shall be launcher-only
   commands with no direct global binding.

### Requirement 6: Navigation, Conversation, and Review Commands

**Objective:** As a user, I want ergonomic keyboard access to high-frequency
movement and review tasks.

#### Acceptance Criteria

1. `G H`, `G P`, `G S`, `G C`, `G T`, `G R`, and `G A` shall perform the
   corresponding global or project-scoped navigation command when available.
2. `G 1` through `G 9` shall activate the corresponding open conversation, and
   a missing numbered slot shall leave the final digit unconsumed.
3. `G J` and `G K` shall activate the next and previous open conversations.
4. `I` shall focus the active prompt, `/` shall focus the current contextual
   search/filter, and `B` shall toggle the conversation sidebar.
5. `J`, `K`, `G G`, and `Shift+G` shall navigate to the next, previous, first,
   and latest messages.
6. `[` and `]` shall navigate changed files, and `N` and `Shift+N` shall
   navigate diff hunks, only while a relevant diff surface is active.
7. `Shift+E` and `Shift+C` shall expand and collapse all thinking blocks in the
   active conversation without changing those established bindings.

### Requirement 7: Creation and View Commands

**Objective:** As a user, I want mnemonic sequences for common creation and
workspace-switching actions.

#### Acceptance Criteria

1. `C S`, `C C`, `C W`, and `C T` shall create a session, conversation,
   workflow, or quick ticket in contexts that support the action.
2. `V V` shall return to the previous view when that view history exists.
3. Session workspaces shall support `V C`, `V D`, `V O`, `V A`, `V S`, `V R`,
   and `V P` for conversation, diff, documents, alignment, specs, artifact, and
   panes views.
4. Project workspaces shall use `V S` for sessions and `V C` for conversations.
5. Ticket workspaces shall use `V B` and `V L` for board and list views.
6. Commands unavailable in the current context shall neither execute nor
   reserve the user's unmatched final key.

### Requirement 8: Safe Conversation Tab Closing

**Objective:** As a user, I want `X` to close the active conversation tab
without losing drafts or leaving tab focus in an invalid state.

#### Acceptance Criteria

1. `X` shall close the active conversation tab only while an eligible session
   or project conversation workspace is active.
2. Closing an active tab shall select its previous neighbor, otherwise its next
   neighbor, otherwise the explicit empty state.
3. Closing the last tab in a session panes layout shall exit panes.
4. A project prompt draft shall be scoped to its conversation rather than
   leaking between tabs.
5. Closing a project tab with a non-empty text or image draft shall require
   confirmation before discarding the draft.
6. A project close shall optimistically update the working set while retaining
   an exact ordering-and-focus snapshot.
7. If project close persistence fails, CC shall restore the tab ordering,
   active tab, and draft, notify the user, and log the failure.
8. A successful project close shall remove that conversation's saved draft
   while allowing already-running work to continue.

### Requirement 9: Conflict and Ergonomics Policy

**Objective:** As a user, I want shortcuts that are comfortable and do not
steal well-known browser, operating-system, or window-manager commands.

#### Acceptance Criteria

1. High-frequency actions shall prefer easy single keys or short mnemonic
   leader sequences over multi-modifier chords.
2. Outside the prompt-focused readline bindings in Requirement 4.5, CC shall
   not replace browser-native close-tab, new-tab, address-bar, refresh, print,
   save, page-find, or history modifier chords.
3. Conversation-tab close shall use `X`, not browser-native `Mod+W`.
4. CC shall avoid new `Alt` assignments because of browser, terminal, and
   window-manager variability.
5. The readline bindings in Requirement 4.5 are explicit prompt-focused
   exceptions to the browser, operating-system, and window-manager conflict
   policy. This includes `Control+E/K/U/W` and `Alt+F` conflicts on
   Windows/Linux, plus the reviewed AeroSpace `Alt+F` conflict; the user has
   chosen to retain the editing bindings and adjust AeroSpace where needed.
6. User-configurable shortcut remapping is outside this feature's scope.
7. `/` contextual search is an intentional exception for Firefox Quick Find
   while app shortcuts are eligible; it shall remain suppressed in editable
   fields and overlays, and browser-native `Mod+F` shall remain untouched.
