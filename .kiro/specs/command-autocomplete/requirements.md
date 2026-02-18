# Requirements Document

## Introduction

The Command Autocomplete feature adds a slash-command autocomplete UI to CSM's prompt input area. When a user types `/` at the beginning of the prompt textarea, a dropdown overlay appears listing all available custom commands and skills — sourced from the project level, user level, and installed plugins. The list filters in real time using fuzzy matching as the user continues typing. Selecting an item inserts the command name into the textarea for execution.

This feature addresses ROADMAP item #11 ("UI for easily invoking Claude Code commands/skills") and enhances CSM's role as "ground control" by making the full command surface discoverable within the prompt interface.

## Requirements

### Requirement 1: Trigger Behavior

**Objective:** As a CSM user, I want the autocomplete to appear when I type `/` in the prompt, so that I can discover and select commands without memorizing them.

#### Acceptance Criteria

1. When the user types "/" as the first character in the prompt textarea, the Autocomplete UI shall display a dropdown overlay above the prompt input area showing all available commands and skills.
2. When the prompt textarea value no longer starts with "/", the Autocomplete UI shall close the dropdown.
3. When the user clears the textarea or deletes the leading "/", the Autocomplete UI shall close the dropdown.
4. While the prompt textarea is disabled (session is finished or a prompt is in-flight), the Autocomplete UI shall not activate.
5. When the Autocomplete UI opens, the Autocomplete UI shall set the first item in the list as the active selection.

### Requirement 2: Command Discovery API

**Objective:** As a CSM user, I want the autocomplete to show all commands and skills available to my Claude session, so that I have a complete picture of what I can invoke.

#### Acceptance Criteria

1. The Command Discovery API shall read command files (`.md` with YAML frontmatter) from the project-level `.claude/commands/` directory of the session's worktree, including namespaced commands in subdirectories (e.g., `kiro/spec-init.md` becomes `/kiro:spec-init`).
2. The Command Discovery API shall read command files from the user-level `~/.claude/commands/` directory.
3. The Command Discovery API shall read command files from all enabled plugins' `commands/` directories, as determined by the user's `~/.claude/settings.json` `enabledPlugins` list and the plugin cache at `~/.claude/plugins/cache/`.
4. The Command Discovery API shall read skill definitions (`SKILL.md` with YAML frontmatter) from user-level `~/.claude/skills/` subdirectories.
5. The Command Discovery API shall read skill definitions from all enabled plugins' `skills/` subdirectories.
6. The Command Discovery API shall not include built-in Claude Code CLI commands (e.g., `/help`, `/clear`, `/fast`, `/compact`, `/model`); only custom commands and skills are surfaced.
7. For each discovered item, the Command Discovery API shall extract: name (derived from filename and namespace path), description (from YAML `description` field), argument-hint (from YAML `argument-hint` field, commands only), type (`command` or `skill`), and source (e.g., `project`, `user`, or the plugin name).
8. If a command file lacks a `description` field in its frontmatter, the Command Discovery API shall use the first non-empty line of the markdown body as the description.
9. The Command Discovery API shall expose results via a Next.js API route that accepts the session's project path as context to resolve project-level commands.

### Requirement 3: Fuzzy Filtering

**Objective:** As a CSM user, I want flexible filtering so that partial or imprecise typing still finds the command I'm looking for.

#### Acceptance Criteria

1. When the user types characters after the initial "/", the Autocomplete UI shall filter the displayed list using fuzzy matching against command names.
2. The fuzzy matching algorithm shall support exact prefix matching with the highest relevance score.
3. The fuzzy matching algorithm shall support substring containment matching with a moderate relevance score.
4. The fuzzy matching algorithm shall support ordered character matching (characters of the query appear in order within the target, but not necessarily contiguously) with a lower relevance score proportional to character spread.
5. When the query is 3 or more characters, the fuzzy matching algorithm shall additionally match against item descriptions, with a lower score than name matches.
6. The Autocomplete UI shall sort filtered results by relevance score (descending), then alphabetically by name for equal scores.
7. The Autocomplete UI shall highlight matched characters in the command name using the cyan accent color (`--cyan`).
8. If no items match the current query, the Autocomplete UI shall display a "No matching commands" empty state.

### Requirement 4: Visual Display

**Objective:** As a CSM user, I want the autocomplete to be visually clear and consistent with CSM's design system, so that I can quickly scan and identify commands.

#### Acceptance Criteria

1. The Autocomplete UI shall render as an overlay panel positioned directly above the prompt input area using absolute positioning within the prompt-input-area container.
2. Each item in the dropdown shall display on a single row: command name (left-aligned, mono font), description (truncated with ellipsis, middle fill), type badge (pill-shaped), and source label (right-aligned).
3. Type badges shall use semantic colors per the design system: cyan (`--cyan`) for commands and green (`--green`) for skills.
4. The active (keyboard-selected or hovered) item shall display a 2px cyan left border with a horizontal gradient glow wash.
5. The dropdown shall display a sticky header containing a "Commands & Skills" label and a dynamic count of available/filtered items.
6. The dropdown shall display a sticky footer showing keyboard shortcut hints (arrow keys to navigate, Enter to select, Tab to complete, Escape to close).
7. The dropdown container shall use frosted glass background (`backdrop-filter: blur`, semi-transparent background) consistent with the topbar styling.
8. The dropdown shall include a decorative cyan accent line at the top via CSS pseudo-element.
9. All text in the dropdown shall use the mono font (`--font-mono`) per the typography contract (this is a data/control surface, not prose).
10. The dropdown max-height shall be constrained (340px) with internal scrolling for the item list.
11. When the dropdown opens, the Autocomplete UI shall apply a slide-up reveal animation (0.18s ease).

### Requirement 5: Keyboard Navigation

**Objective:** As a CSM user, I want full keyboard control of the autocomplete, so that I can select commands without reaching for the mouse.

#### Acceptance Criteria

1. While the Autocomplete UI is visible and the user presses ArrowDown, the Autocomplete UI shall move the active selection to the next item in the list.
2. While the Autocomplete UI is visible and the user presses ArrowUp, the Autocomplete UI shall move the active selection to the previous item in the list.
3. While the Autocomplete UI is visible and the user presses Enter or Tab, the Autocomplete UI shall select the currently active item.
4. While the Autocomplete UI is visible and the user presses Escape, the Autocomplete UI shall close the dropdown and clear the textarea.
5. The Autocomplete UI shall prevent ArrowDown from moving past the last item and ArrowUp from moving before the first item.
6. When the active item changes via keyboard, the Autocomplete UI shall scroll the active item into view within the dropdown list.
7. While the Autocomplete UI is visible, the Enter key shall select a command rather than submitting the prompt (the autocomplete intercepts the key event).

### Requirement 6: Selection Behavior

**Objective:** As a CSM user, I want selecting a command to prepare it for execution in the textarea, so that I can add arguments before sending.

#### Acceptance Criteria

1. When the user selects a command (via Enter, Tab, or click), the Autocomplete UI shall replace the textarea content with the command name followed by a space (e.g., `/kiro:spec-init `).
2. When the selected command has an `argument-hint` value, the Autocomplete UI shall update the textarea placeholder to display the hint (e.g., `<feature-name>`).
3. When the user selects a command, the Autocomplete UI shall close the dropdown.
4. When the user selects a command, the Autocomplete UI shall return focus to the prompt textarea.
5. When the user hovers over an item in the list, the Autocomplete UI shall update the visual active state to that item without requiring a click.

### Requirement 7: Responsive Behavior

**Objective:** As a CSM user, I want the autocomplete to work on any screen size, so that I can use commands from desktop or mobile.

#### Acceptance Criteria

1. The Autocomplete UI dropdown shall fill the full width of the prompt input area at all breakpoints (desktop, tablet, mobile).
2. On mobile (≤768px), the Autocomplete UI shall provide touch targets of at least 44px height for each command item.
3. On mobile (≤768px), the Autocomplete UI shall remain usable when the prompt input is in its sticky bottom position.
4. The dropdown shall not extend above the top boundary of the prompt panel container.
