# Implementation Plan

The enhanced implementation supersedes the original 11-binding
`react-hotkeys-hook` plan. The checklist below reflects the current central
dispatcher design and the red-green tests added with each behavior.

- [x] 1. Establish the authoritative command catalog
  - Define all command IDs, categories, labels, descriptions, direct bindings,
    alternatives, sequences, and launcher-only entries in
    `src/lib/shared/hotkeys.ts`.
  - Add sequence parsing and platform-aware display formatting.
  - Add the prompt-native reference for `Ctrl+;`, `Mod+Enter`,
    `Ctrl+A/E/U/K/W`, and `Alt+B/F/D`.
  - Test complete definitions, parsing, display output, and the policy that no
    app command adds an `Alt` binding.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 4.4, 4.5, 4.6, 9.1, 9.4_

- [x] 2. Replace per-component matching with the central dispatcher
  - Implement direct and multi-stroke matching with a 1-second normal leader
    timeout.
  - Register callbacks and availability by catalog ID through `useAppHotkey`.
  - Fail closed on duplicate eligible registrations.
  - Let invalid/unavailable continuations fall through.
  - Suppress overlay-owned input and reject repeat, composition, IME-process,
    and AltGraph events.
  - Add structured logs for invocation, timeout, cancellation, ambiguity, and
    callback failures.
  - Cover matching and failure behavior with dispatcher-first tests.
  - _Requirements: 1.2, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 9.1_

- [x] 3. Mount one provider and implement prompt one-shot mode
  - Mount `HotkeyProvider` at the application root with one capture-phase
    `keydown`/`keyup` pair.
  - Derive editable, prompt identity, and overlay context from the event target
    and overlay store.
  - Arm one-shot mode with literal `Ctrl+;` only inside an identified prompt.
  - Add the Control/semicolon release guard, no-timeout pending state, direct
    and leader execution, invalid fallthrough, and `Escape`/repeat activation
    cancellation.
  - Cancel pending state on focus change, pointer interaction, composition,
    overlay opening, route change, window blur, and provider unmount.
  - Preserve prompt focus, serialized draft, attachments, caret, and selection.
  - Render and test prompt-local and global awaiting-shortcut HUD states.
  - _Requirements: 2.1, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 4.1_

- [x] 4. Build discovery and launcher surfaces
  - Register global `?` keyboard help and `.` command launcher commands.
  - Build “Available here” and “All commands” help scopes from dispatcher
    command views.
  - Render descriptions, categories, structured keycaps, unavailable labels,
    launcher-only entries, and the prompt-editing reference.
  - Build a searchable combobox/listbox command launcher with arrow, Enter,
    pointer, empty-result, and Escape behavior.
  - Invoke launcher selections through dispatcher availability and duplicate
    resolution.
  - Add component tests and Storybook states for help, launcher, and HUD.
  - _Requirements: 1.2, 1.3, 1.4, 1.5, 2.7, 3.10, 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 5. Wire global and project navigation
  - Implement `G H` projects, `G P` project switcher, `G S` session switcher,
    `G C` conversations, `G T` tickets, `G R` specs/review, and `G A` Needs
    You.
  - Preserve project-scoped routes and make each registration context-aware.
  - Implement contextual `/` search/filter focus.
  - Update visible navigation hints to derive from the catalog.
  - Add focused tests for routes, switchers, availability, and search focus.
  - _Requirements: 1.2, 6.1, 6.4_

- [x] 6. Wire conversation navigation and review
  - Implement `G 1` … `G 9`, `G J`, and `G K` for ordered open conversations
    in session and project working sets.
  - Leave a missing numbered slot's final digit unconsumed.
  - Implement `I`, `B`, `J`, `K`, `G G`, and `Shift+G`.
  - Implement `[`/`]` file and `N`/`Shift+N` hunk navigation on active diff
    surfaces.
  - Keep exact `Shift+E` and `Shift+C` thinking expansion bindings in session
    and project transcripts.
  - Keep `Ctrl+.` stop and move voice to `Ctrl+Shift+.` with editable-field
    eligibility.
  - Add pure ordering tests and focused integration tests for each surface.
  - _Requirements: 4.2, 4.3, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

- [x] 7. Wire creation and contextual view commands
  - Implement `C S`, `C C`, `C W`, and `C T` in their owning contexts.
  - Implement session `V V/C/D/O/A/S/R/F/P` and launcher-only exit panes.
  - Implement project `V S/C` and ticket `V B/L`.
  - Allow contextual reuse of `V S` while preserving duplicate fail-closed
    behavior.
  - Move clear prompt, developer tools, and exit panes to launcher-only entries.
  - Add focused tests for context gates and state transitions.
  - _Requirements: 2.6, 2.7, 5.6, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

- [x] 8. Implement safe `X` conversation-tab close
  - Extract and test the previous-neighbor, next-neighbor, empty-state
    selection rule.
  - Wire session close and exit panes when the final pane closes.
  - Render an explicit session empty state after the final tab closes.
  - Scope project prompt documents and image attachments by conversation ID.
  - Confirm before closing a project tab with an unsent text or image draft.
  - Capture an exact project store snapshot before optimistic close.
  - Remove the draft on success and restore ordering, focus, and draft with a
    toast and structured error log on failure.
  - Exercise clean close, confirmation, success, last-tab, and rollback flows
    in integration tests.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 9.3_

- [x] 9. Remove stale shortcut assumptions and document conflict policy
  - Replace outdated `Alt+V`, Home/End, modified-number, and direct
    developer/clear hints.
  - Keep readline `Ctrl+A/E/U/K/W` and `Alt+B/F/D`.
  - Add no new app-level `Alt` bindings.
  - Record the user-approved Windows/Linux browser conflicts and the decision
    to adjust AeroSpace for its retained `Alt+F` readline conflict.
  - Keep browser-native `Mod+W`, `Mod+T`, `Mod+L`, and related shortcuts
    unclaimed outside the prompt-focused readline exception.
  - _Requirements: 4.5, 4.6, 5.6, 9.1, 9.2, 9.3, 9.4, 9.5, 9.7_

- [x] 10. Complete aggregate and live verification
  - Run the final focused hotkey test set after all feature integrations settle.
  - Run typecheck, lint, formatting, and the repository's proportional test
    suite.
  - Start this worktree's configured dev server through `cctl dev ensure`.
  - Verify direct keys, all three leader families, overlay suppression, prompt
    one-shot focus/draft preservation, help, launcher, and close behavior in the
    live browser.
  - Record any browser-specific differences without weakening the catalog
    conflict policy.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_
