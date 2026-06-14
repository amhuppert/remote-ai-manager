# Command Center — Multi-tasking UI Spec

> Status: **design spec** · Source of truth: `Command Center.html` prototype in this project
>
> This document describes UI changes that overhaul the Command Center conversation page to make managing multiple agents — across multiple projects and sessions — fast and low-friction. It is written so that another agent or engineer can implement the changes end-to-end.

---

## 1. Goals & Non-goals

### Goals

1. **Minimize the cost of human context switching** between conversations. The user is the bottleneck, not the agents; every interaction should be optimized for the smallest possible time-to-triage and time-to-respond.
2. **Bring an overview of all active work into the conversation page itself.** The user should rarely need to navigate to the project or session screens just to find out what's happening elsewhere.
3. **Prioritize "respond without leaving" over "be aware without leaving"** — both matter, but responding to an agent is the higher-leverage user action.
4. **Make the active destination of a prompt unmistakable** when multiple conversations are visible at once.
5. **Stay inside the existing Ground Control visual language** — dark theme, cyan accents, monospaced labels, canonical pill tabs / badges / section headers from the design-system-revamp spec.

### Non-goals

- Changing how agents themselves execute, merge, or run in parallel. This is purely UI/UX over the existing state.
- Multi-host or remote sessions. Single user, single host.
- A separate "fleet event ticker" or sticky-mode peek popover (explicitly deferred).

---

## 2. Data model

Existing Command Center hierarchy: **Project › Session › Conversation**.

- A **project** is a git repository.
- A **session** corresponds to one worktree (and one branch).
- A **session** can hold **multiple conversations**, all sharing the worktree.
- Treat each conversation as having a single agent for the purposes of this UI (siblings from parallel-execution-contexts are summarized into one signal on the row, see §3.1).

Each conversation has at minimum:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable id |
| `project` | string | Project name |
| `session` | string | Session name (worktree slug) |
| `branch` | string | Branch name |
| `title` | string | Human-readable conversation title |
| `status` | enum | `new` · `running` · `awaiting` · `waiting_for_input` (mirrors the shipped `activeConversationSchema.status`) |
| `statusLine` | string | One-line, agent-generated "what it's doing now" |
| `currentTool` | string? | Last/active tool name (`Edit`, `Bash`, `Write`, …) |
| `awaitingQuestion` | string? | The exact question the agent is asking, when `status === "waiting_for_input"` (maps to the prod `pendingQuestion` field) |
| `lastUpdated` | timestamp | For sorting / time-ago display |
| `siblings` | `{total, merged}` | Parallel sibling-agents progress for this conversation |
| `activity` | number[30] | 30-bucket activity histogram, ~most recent 30 minutes |

`diff` is intentionally **not** surfaced on sidebar rows — it lives on the conversation's info-strip where it belongs.

---

## 3. UI features

The major new surfaces, in order of impact:

1. Enriched Active Conversations sidebar
2. Right-click context menu on sidebar rows
3. Peek-and-reply popover
4. Tabs strip above the conversation pane
5. Panes mode (a new layout that replaces both Split and Bridge — see §3.5)
6. Single global composer pinned to the bottom of the screen
7. Active-pane fading on composer focus
8. Pane + tab caps with disabled controls and tooltips

### 3.1 Enriched Active Conversations sidebar

**Purpose:** transform the sidebar from a list-of-titles into a glanceable triage surface. Each row should carry enough signal that the user can decide *which* conversation to interact with without opening anything.

#### Row anatomy

```
┌─────────────────────────────────────────┐
│ ● Multi-tasking UI improvements    now  │  ← status dot + title + time-ago
│ ⌬ multitasking-ui                       │  ← session chip (icon + name)
│ Edit › Drafting peek popover layout…    │  ← status line; prefixed with tool name
│ ⌬ 2/3      ╱│╲╱│╲╲│╲╲╱│╲                │  ← sibling agents progress + sparkline
└─────────────────────────────────────────┘
```

| Element | Behavior |
|---|---|
| **Status dot** | Color = status. `running` pulses cyan; `waiting_for_input` glows amber; `awaiting` (ready / paused) solid green; `new` muted blue. These four are the authoritative status set — see §2. |
| **Title** | Conversation title, single-line ellipsis. |
| **Time-ago** | Compact (`now`, `4m`, `2h`). |
| **Session chip** | Branch icon + session name, monospace, tertiary color. Only shown when **Group by = Project** (when grouping by session, the section header already names the session). |
| **Status line** | Agent-generated. Prefixed with the current tool name and a `›` separator for running conversations, or `Asks ›` for `waiting_for_input`. Hidden in `compact` density. |
| **Siblings** | `m/n` where `m` = merged siblings, `n` = total parallel siblings. Only shown when `total > 1`. |
| **Sparkline** | 30-bucket activity histogram, cyan polyline + last-point dot. Muted gray dashed line for idle/done conversations. Hidden in `compact` density. |

#### Filters

A row of pill filters under the title: **All · Needs · Run · Session**.

- **All** — every active conversation
- **Needs** — `waiting_for_input` only (the conversations actually blocked on you)
- **Run** — `running` only
- **Session** — only conversations sharing the active conversation's session. This is the answer to "show me everything happening in my current worktree."

Each pill shows a count badge. Tooltips clarify each filter's scope.

#### Grouping

A two-segment **Group by: Project / Session** switch lives in its own row beneath the filter pills. Mirrors the Tweaks-panel value.

- **Project grouping** (default) — section header per project, large mono-uppercase label.
- **Session grouping** — section header reads `creative-ai / streaming-chat`, with the project name in `--text-secondary` and the session name in `--text-primary`, so the hierarchy reads project › session.

Counts in section headers use `--text-secondary` at full opacity (not decorative chrome).

#### Same-session adjacency

Regardless of the active group, **conversations sharing a session are always rendered adjacent**, and tied together by a 1px left-edge connector line. Conversations within a session group are marked `session-first`, `session-mid`, `session-last`, or `session-only` for connector rendering.

#### Needs-you pile

When the **All** filter is active and `showNeedsYou` is on, any `waiting_for_input` conversations are pulled into a **Needs you** section pinned to the top, with amber section-header tinting. Within that section, same-session clustering still applies.

#### Search

A compact search field above the filters; live filters by title, project, or session name (case-insensitive). `⌘K` shortcut hint shown on the right.

---

### 3.2 Right-click context menu on sidebar rows

Custom (not native) context menu. Items:

```
Open conversation                    ↵
Pin as tab                           ⌘T
Peek
──────
Filter sidebar to session: <name>
Open project page
Copy branch name
──────
Rename…
Archive
──────
Delete conversation…                  (danger)
```

- "Pin as tab" disables (label: `Already a tab`) when already in the tab strip, and (label: `Tab limit reached (6)`) when the cap is hit.
- Esc or outside-click dismisses. Repositions automatically to avoid clipping at viewport edges.
- The danger item (Delete) is styled with red text and red glow on hover.

---

### 3.3 Peek-and-reply popover

**Purpose:** let the user respond to or check in on any conversation **without leaving** the current one.

#### Trigger

- **Click** on a sidebar row (except the current conversation). Hover-to-peek is intentionally NOT supported.

#### Layout

A 460×620 floating panel anchored to the right of the clicked row. Auto-repositions to stay on-screen. A dim, slightly blurred backdrop covers everything else.

```
┌────────────────────────────────────────────────────┐
│ ● Migrate analytics to Posthog  [Open conversation]│  ← header
│   WAITING · creative-ai · ⌬ posthog-migrate · 12m │
├────────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────────┐ │
│ │ AGENT IS ASKING                                │ │  ← amber banner
│ │ "Should I delete the legacy mixpanel events…?" │ │     when awaiting
│ └────────────────────────────────────────────────┘ │
│                                                    │
│ You: Replace mixpanel `track()` calls with         │  ← last ~5 messages,
│      Posthog…                                      │     compact transcript
│ CC:  Going through `analytics/` — I'll preserve…   │
│ CC:  Done with the main pass — 47 call sites…      │
│                                                    │
├────────────────────────────────────────────────────┤
│ [Yes, proceed] [No, ask first] [Tell me more]      │  ← quick replies
│ ┌────────────────────────────────────────────────┐ │
│ │ Answer the agent — ⌘⏎ to send                  │ │
│ │                                                │ │
│ └────────────────────────────────────────────────┘ │
│ esc close  ⌘T pin as tab               [Send ⌘⏎]   │
└────────────────────────────────────────────────────┘
```

#### Behavior

- **Open conversation** button (cyan-tinted primary) in the header — single most prominent action. Pins as a tab AND navigates.
- **Amber banner** at the top of the body when the agent is `waiting_for_input`. Bullets the question (`awaitingQuestion`) prominently.
- **Quick-reply chips** above the textarea, status-aware (these match the shipped `QUICK_REPLIES` map in `peek.jsx`):
  - `waiting_for_input` → Yes, proceed · No, ask first · Tell me more
  - `running` → Status? · Pause · Speed up
  - `awaiting` → Continue · Summarize · Next task
  - `new` → Kick off · Outline plan first · Hold
  - Drive the chip set through a `status → replies` lookup with a safe fallback so any status added later degrades gracefully. A red error banner + `failed`/`done` chip sets are deferred until those states exist in `activeConversationSchema` (§2).
- **Esc** closes. **⌘T** pins as tab (works while peek is open). **⌘⏎** sends.

---

### 3.4 Tabs strip above the conversation pane

**Purpose:** persistent slot for the small set of conversations the user is actively juggling. Browser-tab metaphor. Different intent than the sidebar (which lists *all* active conversations).

#### Layout

A 36px-tall horizontal strip above the conversation pane. Each tab shows:

- Status dot
- Conversation title (ellipsized, max 240px)
- `⌘N` hotkey hint for the first 9 tabs
- × close button (revealed on hover or when active)
- Active tab has a 2px top cyan stripe and brighter background

A `+` button at the right end opens a picker to add another tab.

#### Behavior

- **⌘1..9** activates that tab.
- **Click** activates a tab; **×** closes (does NOT stop the agent, just removes from the strip).
- Closing the current tab activates the next one in the strip.
- Tabs and panes **share the same juggled set** (see §3.5). Adding/closing in one is reflected in the other.

---

### 3.5 Panes mode

**Purpose:** a new layout that **replaces the Split layout** and adds a multi-conversation view. The conceptual unification: Split and the multi-pane "Bridge" idea collapse into one mode with adaptive per-tile density.

#### Activation

A new 5th icon in the topbar layout switcher (after `conversation-only`, `default`, `split`, before `diff-only`). The 4 standard layouts continue to apply when **not** in Panes mode.

#### Grid shapes

The grid shape adapts to the pane count:

| N panes | Shape | Notes |
|---|---|---|
| 1 | 1×1 | full cockpit |
| 2 | 2×1 | full cockpit per pane |
| 3 | 3×1 | full cockpit per pane |
| 4 | 2×2 | compact |
| 5 | **asymmetric** | 3 panes on top row (1/3 each) + 2 panes on bottom (1/2 each) — implemented via a 6-column grid where top panes span 2 and bottom panes span 3 |
| 6 | 3×2 | compact |

There is **no inline "Add pane" tile** — Add lives in the panes toolbar (§3.5.3).

#### Per-pane content

Each pane is a fully interactive mini-cockpit:

```
┌────────────────────────────────────────┐
│ ● Title                  [↗] [×]       │  ← head: status dot, title, open-full, close
│ RUNNING · project / session     · 4m   │  ← meta: status, project/session, time
│ [Edit chip] Status line…               │  ← current tool chip + statusLine
│                                        │
│ ┌────────────────────────────────────┐ │
│ │ AGENT IS ASKING  (amber banner)    │ │  ← if status=awaiting; or FAILED
│ │ <question>                         │ │     (red) if status=failed
│ └────────────────────────────────────┘ │
│                                        │
│ + 8 earlier messages                   │  ← collapse summary
│ You: …                                 │  ← last 2-4 messages,
│ CC:  …  [Edit · src/foo.ts]            │     tool calls inlined
└────────────────────────────────────────┘
```

- 2 panes → 4 visible messages, full type
- 3+ panes → 2 visible messages, compact type
- **No per-pane composer.** Replies go through the single global composer (§3.6) which routes to the active pane.

#### Adding panes / Pane toolbar

A toolbar at the top of the panes section:

```
4 / 6 panes   Click a pane to focus · ⌘1–4 to swap focus       [+ Add pane] [Exit panes esc]
```

- The **Add pane** button opens a dropdown listing all active conversations not yet in panes. Each item is a button with status dot, title, project. Clicking adds and focuses that pane.
- When the cap is hit (6), the button is disabled with the tooltip `"Pane limit reached (6) — close a pane first"`.

#### Active pane indicator

- **Cyan ring** drawn outside the active pane via `box-shadow: 0 0 0 2px var(--cyan), 0 0 16px var(--cyan-glow-strong), inset 0 0 24px var(--cyan-glow)`. The grid container has 2px of padding so the ring is never clipped. The ring wraps the entire pane (header through bottom edge) and is not occluded by the inner scrollbar.
- Clicking a non-active pane makes it active.
- The active pane is **the same conversation as the current tab** when you switch back to default layout — they share state.

#### Visual separator (configurable)

Panes are separated by raised-card shadows by default:

| `paneSeparator` value | Look |
|---|---|
| `shadow` (default) | 8px void gutter + 1px outline + 2px 8px outer shadow on each inactive pane — reads as physical raised cards |
| `ring` | 6px void gutter + 1.5px `--border-strong` outline on each inactive pane |
| `gap` | 6px void gutter, no per-pane outline |
| `hairline` | 1px gap, original look |

CSS variables (`--pane-gap`, `--pane-pad`, `--pane-grid-bg`) coordinate the gutter, padding, and grid background so all four variants stay visually consistent.

---

### 3.6 Single global composer (pinned bottom)

**Purpose:** one prompt input for the whole session, always visible, with the destination conversation unmistakable.

#### Position

Pinned to the bottom of the screen, full width of the main content column (sidebar continues full-height to its left). Sits **below** the content area in both default and Panes layouts.

#### Header

A "Send to" label clarifies the destination:

```
SEND TO  ● Multi-tasking UI improvements   ground-control-ui / multitasking-ui
```

- The dot uses the active conversation's status color.
- Project in `--text-secondary`, session in `--text-primary`, separator dimmed.

#### Controls row (in order)

| Control | Behavior |
|---|---|
| Attach image | Paperclip icon button |
| **Backend** | Segmented two-option: **Claude · Codex**. Switching backend auto-resets `model` to the new backend's default. |
| **Model** | Dropdown. Options depend on backend (`Opus/Sonnet/Haiku` for Claude; `GPT-5/GPT-5 mini/o3` for Codex). |
| **Effort** | Dropdown with `Min/Low/Med/High/XHigh`. Amber accent so it stands out at a glance. |
| **Debug** | Chip toggle. Violet glow when active. |
| **MCP** | Chip showing `MCP · 4/4` (enabled servers). Tooltip lists status. |
| **Send** | Cyan button on the far right. ⌘⏎. Disabled when textarea is empty. |

Use `onMouseDown` preventDefault on the control buttons so clicking them doesn't steal focus from the textarea — the composer-focused state (§3.7) needs to stay sticky while the user adjusts model/effort/debug.

#### Behavior

- Submitting sends the prompt to the currently **active conversation** (current pane in Panes mode, current tab/conversation otherwise).
- ⌘⏎ submits; Enter inserts newline.
- The composer is **not** rendered per-pane in Panes mode. Per-pane composers are removed.

---

### 3.7 Active-pane fading on composer focus

**Purpose:** when the user is about to send a prompt, the destination conversation must be unmistakable.

#### Trigger

The composer textarea has focus.

#### Effect (in Panes mode only)

- The panes section gains `data-composer-focused="true"`.
- **Inactive panes** fade to `opacity: 0.4` with a 180ms transition.
- The **active pane** stays at full opacity and gets a stronger outer cyan ring + glow.
- When focus is lost, both effects revert smoothly.

In default layout (single conversation visible), the focus has no fade effect — there's nothing to fade.

---

### 3.8 Pane + tab caps

Both panes and tabs are hard-capped at **6**. Beyond 6, the screen and the user's attention budget are not respected.

| Cap exceeded | Affordance | Tooltip |
|---|---|---|
| Tabs == 6 and user tries `+` button at end of tab strip | Button disabled (45% opacity, mono color) | `Tab limit reached (6) — close a tab first` |
| Tabs == 6 and user opens right-click context menu | "Pin as tab" item disabled, label reads `Tab limit reached (6)` | n/a |
| Panes == 6 and user clicks "Add pane" | Button disabled, dashed border, 50% opacity | `Pane limit reached (6) — close a pane first` |
| Panes == 6 and user clicks add-pane menu items | Picker never opens — button is the gate | n/a |

The panes toolbar counter shows `N / 6 panes` so the limit is visible at a glance.

---

## 4. Layout & shell

The top-level shell is a CSS grid:

```
┌──────────────── topbar ────────────────────┐  48px
├─────────┬──────────────────────────────────┤
│         │ ┌────────────────────────────┐   │
│ sidebar │ │ content                    │   │   either:
│         │ │  ┌─────────────────┬─────┐ │   │     default: conversation + rightpane
│         │ │  │ tabs (optional) │     │ │   │     panes:   panes grid (full width)
│  308px  │ │  │ infostrip       │ diff│ │   │
│         │ │  │ transcript      │ pane│ │   │
│         │ │  └─────────────────┴─────┘ │   │
│         │ └────────────────────────────┘   │
│         │ ┌──────── global composer ───┐   │  pinned bottom
│         │ └────────────────────────────┘   │
└─────────┴──────────────────────────────────┘
```

Breakpoints:

- ≤1180px: rightpane (diff) hides; content collapses to single column.
- ≤1080px: topbar crumbs shrink.
- ≤960px: topbar status + counter hide; sidebar shrinks to 280px.

In Panes mode, `shell[data-layout="panes"]` hides `.center` and `.rightpane` and shows `.panes` in their place at full width.

---

## 5. Topbar additions

- **Fleet counter** (right of crumbs, left of layout switcher): `N running · M needs you` in mono-uppercase. Hidden below 1080px.
- **Layout switcher** gains a 5th icon for Panes (2×2 grid icon) between Split and Diff-only.

---

## 6. Behavior under reload

- Tab set and current tab persist (existing pattern).
- Layout mode persists per project/session (existing pattern).
- Filter selection in the sidebar and group-by toggle persist via the Tweaks/edit-mode rewrite block (prototype only; real impl can use localStorage or user settings).
- Composer model/effort/debug should persist per-conversation (already implied by existing per-conversation backend config — out of scope for this UI spec).

---

## 7. Keyboard shortcuts

| Combo | Action | Scope |
|---|---|---|
| `⌘1..9` | Activate tab N | Tabs strip + Panes mode |
| `⌘T` | Pin currently-peeked conversation as a tab | Peek popover open |
| `⌘⏎` | Send prompt | Composer focused |
| `⌘K` | Focus sidebar search | Anywhere (hint shown in field) |
| `Esc` | Close peek → close context menu → exit Panes mode | Top-down resolution |

---

## 8. Visual system

Follows the design-system-revamp canonical patterns in `.kiro/specs/design-system-revamp/design.md`:

- **Colors** — `--cyan` for active/`running`, `--amber` for `waiting_for_input`, `--green` for `awaiting` (ready), `--blue` for `new`, `--violet` for debug. `--red` is reserved for danger/error affordances (e.g. destructive menu items), not a conversation status in the current enum. All used at WCAG AA-passing values against `--bg-surface` and `--bg-void`.
- **Typography** — `--font-mono` (JetBrains Mono) for chrome and labels; `--font-display` (Space Grotesk) for titles; `--font-body` (Inter) for prose. 0.7rem font-size floor enforced.
- **Tabs** — pill style (`.cc-tabs` / `.cc-tab` in the design-system spec; this prototype uses the equivalent `.sidebar__filters` / `.tabs-strip`).
- **Badges** — `.cc-badge` with semantic color tiers. Status dots are intentionally not full badges — they're more compact.
- **Section headers** — `.cc-section-header` pattern: mono-uppercase, 600 weight, chevron + label + count + trailing actions.
- **Atmospheric** — radial cyan glow at the top of the page, faint violet glow at bottom right. Backdrop-filter blur on the topbar.

---

## 9. Implementation notes

### File layout (prototype)

| File | Contents |
|---|---|
| `Command Center.html` | Page shell, script loaders |
| `styles.css` | All styles (single file per design-system convention) |
| `mock-data.js` | Mock conversations + transcripts |
| `atoms.jsx` | Icons, Sparkline, status helpers |
| `sidebar.jsx` | Active Conversations panel + group-by switch |
| `context-menu.jsx` | Right-click menu |
| `peek.jsx` | Peek-and-reply popover |
| `conversation-view.jsx` | Tabs strip + InfoStrip + Transcript + RightPane (diff) |
| `panes.jsx` | Panes mode (grid, pane, add-pane button) |
| `composer.jsx` | Global composer (pinned bottom) |
| `topbar.jsx` | Topbar with layout switcher |
| `app.jsx` | Root composition, state, keyboard shortcuts, Tweaks panel |

### State that lives in `App`

```
currentId           — id of the active conversation
openTabs            — string[] of conversation ids in the tab strip, MAX 6
layout              — "convo" | "default" | "split" | "panes" | "diff"
peek                — { conv, anchor } | null
ctxMenu             — { conv, x, y } | null
sidebarFilter       — "all" | "needs" | "running" | "session"
composerFocused     — boolean
```

`openTabs` is the single source of truth for both the tab strip and the pane grid — they always render the same set.

### Critical CSS contracts

- The panes grid uses `minmax(0, 1fr)` on both axes so flex children can shrink (else messages would force the grid into overflow).
- The active pane's box-shadow is outer (not inset) and the grid has 2px padding so the ring is never clipped.
- All composer controls use `onMouseDown(e => e.preventDefault())` so clicking them doesn't steal focus from the textarea — `composerFocused` must stay sticky when the user adjusts model/effort/debug.

---

## 10. Out of scope (for this milestone)

- Fleet event ticker (cross-conversation event log)
- Sticky/PiP peek (keep peek open while editing the main conversation)
- Bulk actions on sidebar rows (multi-select → archive/abort/send)
- Saved views / custom queries
- Notification surface rework (referenced spec: `.kiro/specs/notifications/`)
