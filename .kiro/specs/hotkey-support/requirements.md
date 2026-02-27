# Requirements Document

## Introduction
CC needs a first-class keyboard shortcut system that lets users perform common actions without reaching for the mouse. The system must be centralized and declarative — all hotkey definitions live in a single registry that drives both runtime binding and a user-facing discovery UI. The initial set of hotkeys covers voice recording, conversation navigation, sidebar toggling, and diff panel navigation. The architecture must make adding future hotkeys trivial and lay the groundwork for eventual user-configurable key bindings.

## Requirements

### Requirement 1: Centralized Hotkey Registry
**Objective:** As a developer, I want all hotkey definitions declared in a single, centralized registry, so that adding or modifying shortcuts requires changes in one place and the registry can power both runtime binding and UI display.

#### Acceptance Criteria
1. The CC app shall define all keyboard shortcuts in a single declarative registry data structure.
2. Each registry entry shall include at minimum: a unique identifier, a human-readable label, a description, the key combination string, and a category grouping.
3. When a new hotkey is added to the registry, the CC app shall automatically make it available at runtime and in the discovery UI without additional wiring.

### Requirement 2: Cross-Platform Key Binding
**Objective:** As a user on macOS or Linux, I want hotkeys to work correctly on my platform, so that I don't have to remember platform-specific modifier keys.

#### Acceptance Criteria
1. The CC app shall use a platform-adaptive modifier key (`Cmd` on macOS, `Ctrl` on Linux) for shortcuts that require a primary modifier.
2. The CC app shall assign default key bindings that do not conflict with well-known browser shortcuts (e.g., `Ctrl+T`, `Ctrl+W`, `Ctrl+L`, `Cmd+Q`) or OS-level shortcuts on macOS and Linux.
3. The hotkey discovery UI shall display key bindings using the correct modifier symbol for the user's current platform (e.g., `⌘` on macOS, `Ctrl` on Linux).

### Requirement 3: Input Focus Filtering
**Objective:** As a user, I want hotkeys to not interfere with normal text input, so that typing in the prompt textarea or other input fields works as expected.

#### Acceptance Criteria
1. While a text input, textarea, or contenteditable element is focused, the CC app shall suppress non-modifier hotkeys (single-key shortcuts like `j`, `k`, `?`) to prevent interference with typing.
2. While a text input is focused, the CC app shall still allow modifier-based shortcuts (e.g., `Alt+V`) that do not conflict with standard text editing operations.
3. When no input element is focused, the CC app shall process all registered hotkeys normally.

### Requirement 4: Voice Recording Toggle
**Objective:** As a user, I want to start and stop voice recording with a keyboard shortcut, so that I can dictate prompts without clicking the microphone button.

#### Acceptance Criteria
1. When the user presses the designated voice toggle hotkey, the CC app shall start voice recording if currently idle, or stop recording if currently recording.
2. While voice recording is unavailable (health check fails), the CC app shall ignore the voice toggle hotkey without displaying an error.
3. While voice transcription is processing, the CC app shall ignore the voice toggle hotkey until processing completes.

### Requirement 5: Conversation Message Navigation
**Objective:** As a user, I want to navigate between messages in a conversation using the keyboard, so that I can review conversation history without scrolling manually.

#### Acceptance Criteria
1. When the user presses the next-message hotkey, the CC app shall scroll to and highlight the next message in the conversation.
2. When the user presses the previous-message hotkey, the CC app shall scroll to and highlight the previous message in the conversation.
3. When the user presses the go-to-start hotkey, the CC app shall scroll to the first message in the conversation.
4. When the user presses the go-to-end hotkey, the CC app shall scroll to the last message in the conversation.
5. While the conversation is at the first message, the CC app shall not respond to the previous-message hotkey.
6. While the conversation is at the last message, the CC app shall not respond to the next-message hotkey.

### Requirement 6: Conversations Sidebar Toggle
**Objective:** As a user, I want to expand and collapse the conversations list panel with a hotkey, so that I can maximize screen space for the active conversation.

#### Acceptance Criteria
1. When the user presses the sidebar toggle hotkey, the CC app shall collapse the conversations sidebar if it is currently expanded.
2. When the user presses the sidebar toggle hotkey, the CC app shall expand the conversations sidebar if it is currently collapsed.
3. When the sidebar is toggled via hotkey, the CC app shall persist the new state to localStorage so it survives page reloads.

### Requirement 7: Diff Panel File Navigation
**Objective:** As a user reviewing code changes, I want to jump between files in the diff panel using the keyboard, so that I can efficiently review multi-file diffs.

#### Acceptance Criteria
1. When the user presses the next-file hotkey while the diff panel is visible, the CC app shall scroll to the next file in the diff list.
2. When the user presses the previous-file hotkey while the diff panel is visible, the CC app shall scroll to the previous file in the diff list.
3. When navigating to a collapsed file, the CC app shall expand it before scrolling to it.

### Requirement 8: Diff Panel Change Navigation
**Objective:** As a user reviewing code changes, I want to jump between individual changes (hunks) within the diff panel, so that I can focus on each modification.

#### Acceptance Criteria
1. When the user presses the next-change hotkey while the diff panel is visible, the CC app shall scroll to the next diff hunk.
2. When the user presses the previous-change hotkey while the diff panel is visible, the CC app shall scroll to the previous diff hunk.

### Requirement 9: Hotkey Discovery UI
**Objective:** As a user, I want a way to view all available keyboard shortcuts, so that I can learn and remember the hotkeys.

#### Acceptance Criteria
1. When the user presses the help hotkey (e.g., `?`), the CC app shall display a modal listing all registered keyboard shortcuts grouped by category.
2. Each entry in the discovery modal shall display the shortcut's human-readable label, key combination (with platform-correct modifier symbols), and description.
3. When the user presses `Escape` or clicks outside the modal, the CC app shall close the hotkey discovery modal.
4. The discovery modal shall derive its content entirely from the centralized hotkey registry, requiring no separate maintenance.
