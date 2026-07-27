# Keyboard Shortcut Audit & Manual-Testing Checklist

> **Historical audit — superseded.** This document records the
> `react-hotkeys-hook` implementation as it existed on 2026-06-01. The current
> architecture and manual-verification contract live in
> `.kiro/specs/hotkey-support/{requirements,design,tasks}.md`; runtime commands
> are defined by `src/lib/shared/hotkeys.ts` and dispatched through
> `src/lib/hotkeys/dispatcher.ts`.

Audit date: 2026-06-01. Scope: every keyboard shortcut in Command Center, the context each is meant to apply in, whether it is implemented with `react-hotkeys-hook` correctly, and whether each fires **only** in its intended scope (not while typing in a text field, and not leaking into the background while a modal is open).

Reference for correct library usage: `agent-docs/react-hotkeys-hook-reference.md`.

---

## How the hotkey system works (read first)

- **Central registry**: `src/lib/shared/hotkeys.ts` defines every "official" shortcut (`HOTKEY_REGISTRY`). Components bind one via `useAppHotkey(id, callback, { enabled })` (`src/hooks/useAppHotkey.ts`), which calls `useHotkeys(keys, cb, { preventDefault: true, enableOnFormTags, enableOnContentEditable, useKey })`.
- **No scopes anywhere.** There is **no `HotkeysProvider`** in the app, and `useAppHotkey` never passes `scopes`. Every registry hotkey is therefore **global** (scope `*`) and is gated *only* by its `enabled` flag and by `react-hotkeys-hook`'s built-in form-field suppression.
- **Form-field suppression**: a hotkey **without** `enableOnFormTags`/`enableOnContentEditable` is automatically suppressed when focus is in an `<input>`/`<textarea>`/`<select>` or a `contentEditable` element. It is **NOT** suppressed when focus is on a `<button>`, a `role="switch"`/`role="button"` `<div>`, the `<body>`, or a modal overlay. **This is the crux of the scope findings below.**
- The prompt composer is **Tiptap 3 / ProseMirror** (a `contentEditable` `<div>`), not CodeMirror. Editor-local keys are ProseMirror keymaps; page hotkeys are correctly suppressed while typing because the editor is `contentEditable`.

Legend for checkboxes: `[ ]` = behaves correctly, `[!]` = known issue (see Findings). Negative tests ("must NOT do X") are as important as positive ones.

---

## Section 1 — Global shortcuts (active on EVERY page)

Mounted in `src/features/_root/RootLayout.tsx` via `GlobalHotkeyHelp` and `DevToolsGate`.

| Keys | Action | Registry id | Notes |
|---|---|---|---|
| `?` | Open keyboard-shortcuts help modal | `helpModal` | `useKey: true` so it matches the produced "?" on any layout |
| `Shift`+`D` | Toggle dev tools (Next.js indicator + TanStack Query devtools) | `toggleDevTools` | |

- [ ] **`?`** opens the Help modal on the projects list, project page, session page, and workflow pages.
- [ ] **`?`** does **NOT** fire while typing in any text field (prompt editor, search box, command console, dialog inputs) — it should type a literal "?".
- [ ] **`Shift`+`D`** toggles the dev-tools indicator on every page.
- [ ] **`Shift`+`D`** does **NOT** fire while a text field is focused.
- [!] **`?` while another modal is open** (e.g. a confirm dialog, merge dialog, MCP modal): the Help modal currently opens **stacked on top**. It should be suppressed. (Finding #1/#2)
- [!] **`Shift`+`D` while a non-form element inside a modal is focused**: dev tools toggle in the background. Should be suppressed. (Finding #1)

---

## Section 2 — Session / conversation page

Route `…/sessions/[session]`. Hotkeys come from `use-conversation-nav.ts`, `ConversationSidebar.tsx`, `use-voice-wiring.ts`, `use-clear-input-hotkey.ts`.

| Keys | Action | Registry id | Active when |
|---|---|---|---|
| `j` | Scroll to next message | `nextMessage` | session page mounted (no `enabled` guard) |
| `k` | Scroll to previous message | `prevMessage` | session page mounted |
| `Home` | Scroll to first message | `firstMessage` | session page mounted |
| `End` | Scroll to last message | `lastMessage` | session page mounted |
| `b` | Toggle conversations sidebar | `toggleSidebar` | `ConversationSidebar` mounted |
| `Shift`+`B` | Toggle "active conversations" panel | `toggleActivePanel` | **never — no call site (dead)** |
| `Cmd/Ctrl`+`K` | Focus sidebar search | `focusSidebarSearch` | `ConversationSidebar` mounted; `enableOnFormTags` |
| `Alt`+`V` | Toggle voice recording | `voiceToggle` | `enabled: voiceAvailable && !isProcessing`; `enableOnFormTags`+`contentEditable` |
| `Escape` | Clear the prompt input | `clearInput` | only acts when the prompt editor is focused (handler guards `isPromptFocused()`); `enableOnFormTags`+`contentEditable` |

Positive tests:
- [ ] **`j` / `k`** move between messages when the conversation has focus / a button is focused.
- [ ] **`Home` / `End`** jump to first / last message.
- [ ] **`b`** collapses/expands the sidebar.
- [ ] **`Cmd/Ctrl`+`K`** focuses and selects the sidebar search input.
- [ ] **`Alt`+`V`** starts/stops voice recording (when mic available); works **while composing** in the prompt (it's form-enabled by design).
- [ ] **`Escape`** with the prompt editor focused clears the prompt text, placeholder, and pending images.

Negative / scope tests:
- [ ] **`j` / `k` / `b` / `Home` / `End`** do **NOT** fire while typing in the prompt editor (Tiptap contentEditable) — they should type/move the cursor.
- [ ] **`Home` / `End`** inside any text input move the caret to line start/end (must NOT be hijacked).
- [ ] **`Cmd/Ctrl`+`K`** pressed while the prompt editor is focused does **NOT** steal focus (handler bails if another editable is focused — `ConversationSidebar.tsx:243-258`).
- [ ] **`Escape`** while the prompt is empty/unfocused does nothing disruptive.
- [!] **`Shift`+`B`** does nothing — the registry entry `toggleActivePanel` has no `useAppHotkey` call site, yet it is **listed in the Help modal**. (Finding #4)
- [!] **`j`/`k`/`b`/etc. while a session-page modal is open** (Commit, Smart Merge, MCP, dev-servers, session-actions menu) and focus is on a button or nothing: they currently **fire in the background** (scroll conversation, toggle sidebar). They must not. (Finding #1)

---

## Section 3 — Diff review

Two separate surfaces, never co-mounted:
- In-session right pane: `DiffPanel` (`RightPane.tsx:62`), `enabled: rightPaneTab === "diff"`.
- Standalone diff route: `SessionDiffViewer` (`SessionDiffPage.tsx`), `enabled: activeTab === "uncommitted"`.

| Keys | Action | Registry id |
|---|---|---|
| `]` | Jump to next file | `nextFile` |
| `[` | Jump to previous file | `prevFile` |
| `n` | Jump to next change/hunk | `nextChange` |
| `Shift`+`N` | Jump to previous change/hunk | `prevChange` |

- [ ] **`]` / `[`** move between files when the diff tab is active.
- [ ] **`n` / `Shift`+`N`** move between hunks when the diff tab is active.
- [ ] On the in-session pane, the diff hotkeys are **inactive when the right pane is not on the Diff tab** (`hotkeysEnabled={rightPaneTab === "diff"}`).
- [ ] Diff hotkeys do **NOT** fire while typing in any text field.
- [ ] On the session page with the Diff tab active, `j`/`k` (conversation) and `]`/`[`/`n` (diff) coexist without collision (different keys target different panes) — confirm this is intended, not confusing.

---

## Section 4 — Project page

Route `/projects/[name]` (`ProjectDetailView.tsx`).

| Keys | Action | Registry id | Notes |
|---|---|---|---|
| `Cmd/Ctrl`+`N` | Open New Session modal | `newSession` | `enableOnFormTags` |
| `Cmd/Ctrl`+`K` | Focus the command console | `focusCommandConsole` | `enableOnFormTags`; **same combo as `focusSidebarSearch`** |
| `Escape` | Clear bulk selection | (manual `document` listener, `ProjectDetailView.tsx:212-221`) | only attached when a selection exists and no confirm/delete dialog is open |

- [ ] **`Cmd/Ctrl`+`N`** opens the Create Session modal.
- [ ] **`Cmd/Ctrl`+`K`** focuses the command console input.
- [ ] **`Escape`** clears a multi-select session selection (when one exists).
- [!] **`Cmd/Ctrl`+`K` / `Cmd/Ctrl`+`N` while the Create Session modal is open**: `Cmd/Ctrl`+`K` focuses the console **behind** the modal; `Cmd/Ctrl`+`N` re-fires the open action. Should be suppressed while the modal is open. (Finding #1)
- [ ] Verify `focusCommandConsole` (project page) and `focusSidebarSearch` (session page) never mount on the same route, so the duplicate `Cmd/Ctrl`+`K` binding cannot double-fire. (Finding #5)

---

## Section 5 — Prompt editor (Tiptap / ProseMirror), per `terminal-hotkeys-extension.ts`

Editor-local readline-style bindings. These are intentionally **not** `react-hotkeys-hook` — ProseMirror keymaps are the correct, idiomatic mechanism (scoped to the editor). Active only when the prompt editor is focused.

| Keys | Action |
|---|---|
| `Cmd/Ctrl`+`Enter` | Submit the prompt |
| `Enter` (plain) | Insert newline (does **not** submit) |
| `Ctrl`+`A` / `Ctrl`+`E` | Move to start / end of line |
| `Ctrl`+`U` / `Ctrl`+`K` | Delete to start / end of line |
| `Ctrl`+`W` | Delete previous word |
| `Alt`+`B` / `Alt`+`F` | Move word backward / forward |
| `Alt`+`D` | Delete next word |

- [ ] **`Cmd/Ctrl`+`Enter`** submits; does nothing harmful while IME composing (falls through during composition).
- [ ] **`Enter`** inserts a newline; never submits on its own.
- [ ] All `Ctrl`/`Alt` readline keys do their editing action and do **not** leak to the page.
- [ ] None of these fire when the editor is not focused.
- [ ] `Mobile` send: in `MobilePromptToolbar`, verify send/voice controls work; opening an action sheet and pressing `Escape` closes the sheet.

---

## Section 6 — Autocomplete popups (inside the prompt editor)

Triggered by `/` (commands/skills), `@` (files), `#` (conversations). Keys are routed through the editor's keydown to the popup's `handleKeyDown`. Active only while the popup is open.

| Keys | Action |
|---|---|
| `ArrowUp` / `ArrowDown` | Move selection |
| `Enter` / `Tab` | Insert the highlighted item |
| `Escape` | Close the popup |
| `Alt`+`A` | (conversation `#` popup only) Toggle "include archived" |

- [ ] Arrow keys move the highlight; `Enter`/`Tab` insert the selection; the editor does **not** also submit or insert a newline while a popup is open.
- [ ] **`Escape` closes the popup only** and does **NOT** also clear the whole prompt — the popups call `stopPropagation()`, so the global `clearInput` (Escape) does not fire. Verify for all three popups.
- [!] **Slash (`/`) popup `Escape`** clears the **entire prompt** (`CommandAutocomplete` → `onPromptChange("")`), whereas the `@` file popup only closes. Confirm whether the inconsistency is intended. (Finding #7)
- [ ] **`Alt`+`A`** in the `#` popup toggles archived results and does not trigger `Alt`+`V` voice. (No collision — different letter.)
- [ ] With an **empty** popup, `Tab`/`Enter` fall through to the editor (Tab may blur the editor) — confirm this edge case is acceptable.

---

## Section 7 — Modals, dialogs, drawers, menus (Escape / Enter)

Each of these closes on `Escape` via its own `document`/`window` keydown listener (no shared primitive). **The critical cross-cutting issue is that, except where noted, they do NOT suppress background hotkeys while open** (Finding #1). Use the Cross-cutting scope tests in Section 9 to verify each.

| Component | Esc closes? | Enter? | Isolates Esc? (`stopPropagation`) | Focus trap? |
|---|---|---|---|---|
| `ConfirmDialog` (delete, concurrent-submit) | ✅ | ✅ Enter = confirm (isolated) | ❌ Esc bubbles | ❌ (focuses confirm button) |
| `BulkConfirmModal` | ✅ | — | ❌ | ❌ |
| `CommitDialog` | ✅ | `Cmd/Ctrl`+`Enter` = commit | ❌ | ❌ (focuses textarea) |
| `SmartMergeDialog` (the real merge dialog) | ✅ | — | ❌ | ❌ (nothing focused) |
| `CreateSessionModal` | ✅ | Enter submits (name/textarea) | ❌ | ❌ (focuses input) |
| `HotkeyHelpModal` | ✅ | — | ✅ capture+stop | ❌ |
| `McpServersModal` | ✅ | — | ✅ capture+stop | ❌ |
| `McpConfigPopover` | ✅ | — | ❌ | ❌ |
| `DevServerDrawer` / `DevServersButton` popover | ✅ | — | ❌ | ❌ |
| `MobileActionMenu`, `MobilePromptToolbar` sheets | ✅ | — | ❌ | ❌ |
| `MermaidDiagram` fullscreen overlay | ✅ | — | ❌ | ❌ |
| `ModelSelector`, `ReasoningLevelSelector`, `SessionActionsMenu`, `CardContextMenu`, `ConversationSidebarRowContextMenu` | ✅ | — | ❌ | ❌ |
| `PeekPopover` | ✅ (floating-ui dismiss) | — | ✅ | ✅ **FloatingFocusManager** |
| `ScopedAgentCapabilitiesConfig`, `ConversationAgentCapabilitiesConfig`, `InfoDetailsPopover` | ❌ **no Esc handler** | — | — | ❌ |

- [ ] Each dialog/menu closes on `Escape`.
- [ ] `ConfirmDialog`: `Enter` confirms and does not leak (it `stopImmediatePropagation`s Enter).
- [ ] `CommitDialog`: `Cmd/Ctrl`+`Enter` commits from inside the message textarea.
- [ ] `PeekPopover`: focus is trapped inside; background hotkeys do **not** fire (reference implementation — the only one that scopes correctly).
- [!] `ScopedAgentCapabilitiesConfig`, `ConversationAgentCapabilitiesConfig`, `InfoDetailsPopover`: **`Escape` does not close them at all** (no keyboard dismiss). (Finding #3)

---

## Section 8 — Workflow canvas / catalog (separate routes)

| Keys | Action | Where | Mechanism |
|---|---|---|---|
| `+` / `=` | Zoom in | catalog `/workflows/[machine]` (`WorkflowCanvasShell`) | window `keydown` (NOT registry) |
| `-` / `_` | Zoom out | same | window `keydown` |
| `0` | Reset zoom | same | window `keydown` |
| `[` | Previous workflow | same | window `keydown` |
| `]` | Next workflow | same | window `keydown` |
| `Cmd/Ctrl` + wheel | Zoom | same | non-passive wheel |
| `Delete` / `Backspace` | Delete selected node/edge | builder `/projects/[name]/workflows` (`WorkflowBuilderCanvas`, React Flow) | xyflow built-in (input-guarded) |
| `Shift` / `Space` / `Meta` | Multi-select / pan / zoom-modifier | React Flow canvases | xyflow built-ins |

- [ ] Catalog: `+`/`-`/`0` zoom and reset; `[`/`]` move between workflows.
- [ ] Builder: `Delete`/`Backspace` removes the selected context/edge, and does **NOT** fire while editing a field (xyflow guards inputs).
- [!] Catalog `+`/`-`/`0`/`[`/`]` are **window-global and undocumented** (not in the registry or Help modal), and the input guard checks `INPUT`/`TEXTAREA` but **not `contentEditable` or `SELECT`** (`WorkflowCanvasShell.tsx:326`). Test: focus a `contentEditable`/`<select>` on a catalog page (if any) and confirm these keys don't hijack. (Finding #6)
- [ ] `[`/`]` in the catalog do not conflict with the diff `[`/`]` (different routes) — confirm they never co-mount.
- [!] Session-workflow route: opening a task transcript (`WorkflowConversationViewer`) activates `j`/`k`/`Home`/`End`; pressing `j`/`k` while a background execution-panel button is focused scrolls the transcript. Confirm acceptable. (Finding #8)

---

## Section 9 — Cross-cutting scope tests (the most important checks)

These verify Alex's two rules directly. Run each on the **session page** (richest hotkey set: `?`, `b`, `j`, `k`, `n`, `]`, `[`, `Shift`+`D`).

**Rule 1 — text entry must not be disrupted:**
- [ ] In the prompt editor, type a sentence containing `j k b n ? [ ]` — every character appears; no page action fires.
- [ ] In the sidebar search box and command console, the same — letters type normally.
- [ ] `Home`/`End` in any input move the caret (not the message list).

**Rule 2 — when a modal is open, only its keys work:**
For EACH modal/drawer/menu in Section 7, open it, click a button inside it (so focus is on a non-form element), then press `?`, `b`, `j`, `k`, `n` and confirm **nothing happens in the background**:
- [!] `ConfirmDialog` — currently leaks (`b`/`j`/`?` act behind it).
- [!] `SmartMergeDialog` — currently leaks (nothing is focused on open → all single-key hotkeys fire).
- [!] `CommitDialog` — leaks once focus moves off the textarea to a button; also leaks `Alt`+`V`/`Cmd`+`K` from inside the textarea.
- [!] `McpServersModal` / `McpConfigPopover` / `DevServerDrawer` — leak (only Esc handled).
- [!] `HotkeyHelpModal` — leaks every key except Esc (e.g. `j`/`k` scroll the conversation behind the shortcuts overlay).
- [!] `BulkConfirmModal`, `MobileActionMenu`, `MermaidDiagram` fullscreen, all dropdown menus — leak.
- [ ] `PeekPopover` — does **not** leak (focus trapped). This is the target behavior for all of the above.

---

## Implementation status (resolved 2026-06-01)

All findings below have been addressed. Summary of what shipped:

- **#1 / #2 (scope leak, `?` stacking):** Added a global overlay-scope counter (`src/stores/overlay-scope.store.ts`) consumed by `useAppHotkey` — every page hotkey is disabled while any overlay is open. All 21 overlays register via the `useOverlayScope(open)` hook (`src/hooks/useOverlayScope.ts`). Overlay-owned hotkeys opt out with `keepActiveInOverlay` (only `CreateSessionModal`'s voice toggle).
- **#3 (no keyboard dismiss):** The two AgentCapabilities drawers + pinned `InfoDetailsPopover` now close on Escape via `useOverlayScope(open, { onEscape })`.
- **#4 (`Shift+B` dead):** Wired to the unified panel via `GlobalActivePanelHotkey` (`RootLayout`).
- **#5 (`mod+k` duplicate):** Documented in the registry + regression test asserting no unexpected duplicate key bindings.
- **#6 (canvas keys):** `WorkflowCanvasShell` now guards with the shared `isEditableTarget` (covers contentEditable/`<select>`) and suppresses while an overlay is open; `ConversationSidebar` reuses the same helper.
- **#7 (slash Escape / inconsistency):** Resolved by removing dead code — the clearing behavior lived only in the unused `CommandAutocomplete` component (now deleted). The live slash popup (`PromptEditorSlashCommandPopup`) already closes-without-clearing and `stopPropagation`s Escape. Arrow/Enter/Tab `stopPropagation` hardening was intentionally **not** added (zero current value; live popups already coordinate Escape correctly).
- **#8:** Accepted as a deliberate, low-risk decision (transcript nav); overlay gating now also suppresses it under modals.
- **#9:** `MermaidDiagram` Space now `preventDefault`s; `BulkConfirmModal`'s Escape stays additive (its leak is fixed by the counter).
- **#10:** Dead `MergeDialog` deleted; dead `CommandAutocomplete` deleted.

The original findings (with `path:line` references as discovered) are preserved below for context.

## Findings & Recommendations

Ranked by impact. File references are `path:line`.

### Finding #1 — No modal/scope isolation; background hotkeys leak (High, architectural)
The registry uses **no `react-hotkeys-hook` scopes** and there is **no `HotkeysProvider`** (`src/hooks/useAppHotkey.ts:13`). Modals only intercept `Escape` (and occasionally `Enter`); every other key propagates to the global bubble-phase handlers. Because most single-key hotkeys are not `enableOnFormTags`, they are suppressed only while a **form field** is focused — but modal focus typically lands on a **button** (or nothing), so `?`, `b`, `j`, `k`, `n`, `]`, `[`, `Shift`+`D`, `Shift`+`B` fire in the background. ~13 of 14 modals/drawers leak; only `PeekPopover` (`src/features/session/sidebar/PeekPopover.tsx:364-366`, `@floating-ui/react` `FloatingFocusManager` + `useDismiss`) scopes correctly.

This violates the rule "when a modal is open, only that modal's hotkeys should be active."

**Recommended fix (pick one, in order of robustness):**
1. Introduce a `HotkeysProvider`, give page hotkeys a scope (e.g. `"page"`), and have a shared modal primitive `disableScope("page")` on open / re-enable on close. This is the clean, library-blessed fix and also future-proofs scoping.
2. Or add a global "modal open" signal (Zustand) and thread it into every page hotkey's `enabled`.
3. Or adopt the `PeekPopover` pattern (`@floating-ui/react` `FloatingFocusManager`) as a shared modal wrapper so focus is trapped — form/contentEditable suppression then covers most keys, plus a capture-phase swallow for the form-enabled ones (`Alt`+`V`, `Cmd`+`K`, `Cmd`+`N`).

The per-modal manual `Escape` listeners are acceptable as a mechanism, but they should consistently `stopPropagation()` and ideally trap focus.

### Finding #2 — `?` Help modal stacks over open modals (High, UX; subset of #1)
`helpModal` is global (`GlobalHotkeyHelp` in `RootLayout.tsx:78`) and unsuppressed, so `?` opens the Help modal on top of any other modal, and `j`/`k` scroll the conversation behind the Help modal itself. Fixed by #1.

### Finding #3 — Three dialogs have no keyboard dismiss (Medium, a11y + scope)
`ScopedAgentCapabilitiesConfig`, `ConversationAgentCapabilitiesConfig`, and `InfoDetailsPopover` (all `role="dialog"`) have **no `Escape` handler** and no focus management — they cannot be dismissed by keyboard and they leak all globals. Add `Escape` to close and adopt the shared scoping from #1.

### Finding #4 — `toggleActivePanel` (`Shift`+`B`) is a dead registry entry (Medium)
Defined at `src/lib/shared/hotkeys.ts:69-75` but has **no `useAppHotkey` call site** (grep: only the registry references it). It is nonetheless rendered in the Help modal, advertising a non-functional shortcut. Either wire it up (the "active conversations" panel exists) or remove the registry entry.

### Finding #5 — Duplicate `Cmd/Ctrl`+`K` binding (Medium)
`focusSidebarSearch` and `focusCommandConsole` both bind `mod+k` (`hotkeys.ts:84-92` and `:158-166`), both global, both `enableOnFormTags`, no scopes. They live on different routes today, so only one mounts at a time — but the binding is fragile and the Help modal lists `Cmd K` twice with different labels. Confirm they never co-mount; consider scoping (#1) or distinct keys.

### Finding #6 — Undocumented, window-global canvas shortcuts (Medium)
`WorkflowCanvasShell.tsx:323-362` binds `+`/`=`/`-`/`_`/`0`/`[`/`]` on `window` with an input guard that misses `contentEditable` and `<select>` (line 326), and `[`/`]` duplicate the diff-nav semantics outside the registry. They are invisible to the Help modal. Recommend: move into the registry (for discoverability + consistent suppression) and scope to a focusable canvas surface, or at minimum extend the guard to the `isInputDOMNode` equivalent (cover `contentEditable`/`SELECT`).

### Finding #7 — Inconsistent `Escape` semantics & isolation (Low)
- Only `HotkeyHelpModal` (`HotkeyHelpModal.tsx:50`) and `McpServersModal` (`McpServersModal.tsx:49`) use capture-phase + `stopPropagation` to keep `Escape` from also triggering the global `clearInput`. Other dialogs let `Escape` bubble; mostly benign because `clearInput` self-guards on prompt focus, but it's a latent bug when a dialog contains a focused input.
- The slash autocomplete's `Escape` clears the **entire prompt** (`CommandAutocomplete`), while the `@` file autocomplete only closes. Align these.
- The rename inputs (`ConversationList.tsx:444`, `ConversationSidebar.tsx:515`) correctly `stopPropagation()` on `Escape` — use them as the model.

### Finding #8 — Conversation-nav leak into workflow execution UI (Low)
`WorkflowConversationViewer` registers `j`/`k`/`Home`/`End` via `useConversationNav` (`WorkflowConversationViewer.tsx:58`). While a transcript is open, those keys fire even when a surrounding execution-panel button is focused. Read-only and harmless, but technically a scope leak; would be resolved by ref/scope-bounding the nav hook.

### Finding #9 — Minor correctness nits (Low)
- `MermaidDiagram` inline trigger fires on `Space` without `preventDefault` (`MermaidDiagram.tsx:104`) → page scrolls when activating with Space. Add `e.preventDefault()` for `role="button"`.
- `BulkConfirmModal` registers its `Escape` listener in **capture** phase but gains nothing (no `stopPropagation`, no `Enter` handling) — could be bubble.
- Latent fragility: editor autocomplete popups only `preventDefault` (not `stopPropagation`) for `Enter`/`Tab`/arrows. They're safe only because the registry binds none of those with `enableOnContentEditable`. Document this invariant, or have popups `stopPropagation` on every consumed key.

### Finding #10 — Dead component (cleanup, not a hotkey bug)
`src/features/session/dialogs/MergeDialog.tsx` is imported only by its own stories file; production uses `SmartMergeDialog`. Don't spend modal-scoping effort on it — delete or confirm intent.

### What is implemented correctly (no change needed)
- **Tiptap/ProseMirror editor keymaps** and **autocomplete popups** — correctly editor-scoped; suppressing page hotkeys via `contentEditable`; popup `Escape` hardened with `stopPropagation`. Good reason not to use `react-hotkeys-hook`.
- **React Flow canvases** (`WorkflowBuilderCanvas`) — delegate Delete/select/pan to xyflow, which guards form/contentEditable focus at the library level. Correct.
- **ARIA widget activation** (`ConfigToggle`, `McpServerCard` switch, task/event rows) — `Enter`/`Space` via `onKeyDown` with `preventDefault`; element-scoped. Correct (these should NOT be `react-hotkeys-hook`).
- **Rename inputs** — `Enter` submit / `Escape` cancel with `stopPropagation`. Correct.
- **`PeekPopover`** — the one fully-scoped overlay (focus trap + dismiss). Use as the template for the #1 fix.
