# Research & Design Decisions

## Summary
- **Feature**: `hotkey-support`
- **Discovery Scope**: New Feature (greenfield hotkey system integrating with existing components)
- **Key Findings**:
  - `react-hotkeys-hook` v5.2.4 provides `mod` for cross-platform modifiers, built-in input filtering, scopes, and TypeScript-first types — covers all infrastructure needs
  - All target action functions already exist (`toggleRecording`, `handlePrevMessage`/`handleNextMessage`, `scrollToMessage`, `navigateFile`/`navigateHunk`, `toggleCollapsed`) — this is a wiring + infrastructure task
  - Existing modal pattern (`ConfirmDialog`) and `<kbd>` styling in `globals.css` provide reusable patterns for the help modal

## Research Log

### react-hotkeys-hook API and Capabilities
- **Context**: Need to verify the library covers all requirements (cross-platform, input filtering, centralized config, TypeScript)
- **Sources Consulted**: [npm](https://www.npmjs.com/package/react-hotkeys-hook), [GitHub](https://github.com/JohannesKlauss/react-hotkeys-hook), [Official docs](https://react-hotkeys-hook.vercel.app/)
- **Findings**:
  - v5.2.4 (Feb 2026), zero runtime dependencies, peer deps: React >= 16.8
  - `mod` modifier maps to Cmd on macOS, Ctrl on Windows/Linux — single definition works cross-platform
  - `enableOnFormTags` option (boolean or `FormTags[]`) controls per-hotkey input filtering — default suppresses in input/textarea/select
  - `HotkeysProvider` + `useHotkeysContext` enables multi-scope management with `enableScope`/`disableScope`/`toggleScope`
  - Supports key sequences via `>` syntax (e.g., `g>i`) with configurable timeout
  - `Options.description` field for metadata, but no built-in help overlay
  - Hook returns a ref for element-scoped hotkeys; unattached = global (document-level)
  - `Options.enabled` accepts boolean or function for conditional activation
  - `Options.preventDefault` accepts boolean or function
- **Implications**: Library covers requirements 1–3 (registry, cross-platform, input filtering) with minimal custom code. Scopes are available but not essential for initial implementation — simple `enabled` conditions suffice.

### Key Binding Conflict Analysis
- **Context**: Must avoid conflicts with browser and OS shortcuts on macOS and Linux
- **Sources Consulted**: MDN keyboard shortcuts reference, browser documentation
- **Findings**:
  - **Browser shortcuts to avoid** (Ctrl/Cmd variants): T (new tab), W (close tab), N (new window), L (address bar), S (save), P (print), F (find), H (history), J (downloads), D (bookmark), R (reload)
  - **OS shortcuts to avoid**: Cmd+Space (Spotlight), Cmd+Tab (app switch), Super key (Linux), Ctrl+Alt+T (terminal)
  - **Safe single-key shortcuts** (suppressed in inputs by default): `j`, `k`, `b`, `n`, `[`, `]`, `Home`, `End`, `?`
  - **Safe modifier shortcuts**: `Alt+V` (unused in all major browsers), `Shift+N` (no conflict)
  - **Note**: `Home`/`End` may scroll the page when no input focused — must use `preventDefault`
- **Implications**: Selected key bindings align with established conventions (GitHub uses `j`/`k` for navigation, `?` for help, `b` for sidebar toggle) and avoid all known browser/OS conflicts.

### Existing Codebase Integration Points
- **Context**: Understand how to wire hotkeys to existing action functions
- **Sources Consulted**: Codebase exploration of SessionDetailPage, DiffPanel, ConversationSidebar, VoiceRecordButton
- **Findings**:
  - **Message navigation**: `handlePrevMessage()`, `handleNextMessage()`, `scrollToMessage(index)` in `SessionDetailPage.tsx` (lines 174–195)
  - **Voice toggle**: `toggleRecording()` returned from `useVoiceRecorder` hook, guarded by `isAvailable`, `isProcessing`, and `state` checks
  - **Sidebar toggle**: `toggleCollapsed()` in `ConversationSidebar.tsx` (lines 47–53), already persists to localStorage
  - **Diff file nav**: `navigateFile(dir)` in `DiffPanel.tsx` (lines 49–83), auto-expands collapsed files
  - **Diff change nav**: `navigateHunk(dir)` in `DiffPanel.tsx` (lines 85–109)
  - **Keyboard event patterns**: Components use `useCallback` + `useEffect` with `document.addEventListener` for global keys; `onKeyDown` props for element-scoped keys
  - **Modal pattern**: `ConfirmDialog.tsx` uses `modal-overlay` + `modal` CSS classes, z-index 200, Escape to close, click-outside to close
  - **Kbd styling**: `.cmd-footer kbd` style in `globals.css` (lines 3360–3370) provides existing `<kbd>` element rendering
- **Implications**: All handlers are already `useCallback`-wrapped and stable. Voice state needs to be accessible from the hotkey binding site — either lift the hook call or expose toggle via a ref/callback prop.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Per-component useHotkeys | Each component calls useHotkeys with keys from registry | Simple, colocated, no new abstractions | Key definitions scattered across files without registry | Selected with registry indirection |
| Global HotkeyBinder component | Single component receives all handlers as props | All bindings in one place | Prop drilling, tight coupling to all features | Rejected — poor scalability |
| Context-based action dispatch | Central context provides dispatch, hotkeys call dispatch | Decoupled from components | Over-engineered for current scope, adds indirection | Rejected — YAGNI |

**Selected**: Per-component `useHotkeys` calls with a centralized registry object that provides key strings and metadata. Each component imports the registry entry for its hotkeys and passes the `.keys` value to `useHotkeys`. A thin `useAppHotkey` wrapper standardizes the pattern and enables future key customization.

## Design Decisions

### Decision: Registry Data Structure
- **Context**: Need a single source of truth for all hotkey definitions (Req 1)
- **Alternatives Considered**:
  1. Array of definitions — iterate to find by ID
  2. Record keyed by ID — direct lookup, type-safe keys
- **Selected Approach**: `Record<HotkeyId, HotkeyDefinition>` with a string literal union for IDs
- **Rationale**: Type-safe lookup by ID, IDE autocomplete, no runtime iteration needed for binding
- **Trade-offs**: Adding a hotkey requires updating both the registry and the union type
- **Follow-up**: If user-configurable keys are added later, the registry can merge user overrides onto defaults

### Decision: Custom useAppHotkey Hook vs Direct useHotkeys
- **Context**: Want consistent behavior and future-proof key customization (Req 1.3)
- **Alternatives Considered**:
  1. Call `useHotkeys` directly everywhere — simplest but duplicates options
  2. Custom `useAppHotkey(id, callback, overrides?)` wrapper — adds indirection layer
- **Selected Approach**: Custom `useAppHotkey` hook that looks up the registry entry by ID and delegates to `useHotkeys`
- **Rationale**: Single place to change key bindings, consistent `preventDefault` and `enableOnFormTags` behavior, future customization point
- **Trade-offs**: One extra abstraction layer; marginal complexity
- **Follow-up**: When user-configurable keys are added, `useAppHotkey` can read from a merged config (defaults + user overrides)

### Decision: Scopes vs Enabled Conditions
- **Context**: Some hotkeys should only work when specific panels are visible (Req 7, 8)
- **Alternatives Considered**:
  1. `HotkeysProvider` scopes — activate/deactivate scope groups based on panel visibility
  2. Per-hotkey `enabled` option — conditionally enable based on component state/props
- **Selected Approach**: Per-hotkey `enabled` option, no scopes for initial implementation
- **Rationale**: Scopes add provider complexity and require managing active scope state. The `enabled` option is simpler and sufficient — each component knows its own visibility. Scopes can be adopted later if the hotkey count grows significantly.
- **Trade-offs**: No centralized scope toggling; each component manages its own enabled state
- **Follow-up**: If scope management becomes needed, `HotkeysProvider` can be added without breaking existing hotkeys

### Decision: Platform Display Symbols
- **Context**: Help modal must show correct modifier symbols per platform (Req 2.3)
- **Alternatives Considered**:
  1. Parse `navigator.platform` or `navigator.userAgentData` at runtime
  2. CSS-based approach with `@supports` or media queries
- **Selected Approach**: Runtime `navigator.platform` check (or `navigator.userAgentData.platform`) with a utility function that maps `mod` → `⌘` on macOS, `Ctrl` on Linux/Windows
- **Rationale**: Simple, reliable, matches how react-hotkeys-hook internally detects platform
- **Trade-offs**: SSR renders without platform info — must use client-side detection
- **Follow-up**: Utility function can be extended for Windows if needed

### Decision: Voice Toggle Hotkey in Input Fields
- **Context**: Voice toggle should work even when the user is typing in the prompt textarea (Req 4.1)
- **Alternatives Considered**:
  1. `enableOnFormTags: true` — allows the hotkey in all form fields
  2. `enableOnFormTags: ['textarea']` — only in textareas
- **Selected Approach**: `enableOnFormTags: true` for the voice toggle hotkey, since `Alt+V` uses a modifier and won't conflict with normal typing
- **Rationale**: Users are most likely to want voice input while focused on the prompt textarea
- **Trade-offs**: None significant — `Alt+V` doesn't produce a typeable character

## Risks & Mitigations
- **Risk**: `Home`/`End` keys may conflict with text cursor movement if focus state is ambiguous → **Mitigation**: Default input filtering suppresses these when a text field is focused
- **Risk**: International keyboard layouts may produce different characters for `[`, `]`, `?` → **Mitigation**: react-hotkeys-hook uses both `key` and `code` for matching; revisit if user reports arise
- **Risk**: `useHotkeys` calls in components that unmount may leave stale listeners → **Mitigation**: react-hotkeys-hook handles cleanup via React effect lifecycle automatically

## References
- [react-hotkeys-hook docs](https://react-hotkeys-hook.vercel.app/) — API reference and usage patterns
- [react-hotkeys-hook GitHub](https://github.com/JohannesKlauss/react-hotkeys-hook) — Source, issues, TypeScript types
- [npm: react-hotkeys-hook](https://www.npmjs.com/package/react-hotkeys-hook) — v5.2.4, 2M weekly downloads
- [MDN KeyboardEvent.key](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key) — Key values reference
- [GitHub keyboard shortcuts](https://docs.github.com/en/get-started/accessibility/keyboard-shortcuts) — Precedent for `j`/`k`/`?`/`b` conventions
