# Implementation Plan

## Requirements Coverage

All 7 requirements (46 acceptance criteria) are mapped to implementation tasks below.

| Requirement | Criteria Count | Covered By Tasks |
|-------------|---------------|------------------|
| 1. Trigger Behavior | 5 | 5.2, 6 |
| 2. Command Discovery API | 9 | 1, 2.1, 2.2, 4 |
| 3. Fuzzy Filtering | 8 | 3.1, 5.3 |
| 4. Visual Display | 11 | 5.1, 5.2 |
| 5. Keyboard Navigation | 7 | 5.4, 6 |
| 6. Selection Behavior | 5 | 5.4, 6 |
| 7. Responsive Behavior | 4 | 5.1 |

## Tasks

- [x] 1. (P) Define command item data schemas and types
  - Create Zod schemas for command items and the API response envelope
  - Export inferred TypeScript types for use across server and client layers
  - _Requirements: 2.7, 2.9_
  - _Contracts: CommandItem type, CommandsResponse type_

- [x] 2. Implement frontmatter parsing and command discovery
- [x] 2.1 (P) Implement frontmatter parser
  - Parse YAML key-value pairs between `---` delimiters at the start of markdown content
  - Return extracted fields and the remaining markdown body
  - Handle edge cases: no frontmatter block, empty content, quoted values
  - _Requirements: 2.7, 2.8_
  - _Contracts: parseFrontmatter service interface_

- [x] 2.2 Implement multi-source command and skill discovery
  - Scan project-level command directory with subdirectory namespace derivation (e.g., `kiro/spec-init.md` becomes `/kiro:spec-init`)
  - Scan user-level command and skill directories
  - Resolve enabled plugins from user settings and installed plugins cache, then scan each plugin's command and skill directories
  - Derive skill names from directory names under the skills path
  - Append hardcoded built-in commands (`/help`, `/clear`, `/fast`, `/compact`, `/model`)
  - Fall back to the first non-empty body line when a command file lacks a description field
  - Skip missing directories gracefully with logged warnings; never fail the entire result for a single source error
  - Deduplicate by name with priority order: project > user > plugin > built-in
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_
  - _Contracts: discoverCommands service interface_

- [x]* 2.3 (P) Unit tests for frontmatter parsing and command discovery
  - Verify frontmatter extraction: valid block, no block, empty file, malformed delimiters, quoted values
  - Verify discovery: mock filesystem with project/user/plugin commands, namespace derivation, built-in inclusion, missing directory handling, deduplication priority
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

- [x] 3. Implement fuzzy matching utility
- [x] 3.1 (P) Build the three-tier fuzzy matching function
  - Implement prefix matching (score 100) with contiguous indices from start
  - Implement substring containment matching (score 80) with indices at offset
  - Implement ordered character matching (score proportional to character spread, minimum 10)
  - Return match status, numeric score, and matched character indices for highlight rendering
  - Match case-insensitively; return score 100 with empty indices for an empty query
  - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - _Contracts: fuzzyMatch service interface_

- [x]* 3.2 (P) Unit tests for fuzzy matching
  - Verify each tier: prefix, substring, ordered-character, no match
  - Verify edge cases: empty query, case insensitivity, score ordering across tiers
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 4. Create commands API route
  - Accept project name and session name as URL parameters, resolve the session's worktree path
  - Delegate to the command discovery function and return the result as a JSON array wrapped in the response schema
  - Follow existing API route conventions: `withTracing` wrapper, `resolveProjectPath`, `dynamic = "force-dynamic"`, typed error responses
  - Return 404 when the project or session is not found; return 500 with message on discovery errors
  - _Requirements: 2.9_
  - _Contracts: CommandsRoute API contract_

- [x] 5. Build autocomplete component and visual styles
- [x] 5.1 (P) Add autocomplete visual styles to the global stylesheet
  - Frosted glass overlay with blur and semi-transparent background, positioned above the prompt input area
  - Single-row item layout: mono-font command name, truncated description, pill-shaped type badge with semantic color (cyan for commands, green for skills, tertiary for built-in), right-aligned source label
  - Active item highlight with 2px cyan left border and horizontal gradient glow
  - Sticky header with label and dynamic item count; sticky footer with keyboard shortcut hints
  - Decorative cyan accent line at the top via pseudo-element
  - Slide-up reveal animation (0.18s ease)
  - Max-height constraint (340px) with internal scrolling for the item list
  - Mono font for all text within the dropdown
  - Mobile responsive: full-width at all breakpoints, 44px minimum touch targets below 768px
  - Dropdown must not extend above the prompt panel container boundary
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 7.1, 7.2, 7.3, 7.4_

- [x] 5.2 Build the autocomplete component with trigger behavior and item rendering
  - Show the dropdown overlay when the prompt text starts with `/`; close it when the text no longer starts with `/` or when the textarea is cleared
  - Fetch the full command list from the API on the first activation per session; cache the result for subsequent activations
  - Render each item as a single row with command name, description, type badge, and source label
  - Set the first item as the active selection when the dropdown opens
  - Do not activate when the prompt is disabled (session finished or prompt in-flight)
  - Show a loading indicator during the initial fetch
  - Display an inline error message on fetch failure with a retry hint
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 4.1, 4.2, 4.3, 4.5, 4.9_

- [x] 5.3 Add fuzzy filtering with match highlighting
  - Filter the displayed list using the fuzzy matching utility on every keystroke after the initial `/`
  - When the query is 3 or more characters, additionally match against item descriptions with a lower score (40) for description-only matches
  - Sort filtered results by relevance score descending, then alphabetically by name for equal scores
  - Highlight matched characters in command names using the cyan accent color
  - Reset the active selection to the first item whenever the filtered results change
  - Show a "No matching commands" empty state when no items match the current query
  - _Requirements: 3.1, 3.5, 3.6, 3.7, 3.8_

- [x] 5.4 Add keyboard navigation and selection behavior
  - ArrowDown moves to the next item; ArrowUp moves to the previous item; both clamped to list bounds
  - Scroll the active item into view within the dropdown when changed via keyboard
  - Enter or Tab selects the active item: replace textarea content with the command name followed by a space, close the dropdown, return focus to the textarea
  - When the selected command has an argument hint, update the textarea placeholder to display it
  - Escape closes the dropdown and clears the textarea
  - Hover over an item updates the visual active state without requiring a click; clicking an item selects it
  - Expose a keyboard event handler that the parent can call before its own Enter-to-send handler; return true to signal the event was consumed
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 6. Integrate autocomplete into the session detail page
  - Mount the autocomplete component within the prompt input area container
  - Pass prompt text, change handlers, placeholder change handler, project name, session name, and disabled state as props
  - Wire the keyboard event intercept so that Enter selects a command instead of submitting the prompt while the dropdown is visible
  - Verify the component does not interfere with normal prompt submission when the dropdown is closed
  - _Requirements: 1.1, 1.4, 5.7, 6.1, 6.4_

- [x]* 7. Integration and end-to-end testing
  - Verify the API route returns the correct response shape for a project with known commands, handles missing project (404), and handles an empty commands directory
  - Verify the full interaction flow: type `/` triggers dropdown, filtering narrows results, arrow key navigation works, Enter inserts the selected command, Escape closes the dropdown, empty query shows "No matching commands"
  - _Requirements: 2.9, 1.1, 3.8, 5.1, 5.3, 5.4, 6.1_
