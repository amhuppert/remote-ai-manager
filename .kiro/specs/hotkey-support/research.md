# Research and Design Decisions

## Summary

- **Feature:** `hotkey-support`
- **Scope:** Expand and redesign the existing shortcut system across global,
  session, project, ticket, workflow, conversation, and diff contexts.
- **Primary finding:** Per-component key matching cannot reliably provide
  contextual leaders, prompt-focused one-shot activation, overlay precedence,
  duplicate detection, and a context-aware launcher. CC needs a small central
  dispatcher with feature-owned callback registration.
- **Ergonomics finding:** Common operations fit three mnemonic families:
  `G` for go/navigation, `C` for create, and `V` for views. High-frequency local
  actions remain single keys.
- **Conflict finding:** App-level browser-native `Mod` shortcuts and new `Alt`
  bindings should be avoided. The user explicitly chose to retain the full
  prompt-focused readline set, including its Windows/Linux browser overlaps,
  and adjust AeroSpace for its `Alt+F` conflict.

## Existing-Application Review

The implementation review found several categories of keyboard behavior:

1. Prompt-native controls already implemented by the editor extension:
   `Mod+Enter`, `Ctrl+A/E/U/K/W`, and `Alt+B/F/D`.
2. Existing app shortcuts distributed across mounted features, including
   message and diff navigation, sidebar control, voice, thinking expansion, and
   developer controls.
3. Common actions with mouse affordances but no coherent keyboard path:
   global/project navigation, creating sessions/conversations/workflows,
   switching workspace views, selecting open conversations, contextual search,
   focusing the prompt, quick ticket capture, panes, and closing the active
   conversation tab.
4. Low-frequency actions whose direct key cost exceeded their value: clear
   prompt, developer tools, and exit panes.

The action implementations already lived in their domain components and stores.
The feature therefore needed a dispatch and registration layer, not a central
domain-action service.

## Shortcut Inventory Decisions

### Added or Standardized

| Task family | Decision |
|---|---|
| Discoverability | `?` opens help; `.` opens a searchable command launcher |
| Global/project navigation | `G H/P/S/C/T/R/A` |
| Open-conversation navigation | `G 1` … `G 9`, `G J`, `G K` |
| Creation | `C S/C/W/T` |
| Workspace views | `V V/C/D/O/A/S/R/P`; project `V S/C`; tickets `V B/L` |
| Local focus | `I` focuses the composer; `/` focuses contextual search |
| Conversation tab close | `X`, with safe neighbor selection and draft handling |
| Prompt access to app commands | Literal `Ctrl+;` arms one complete shortcut |

### Retained

| Behavior | Decision |
|---|---|
| Message movement | Keep `J`/`K`; use `G G` and `Shift+G` for first/latest |
| Sidebar | Keep `B` |
| Diff review | Keep `[`/`]` and `N`/`Shift+N` |
| Thinking blocks | Keep exact `Shift+E` expand-all and `Shift+C` collapse-all |
| Prompt editing | Keep `Ctrl+A/E/U/K/W` and `Alt+B/F/D` |
| Prompt submit | Keep `Mod+Enter` |
| Contextual search | Keep `/`; it intentionally shadows Firefox Quick Find only when app shortcuts are eligible, while `Mod+F` remains native |

### Reassigned or Moved to the Launcher

| Previous approach | Current decision | Reason |
|---|---|---|
| `Alt+V` voice toggle | `Ctrl+Shift+.` | Avoid a new app-level `Alt` conflict and pair voice with stop |
| Home/End message boundaries | `G G` / `Shift+G` | Preserve native caret and page navigation |
| Direct clear-prompt shortcut | Launcher only | Destructive and infrequent |
| Direct developer-tools shortcut | Launcher only | Development-only and infrequent |
| Direct exit-panes shortcut | Launcher only | Contextual and infrequent; `V P` enters panes |
| Browser-like modified tab close | `X` | Avoid stealing `Mod+W` from the browser |

## Architecture Evaluation

| Option | Strengths | Limitations | Outcome |
|---|---|---|---|
| Direct `react-hotkeys-hook` in each component | Small local diff; library handles basic combos | No single arbitration point; difficult exact fallthrough, prompt one-shot, contextual duplicates, and overlay precedence | Superseded |
| One global component containing every action | Central event control | Couples root UI to every feature and requires prop drilling/store reach-through | Rejected |
| Central dispatcher plus feature registration | One keyboard state machine; actions stay in domain; shared availability powers help/launcher | Requires a small custom matcher and registration lifecycle | Selected |

The selected approach separates deterministic keyboard mechanics from feature
judgment:

- the catalog parses keys and supplies metadata;
- the dispatcher matches sequences and resolves registrations;
- the provider supplies DOM context and lifecycle cancellation;
- mounted features own callbacks and availability;
- discovery surfaces query the dispatcher.

`react-hotkeys-hook` was useful for the initial implementation, but it is not
the runtime engine for the enhanced system.

## Sequence Semantics Research

### Normal Leaders

A one-second timeout gives ordinary `G`, `C`, and `V` sequences enough time to
remain comfortable without leaving CC visibly stuck in a leader state. A prefix
is consumed only if it can begin an available command. An invalid final stroke
is not consumed, allowing browser or page behavior to continue.

This availability-first rule matters for numbered tabs: `G 8` must not reserve
`8` when only three tabs exist.

### Prompt One-Shot

Ordinary single-letter and leader shortcuts must remain disabled while editing.
A dedicated one-shot activation avoids a mode toggle and avoids requiring the
user to blur the prompt:

- literal `Ctrl+;` arms one command;
- no timeout is used because prompt composition can involve pauses;
- both activation keys must be released before the next stroke is accepted;
- direct keys and leader sequences share the normal catalog;
- invalid input cancels and falls through;
- `Escape` and repeated activation explicitly cancel;
- prompt identity ties the state to the originating editor.

The release guard is required because browsers can emit another keydown while
Control or semicolon remains depressed. Without it, the activation itself can
be misread as the first armed stroke.

### Contextual Reuse

`V S` has two meanings that are never valid simultaneously:

- session workspace: specs;
- project workspace: sessions.

Availability-based matching permits this ergonomic reuse. The dispatcher still
fails closed if two eligible registrations appear, converting a mounting or
scope defect into a logged no-op rather than an unpredictable action.

## Conflict Review

### Browser and Operating System

The review treated these common browser/OS families as reserved:

- `Mod+T`, `Mod+W`, `Mod+N`, `Mod+L`;
- `Mod+R`, `Mod+P`, `Mod+S`, `Mod+F`;
- `Mod+H`, `Mod+J`, `Mod+D`;
- `Mod+1` … `Mod+9`;
- OS app switching, launchers, and workspace controls.

CC avoids these with unmodified local keys and mnemonic leaders. The explicit
exception is the prompt editor's literal readline set:
`Ctrl+A/E/U/K/W` and `Alt+B/F/D`. On Windows/Linux, this can shadow browser
actions such as close tab, address/search, view source, or the browser menu,
but only while the prompt handles the applicable editing key. `Mod+Enter`
remains a prompt-native submit convention rather than a global app command.

### AeroSpace

The user's AeroSpace configuration was considered as part of the conflict
review. Its `Alt+F` mapping overlaps readline forward-word motion. The user
chose to adjust AeroSpace rather than change the editing binding. No app
command outside the prompt-native readline set uses `Alt`.

### Editable Fields and Overlays

Single keys and leaders are unsafe in text fields, so ordinary matching excludes
them whenever an input, textarea, select, contenteditable, or textbox role has
focus. Only the catalog entries explicitly allowed in editables—stop and
voice—remain directly active.

Dialogs, popovers, menus, and similar overlays have stronger keyboard ownership
than background app commands. Overlay state cancels pending sequences and
suppresses background dispatch, leaving Escape, arrows, Enter, Tab, and typing
to the active overlay. An overlay-local command may remain eligible only while
its owning control is focused; this permits voice input in prompt surfaces that
are themselves rendered inside a dialog.

## Close-Tab Research

Session and project working sets have different persistence risks but should
share selection behavior. The chosen neighbor rule is:

1. select the previous tab;
2. if none, select the next tab;
3. if none, enter the explicit empty state.

Project conversation drafts previously needed stronger isolation for safe
keyboard close. Drafts are now keyed by conversation ID, including images.
A non-empty draft requires confirmation. The project store captures exact tab
ordering and focus before optimistic removal so an API failure can restore the
same UI and draft rather than merely reopening the conversation at a different
position.

## Discovery Research

A static shortcut list would incorrectly imply that every command is usable
everywhere. The dispatcher already knows registration and availability, so help
and launcher should consume that runtime view:

- “Available here” teaches the active surface;
- “All commands” is the complete reference and labels unavailable entries;
- launcher search includes only executable commands;
- keyless commands remain fully keyboard accessible;
- prompt-native readline bindings appear in the complete reference even though
  they are not dispatcher commands.

## Historical Note

The first version of this specification selected a per-component
`react-hotkeys-hook` wrapper, declared sequences and provider scopes out of
scope, used `Alt+V` for voice, and used Home/End for message boundaries. That
design was appropriate for the original 11-shortcut scope but is superseded by
the approved enhanced-hotkey requirements. It is retained here only as design
history; the current behavior is defined by `requirements.md`, `design.md`, and
`src/lib/shared/hotkeys.ts`.

## References

- `src/lib/shared/hotkeys.ts` — authoritative catalog and display helpers
- `src/lib/hotkeys/dispatcher.ts` — matching and state semantics
- `src/components/hotkeys/HotkeyProvider.tsx` — DOM context and lifecycle
- `src/lib/prompt-editor/terminal-hotkeys-extension.ts` — readline editing
- [MDN: KeyboardEvent.key](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key)
- [WAI-ARIA APG: Dialog Modal Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [WAI-ARIA APG: Combobox Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
