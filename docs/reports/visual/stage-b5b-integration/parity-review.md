# Stage B-5b — agent-capability migration: integration parity review

Consolidated before/after parity evidence for the human sign-off gate. Covers all
three B-5b slices (drawer shell, MCP capability panel, capability-panel core) plus
the two stranded B-2 config files.

- **after/** — 22 PNGs: each agent-capability Storybook story at desktop (1280×900)
  and mobile (390×844), rendered from this branch (HEAD). Includes the two seeded
  `McpCapabilityPanelContainer` stories (`--server-rows`, `--expanded-tools`).
- **before/** — 22 PNGs: the same deterministic stories rendered with the
  migration source reverted to the B-5b merge-base (`31d53927`) — i.e. the legacy
  globals.css rules + legacy component class names. `tokens.css` and the story
  files were kept at HEAD (additive tokens have no effect on legacy components;
  the Configurator props are identical at both revisions, verified).
- **diff-\*-PREFIX.png** — representative red-overlay diff images **before** the
  parity fix below (red = pixel differs by >24 sum-of-channels; faded = identical),
  kept as evidence of what the regression looked like. The fix resolved them.

Capture method (matches the established Stage-B screenshot protocol): build a
private Storybook for each state, serve `storybook-static` over a local static
server, screenshot each story iframe at the two fixed viewports. The shared CC
Storybook resolves to the prefix-sibling worktree, so a private per-worktree
build is required (see the drawer-shell parity-mapping note).

## Surface coverage

| Story | Surface | Slice |
|---|---|---|
| `agentcapabilitiesconfigurator--inline` | Drawer-shell chrome at the **config CapabilitiesSection mount** (full-page) | drawer-shell |
| `agentcapabilitiesconfigurator--drawer` | Drawer-shell chrome **open** (portaled right drawer frame) | drawer-shell |
| `agentcapabilitypanel--native-inherited-overridden` | Core panel: cascade switcher, filter pills, native/inherited/overridden rows | core |
| `agentcapabilitypanel--parent-stale-pending-failed-diagnostic` | Core panel: parent-off / stale / pending / failed / diagnostic row states | core |
| `agentcapabilitypanel--unavailable-codex-plugins` | Core panel: codex backend, unavailable state | core |
| `agentcapabilitypanel--plugin-provided-rows` | Core panel: plugin chips | core |
| `agentcapabilitypanel--interactive-regression` | Core panel: interactive variant | core |
| `agentcapabilitypanel--error-rendering` | Core panel: error state | core |
| `agentcapabilitypanel--five-panels-overview` | Core panel: five stacked panels | core |
| `mcpcapabilitypanelcontainer--server-rows` | **MCP panel**: server rows, switches, inheritance chips (cyan explicit / amber explicit-off), per-server tool summary, strikethrough disabled row, filter pills + search + scope note | mcp |
| `mcpcapabilitypanelcontainer--expanded-tools` | **MCP panel**: an expanded server's tool rows — per-tool switches, per-tool inheritance, a disabled tool (Reset) + pending tool, the TOOLS head/refresh | mcp |

**MCP capability panel** (`McpCapabilityPanelContainer`): now covered directly by two
seeded Storybook stories (`McpCapabilityPanelContainer.stories.tsx`) that inject a
session-scope `McpConfigViewResponse` into the query cache so the connected container
renders real rows without a live fetch. `--server-rows` shows the migrated server rows
(shared switch + inheritance chip + tool summary + the strikethrough disabled row);
`--expanded-tools` expands the `chrome-devtools` row (the capture harness clicks its
`[data-server-id] button[aria-expanded]` chevron — a revision-stable hook present in
both the legacy and migrated markup) to reveal the migrated tool rows, per-tool
switches, per-tool inheritance chips, and a disabled + pending tool. The before render
uses the legacy `McpCapabilityPanelContainer.tsx` + legacy globals.css `.agent-capability-mcp*`
rules (both reverted to merge-base `31d53927`); the story file + tokens are kept at HEAD
(the seeding API is unchanged across both revisions, verified by the legacy render being
pixel-identical). Element-by-element mapping: `docs/reports/visual/stage-b5b-cap-mcp-panel/parity-mapping.md`.
The conversation/session capability **mount** is the `ConversationAgentCapabilitiesConfig`
/ `ScopedAgentCapabilitiesConfig` trigger → drawer path (drawer chrome = the
`--drawer` story above; mount triggers are unit-tested, no extra visual surface).

## Diff results (shift-tolerant structural diff, ±2px / TOL 48)

**Final (after the fix below):** all 18 core/shell pairs are at the anti-aliasing
floor — worst **0.516%**, every other pair **< 0.2%**, localized entirely to
text-glyph anti-alias edges (the irreducible floor of comparing two independent
renders). The **4 MCP pairs** (`--server-rows`, `--expanded-tools` × desktop/mobile)
diff at **0.029–0.091%** (worst 0.091%) — also pure AA floor. This is **zero visual
change**.

Initial run (before the fix): desktop 0.7–1.8%, mobile 2.6–5.2% — which surfaced the
regression below.

## ✅ Parity regression found AND FIXED — toolbar filter pills + level switcher, mobile

A real, reproducible mobile-only layout delta was found during this review, root-caused,
and fixed in-place (TSX-only; no globals.css change, baseline stays 309).

Deterministic geometry (story `native-inherited-overridden`, 390px). The delta was
**fixed per panel** (independent of row count — confirmed by `five-panels-overview`,
+60px = 12×5), so it lived in the once-per-panel chrome, not the rows:

| Region | Before (legacy) | After (pre-fix) | After (FIXED) |
|---|---|---|---|
| header | 136 | 136 | 136 |
| level switcher | 252 | 244 (**−8**) | **252** ✓ |
| toolbar | 136 | 156 (**+20**) | **136** ✓ |
| filters sub-region | 30 | 50 (**+20**) | **30** ✓ |
| rows | 320 | 320 | 320 |
| **section total** | **859** | **871** (+12) | **859** ✓ |

Both discrepancies were **3-way cascade-merge misses** (the exact trap the slice notes
warned about — the shared classes merge per-property across prototype / refresh /
current globals.css blocks + multiple `@media` blocks):

1. **Toolbar +20px** — the migrated filter pills (`AgentCapabilityPanel.tsx` AND
   `McpCapabilityPanelContainer.tsx`, which reuses the shared `.agent-capability-filter`)
   carried `max-768:min-h-[var(--touch-target-min)]` (44px). But the legacy merged
   **effective** filter min-height is **24px**: the current-block rule
   `.agent-capability-filter { min-height: 24px }` (globals.css ~3191) overrides the
   `@media(max-width:768px)` `min-height: 44px` rule (~2409) by **source order** (equal
   specificity, later wins — a media query does NOT auto-win over a non-media rule). The
   migration resurrected that dead 44px rule. **Fix:** removed the `max-768:min-h-…` from
   both files' filter pills. (The per-row reset/toggle touch-targets are correct and were
   left untouched — the current block does not re-declare them, so their `@media768` 44px
   is live; the rows measured at parity confirms this.)
2. **Level switcher −8px** — the legacy `.agent-capability-level` is a 2-block merge:
   refresh `{ display:grid; gap:2px }` + current `{ display:flex; flex-direction:column }`.
   Per-property merge → `display:flex` **with `gap:2px` surviving** (current doesn't
   re-declare gap), which stacks with the detail span's `margin-top:2px` for **4px**
   name↔detail separation. The migration reproduced only the 2px margin-top and dropped
   the orphaned 2px flex gap → 2px shorter ×4 levels = −8px (this also caused the residual
   desktop text-edge shift). **Fix:** added the unconditional `gap-[2px]` to the level
   button in `AgentCapabilityPanel.tsx`.

Verified by re-measure (section 859, toolbar 136, levels 252 — exact match to legacy) and
by the final structural diff (all pairs ≤ 0.52%, AA-floor). TSX-only; globals.css
selector count unchanged (baseline stays 309).

## Per-owner residual (what remains in globals.css after B-5b)

- The agent-capability block (`.agent-capability-*` / `.cap-*` / `.agent-capabilities-*`)
  is **fully removed** (0 selectors; baseline 568 → 309).
- What remains (309 selectors): the shared **leaf recipes** (`cc-tab*`/`cc-badge*`/
  `btn-*`/`empty-*`/`form-*`/`.status-*`) awaiting the **cleanup gate (B-final)**, plus
  the **preserved floor** (scrollbars, the 20-keyframe library, `.markdown-*` rendered
  output, tooltip/modal/toast portal positioning) which stays forever. Floor unchanged
  at 66.
- **Deferred to B-6** (untouched here): the session.css residual
  (SessionInfoStrip/.session-status/.debug-*/.git-panel-*), the B-4-deferred
  conversation.css ConversationPanel chrome + `.ctx-menu*`, and the graph/builder
  families.
