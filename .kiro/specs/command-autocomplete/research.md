# Research & Design Decisions

## Summary
- **Feature**: `command-autocomplete`
- **Discovery Scope**: Extension (new UI component + API route added to existing session detail page)
- **Key Findings**:
  - No YAML/frontmatter parsing library exists — simple regex parser is sufficient for the limited frontmatter fields needed
  - No fuzzy search library needed — the spec defines a custom 3-tier scoring algorithm simple enough to implement inline
  - The `SessionDetailPage.tsx` textarea `onKeyDown` handler must be wrapped to let autocomplete intercept keys before the Enter-to-send behavior fires

## Research Log

### Frontmatter Parsing Strategy
- **Context**: Command `.md` files use YAML frontmatter (`---\nkey: value\n---`) with simple string fields: `description`, `argument-hint`, `allowed-tools`, `model`, `disable-model-invocation`. Skill `SKILL.md` files use the same format with `name` and `description`.
- **Sources Consulted**: `package.json` dependencies, `package-lock.json` for transitive deps
- **Findings**:
  - No direct YAML dependency (`js-yaml` exists as a transitive dep but should not be relied upon)
  - The frontmatter structure is flat key-value pairs only — no nested objects, no arrays
  - Only two fields are needed: `description` (string) and `argument-hint` (string, optional)
- **Implications**: A minimal regex-based frontmatter parser (~15 lines) is sufficient and avoids adding a dependency. Extract content between `---` delimiters, split lines, parse `key: value` pairs.

### Plugin Discovery Path Resolution
- **Context**: Enabled plugins are listed in `~/.claude/settings.json` under `enabledPlugins` (array of `"pluginName@marketplaceName"` strings). Plugin files are cached at `~/.claude/plugins/cache/<marketplace>/<plugin-name>/<version>/`.
- **Sources Consulted**: `~/.claude/settings.json` structure, `~/.claude/plugins/installed_plugins.json` structure, actual plugin cache directories
- **Findings**:
  - `installed_plugins.json` maps each plugin to its marketplace and installed version
  - The actual plugin files live at `~/.claude/plugins/cache/<marketplace>/<plugin-name>/<version>/`
  - Each plugin may have `commands/` and/or `skills/` subdirectories
  - Plugin scope (project vs user) is tracked in `installed_plugins.json` but all should be surfaced
- **Implications**: Discovery needs to read `settings.json` for enabled list, then `installed_plugins.json` for version/marketplace info, then scan the resolved cache path for commands/skills.

### Keyboard Event Intercept Pattern
- **Context**: `SessionDetailPage.tsx` has `onKeyDown` on the textarea that sends on Enter. The autocomplete must intercept ArrowUp/Down/Enter/Tab/Escape before this handler.
- **Sources Consulted**: React event handling documentation, existing `SessionDetailPage.tsx` code
- **Findings**:
  - React's synthetic events bubble like DOM events — a child handler can `preventDefault()` and `stopPropagation()` before the parent sees it
  - The autocomplete component can wrap the textarea or place its own `onKeyDown` handler that conditionally intercepts
  - Simplest pattern: pass an `onKeyDown` interceptor from autocomplete to textarea; when autocomplete is visible, handle navigation keys and return `true` (handled); otherwise fall through to the default Enter-to-send behavior
- **Implications**: The autocomplete component should expose a `handleKeyDown` function that the parent textarea's `onKeyDown` calls first. If it returns `true`, the parent skips its own handler.

### Fuzzy Matching Algorithm
- **Context**: Requirements specify a 3-tier scoring system: prefix > substring > ordered character match, with description matching at 3+ characters.
- **Sources Consulted**: fuse.js, fzf-for-js documentation; custom scoring in VS Code, Sublime Text
- **Findings**:
  - fuse.js is ~25KB minified — overkill for 20-50 items with a known scoring spec
  - The algorithm is simple enough to implement as a pure function (~40 lines)
  - Score tiers: prefix (100), substring (80), ordered chars (60 - spread), desc match (40)
- **Implications**: No library needed. Implement as `src/lib/shared/fuzzy.ts` with full test coverage.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Server-side discovery + client filter | API route discovers all commands; client does fuzzy filtering | Clean separation, commands cacheable, no server round-trip per keystroke | Requires initial fetch; stale if commands change during session | Selected approach — matches existing API pattern |
| Fully client-side discovery | Read file system from client via multiple API calls | No new API route | Excessive network requests, can't read server filesystem from browser | Not feasible |
| Server-side filter per keystroke | API takes query param, filters server-side | Server has full context | Latency per keystroke, unnecessary server load for 20-50 items | Over-engineered |

## Design Decisions

### Decision: Minimal frontmatter parser over js-yaml dependency
- **Context**: Need to extract `description` and `argument-hint` from markdown frontmatter
- **Alternatives Considered**:
  1. Add `js-yaml` as a direct dependency — full YAML spec support
  2. Use regex-based parser — handles flat key-value frontmatter only
- **Selected Approach**: Regex-based parser
- **Rationale**: Only 2 simple string fields needed; avoids adding a dependency per steering's minimal dependency principle; ~15 lines of code vs. a 50KB library
- **Trade-offs**: Cannot handle complex YAML (nested objects, arrays) — acceptable since frontmatter fields are flat strings
- **Follow-up**: If future features need full YAML parsing, revisit this decision

### Decision: Client-side fuzzy filtering over server-side
- **Context**: The autocomplete list has ~20-50 items; filtering must feel instant on every keystroke
- **Alternatives Considered**:
  1. Server-side filtering via API query param
  2. Client-side filtering in the React component
- **Selected Approach**: Client-side filtering
- **Rationale**: The command list is small enough to load entirely on component mount; client-side filtering eliminates network latency per keystroke; server-side would be over-engineered
- **Trade-offs**: All items loaded upfront (negligible payload); filtering algorithm runs in the browser (trivial for <100 items)

### Decision: Colocate autocomplete as shared component
- **Context**: The autocomplete is used only in `SessionDetailPage` but has enough complexity (state management, keyboard handling, fuzzy logic) to warrant its own file
- **Selected Approach**: `src/components/CommandAutocomplete.tsx` as a shared component
- **Rationale**: Follows the existing pattern where cross-cutting UI with significant logic lives in `src/components/` (like `VoiceRecordButton.tsx`); keeps `SessionDetailPage.tsx` focused on layout orchestration

## Risks & Mitigations
- **Risk**: `overflow: hidden` on `.prompt-panel` could clip the absolutely positioned autocomplete dropdown → **Mitigation**: The dropdown positions within the panel's bounds (max-height 340px within a ~600px+ panel); verified in the UI prototype that clipping does not occur
- **Risk**: Stale command list if plugins are installed/removed during a session → **Mitigation**: Fetch commands on each autocomplete activation (when `/` is typed); acceptable latency for a cold start
- **Risk**: Plugin cache directory structure varies or is missing → **Mitigation**: Graceful handling — skip missing directories, log warnings, return whatever commands are found
