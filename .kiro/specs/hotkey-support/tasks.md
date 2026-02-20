# Implementation Plan

- [x] 1. Hotkey infrastructure foundation
- [x] 1.1 Install react-hotkeys-hook and create the centralized hotkey registry
  - Install `react-hotkeys-hook` as a project dependency
  - Define `HotkeyCategory`, `HotkeyDefinition`, `HotkeyId`, and `HotkeyRegistry` types
  - Populate the `HOTKEY_REGISTRY` constant with all 11 default key binding entries (helpModal, voiceToggle, toggleSidebar, nextMessage, prevMessage, firstMessage, lastMessage, nextFile, prevFile, nextChange, prevChange)
  - Use `mod` for cross-platform modifier keys where applicable; single keys for non-modifier shortcuts
  - Mark voiceToggle with `enableOnFormTags: true`
  - _Requirements: 1.1, 1.2, 2.1, 2.2_

- [x] 1.2 Create the useAppHotkey hook
  - Build a thin wrapper around react-hotkeys-hook's `useHotkeys` that accepts a `HotkeyId` and callback
  - Look up the key combination and options from the registry by ID
  - Apply `preventDefault: true` by default
  - Apply `enableOnFormTags` from the registry entry when the entry declares it
  - Accept an optional `enabled` boolean for conditional activation
  - _Requirements: 1.3, 3.1, 3.2, 3.3_

- [x] 1.3 Create the platform display utility
  - Build `isMacOS()` function using `navigator.platform` or `navigator.userAgentData`
  - Build `formatHotkeyDisplay(keys)` that maps `mod` → `⌘`/`Ctrl`, `alt` → `⌥`/`Alt`, `shift` → `⇧`/`Shift` based on detected platform
  - Handle special cases like `shift+/` → `?`
  - Capitalize single-key names for display (e.g., `j` → `J`)
  - _Requirements: 2.3, 9.2_

- [x] 1.4 Add unit tests for registry and display utilities
  - Test that every `HotkeyId` has a corresponding entry in `HOTKEY_REGISTRY`
  - Test that all entries have required fields (id, keys, label, description, category)
  - Test `formatHotkeyDisplay` output for all modifier combinations on both platforms
  - Test `isMacOS` detection logic
  - _Requirements: 1.1, 1.2, 2.3_

- [x] 2. (P) Build the hotkey help modal component
  - Create a modal that reads all entries from `HOTKEY_REGISTRY` and groups them by category
  - Render category headings (General, Navigation, Diff Review) with shortcut entries showing label, formatted key display via `formatHotkeyDisplay`, and description
  - Use `<kbd>` elements for key display
  - Close on Escape keypress or click on the overlay background
  - Reuse existing `modal-overlay` and `modal` CSS patterns from ConfirmDialog
  - Add CSS styles for the help modal layout and kbd elements
  - Accept `open` and `onClose` props (stateless, parent-controlled)
  - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [x] 3. (P) Wire sidebar toggle hotkey in the conversations sidebar
  - Add hotkey binding for toggling the sidebar expand/collapse state using the existing `toggleCollapsed` callback
  - The existing toggle logic already persists the state to localStorage
  - Default input filtering applies (suppressed when typing in form fields)
  - _Requirements: 6.1, 6.2, 6.3_

- [x] 4. (P) Wire diff file and change navigation hotkeys in the diff panel
  - Add hotkey bindings for next/previous file navigation using the existing `navigateFile` function
  - Add hotkey bindings for next/previous change (hunk) navigation using the existing `navigateHunk` function
  - The existing navigation functions already handle empty state and auto-expand collapsed files
  - Default input filtering applies (suppressed in form fields)
  - _Requirements: 7.1, 7.2, 7.3, 8.1, 8.2_

- [x] 5. Session detail page hotkeys
- [x] 5.1 (P) Wire message navigation hotkeys
  - Add hotkey bindings for next/previous message using the existing `handleNextMessage` and `handlePrevMessage` callbacks
  - Add hotkey bindings for first/last message using `scrollToMessage` with boundary indices
  - Message navigation boundary guards are already implemented in the existing handlers
  - Default input filtering applies (suppressed when typing in the prompt textarea)
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 5.2 Lift the voice recorder hook and wire the voice toggle hotkey
  - Move the `useVoiceRecorder` hook call from VoiceRecordButton up to SessionDetailPage
  - Pass the hook's return values (isRecording, isProcessing, elapsedTime, isAvailable, toggleRecording) as props to VoiceRecordButton
  - Refactor VoiceRecordButton to accept voice state as props instead of calling the hook internally
  - Add hotkey binding for voice toggle with `enableOnFormTags` so it works while typing
  - Guard the hotkey with `enabled` set to `isAvailable && !isProcessing`
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 5.3 Wire the help modal trigger and render the discovery modal
  - Add help modal open/close state to SessionDetailPage
  - Add hotkey binding for opening the help modal (the `?` shortcut)
  - Render the HotkeyHelpModal component with open state and close callback
  - Depends on Task 2 (HotkeyHelpModal component must exist)
  - _Requirements: 9.1, 9.3_
