# Requirements Document

## Introduction

Operators on the Command Center `/conversations` page frequently juggle several active agent conversations at once, but the page shows only one conversation at a time (selected from the sidebar and reflected in the page URL). Every switch costs a return trip to the sidebar. Because the human is the bottleneck — not the agents — the cost of switching between and watching multiple conversations must drop to near-zero.

This feature adds two tightly-coupled capabilities to the `/conversations` page, both rendered off **one shared working set** of open conversations so they never diverge:

1. **Conversation tabs** — a browser-style tab strip above the conversation pane holding the working set, switchable by click or hotkey.
2. **Panes (split-screen) mode** — a new layout that lays the same working set out as 2–6 live, interactive mini-cockpits, so the operator can watch and triage the fleet without leaving the page.

A single prompt composer, shared across all layouts, always targets the active conversation so the destination of a reply is unmistakable.

## Boundary Context

- **In scope**: the shared open-conversations working set (ordering, cap, eviction, persistence across reloads, active selection); the conversation tab strip and its interactions; the panes layout (a new layout-switcher option, grid arrangement, per-pane mini-cockpit content, panes toolbar); the active-pane indicator and composer-focus emphasis; relocating the single prompt composer to a shared pinned position; the tab/pane keyboard shortcuts.
- **Out of scope** (consumed, not changed): the enriched Active Conversations sidebar, the peek popover, the sidebar row context menu, the conversation status data and its enum, and the composer's existing control toolbar — all already shipped. Also excluded: the separate project-cockpit conversation-tab surface (untouched); sparklines/activity histograms, a fleet event ticker, sticky/PiP peek, bulk row actions, and saved views; any per-pane composer; and any change to how agents execute, merge, or run.
- **Adjacent expectations**: this feature relies on the existing active-conversations data (including the four-value status set and the agent's pending question when a conversation is waiting for input), the existing source of a conversation's recent messages (the same data the peek popover already reads for non-active conversations), the existing layout switcher and its layout set, and URL-based conversation selection. It does not own or modify those systems.

## Requirements

### Requirement 1: Shared open-conversations working set

**Objective:** As an operator juggling multiple conversations, I want one working set of open conversations that backs both the tabs and the panes, so that the two views never diverge and I keep my context when switching layouts.

#### Acceptance Criteria

1. The Conversations Page shall maintain an ordered working set of open conversations that is the single source of truth for both the tab strip and the panes layout.
2. The Conversations Page shall treat the conversation identified in the page URL as the active conversation, and shall keep exactly one conversation in the working set marked active at any time.
3. When the user opens a conversation from the sidebar, the Conversations Page shall add that conversation to the working set if it is not already present and make it the active conversation.
4. When the user navigates to a conversation URL whose conversation is not in the working set, the Conversations Page shall add it to the working set and make it the active conversation.
5. The Conversations Page shall limit the working set to a maximum of 6 conversations.
6. When the user opens a conversation while the working set already holds 6 conversations, the Conversations Page shall remove the least-recently-active non-active conversation from the working set before adding the newly opened conversation.
7. If a conversation in the working set is no longer an active conversation in the system, then the Conversations Page shall remove it from the working set.
8. The Conversations Page shall persist the working set and the active selection across page reloads on the same browser, and shall restore them on return.
9. The Conversations Page shall not synchronize the working set across different browsers or devices.

### Requirement 2: Conversation tab strip

**Objective:** As an operator, I want a browser-style tab strip above the conversation pane showing my open conversations, so that I can switch among them in a single click.

#### Acceptance Criteria

1. While the working set holds at least one conversation and the panes layout is not active, the Conversations Page shall display a horizontal tab strip above the conversation pane with one tab per conversation, in working-set order.
2. The Conversations Page shall render each tab with a status indicator reflecting that conversation's status, the conversation title, and a close control.
3. Where a tab is among the first nine tabs, the Conversations Page shall display that tab's activation-hotkey hint.
4. When the user clicks a tab, the Conversations Page shall make that tab's conversation the active conversation.
5. The Conversations Page shall visually distinguish the active tab from inactive tabs.
6. The Conversations Page shall reveal a tab's close control when the tab is hovered or active.
7. When the user activates a tab's close control, the Conversations Page shall remove that conversation from the working set without stopping its agent, and shall not also activate the tab.
8. When the user closes the active tab, the Conversations Page shall make an adjacent remaining conversation in the working set the active conversation.
9. The Conversations Page shall provide an add control at the end of the tab strip that lets the user add a conversation not currently in the working set; when the user selects one, the Conversations Page shall add it and make it active.
10. If the working set holds 6 conversations, then the Conversations Page shall disable the tab strip's add control and indicate that the limit of 6 has been reached.

### Requirement 3: Panes layout activation and arrangement

**Objective:** As an operator, I want a split-screen layout that shows my open conversations side by side, so that I can watch and triage several at once.

#### Acceptance Criteria

1. The Conversations Page shall offer a panes layout option in the layout switcher, positioned after the split layout and before the diff-only layout, while retaining the existing layout options.
2. When the user selects the panes layout, the Conversations Page shall replace the single-conversation-and-diff view with a full-width grid containing one pane per conversation in the working set.
3. While the panes layout is active, the Conversations Page shall arrange the panes by conversation count as follows: 1, 2, or 3 panes as a single row of equal full-height panes; 4 panes as a 2×2 grid; 5 panes as three panes on the top row and two wider panes on the bottom row; 6 panes as a 3×2 grid.
4. While the panes layout is active, the Conversations Page shall size the grid so that message content within a pane shrinks to fit rather than forcing the grid to overflow.
5. When the user exits the panes layout, the Conversations Page shall return to the default single-conversation layout with the active conversation unchanged.
6. The Conversations Page shall persist the selected layout across reloads consistent with the existing layout-persistence behavior.

### Requirement 4: Per-pane mini-cockpit content

**Objective:** As an operator, I want each pane to be a live, readable mini-cockpit, so that I can understand and act on each conversation without opening it.

#### Acceptance Criteria

1. The Conversations Page shall render each pane with a header containing a status indicator, the conversation title, an open-full control, and a close control.
2. The Conversations Page shall render a meta line in each pane showing the status label, the project and session, and a relative time.
3. While a pane's conversation is waiting for the user's input, the Conversations Page shall display the agent's pending question prominently in that pane.
4. While a pane's conversation is not waiting for input, the Conversations Page shall display that conversation's latest status line in the pane.
5. The Conversations Page shall display a tail of each pane's most recent messages, preceded by a summary indicating how many earlier messages are hidden.
6. While exactly two panes are shown, the Conversations Page shall display up to four recent messages per pane; while three or more panes are shown, the Conversations Page shall display up to two recent messages per pane in a more compact form.
7. When the user activates a pane's open-full control, the Conversations Page shall make that pane's conversation active and present it in a single-conversation layout.
8. When the user activates a pane's close control, the Conversations Page shall remove that conversation from the working set without stopping its agent.
9. The Conversations Page shall not render a prompt composer inside any pane.

### Requirement 5: Active-pane indicator and composer-focus emphasis

**Objective:** As an operator, I want the active pane and the prompt destination to be unmistakable, so that I never send a prompt to the wrong conversation.

#### Acceptance Criteria

1. While the panes layout is active, the Conversations Page shall visually mark the active pane distinctly from the inactive panes.
2. When the user clicks a non-active pane, the Conversations Page shall make that pane's conversation the active conversation.
3. While the composer has input focus and the panes layout is active, the Conversations Page shall de-emphasize the inactive panes and emphasize the active pane.
4. When the composer loses input focus, the Conversations Page shall revert the pane emphasis.
5. While a single-conversation layout is active, the Conversations Page shall not change any pane emphasis in response to composer focus.
6. When the user adjusts the composer's controls, the Conversations Page shall preserve the composer's input focus and the associated pane emphasis.

### Requirement 6: Panes toolbar and adding panes

**Objective:** As an operator, I want a panes toolbar that shows capacity and lets me add or exit, so that the limit and controls are always visible.

#### Acceptance Criteria

1. While the panes layout is active, the Conversations Page shall display a toolbar showing the current pane count out of the maximum of 6.
2. The Conversations Page shall provide, in the panes toolbar, an add control that opens a list of active conversations not currently in the working set; when the user selects one, the Conversations Page shall add it to the working set and make it the active conversation.
3. If the working set holds 6 conversations, then the Conversations Page shall disable the panes toolbar's add control and indicate that the limit of 6 has been reached.
4. The Conversations Page shall provide, in the panes toolbar, an exit control that leaves the panes layout.

### Requirement 7: Single shared prompt composer

**Objective:** As an operator, I want one prompt composer that always targets the active conversation, so that I can reply from any layout without per-pane inputs.

#### Acceptance Criteria

1. The Conversations Page shall present a single prompt composer pinned below the content area, shared across the default, split, conversation, diff, and panes layouts.
2. When the user submits a prompt, the Conversations Page shall send it to the active conversation.
3. While the panes layout is active, the Conversations Page shall route all replies through this single composer to the active pane's conversation.
4. The Conversations Page shall preserve the composer's existing controls, behavior, and content when presenting it in the shared pinned position.
5. The Conversations Page shall continue to render the default, split, conversation, and diff layouts without visual regression when the composer is presented in the shared pinned position.

### Requirement 8: Tab and pane keyboard shortcuts

**Objective:** As an operator, I want keyboard shortcuts to switch and exit, so that I can triage quickly without the mouse.

#### Acceptance Criteria

1. When the user presses the activation shortcut for index N (where N is 1 through 9) and the working set holds at least N conversations, the Conversations Page shall make the Nth conversation in working-set order the active conversation.
2. While the panes layout is active and no peek popover or context menu is open, when the user presses Escape, the Conversations Page shall exit the panes layout.
3. While a peek popover or context menu is open, when the user presses Escape, the Conversations Page shall close that overlay and shall not also exit the panes layout on the same press.
