# Stage B-6 — consolidated parity review (final migration stage)

**Status: GO — paused for human sign-off before B-final.**

B-6 migrates the **last migratable surfaces** (graph/builder LAST). After this stage
the only remaining un-migrated CSS is the three things B-final owns: the shared **leaf
recipes** (consumer-gated deletes), the **@theme alias bridge**, and the **base reset**
(Preflight adoption). Zero visual change is intended across every slice (the one
already-shipped exception — the B-3 a11y contrast fix — predates B-6).

This artifact consolidates the five B-6 migration slices' before/after evidence into one
review and records the integration gate's own verification. Per-slice screenshots live in
the linked sub-directories (before/after, desktop + mobile, captured with the
byte-identical / geometry methods in `tailwind-parity-screenshot-method`).

---

## 1. Slice roll-up

| Slice | Surfaces migrated | Owner Δ (selectors) | Verdict | Evidence |
|---|---|---|---|---|
| **b6-globals-message-chrome** | message-image, tool-use (`ToolUseIndicator`/`ToolUseGroup`), `CommandIndicator`, nav/msg-action @768 folds, `MobileActionMenu` + mobile-action sheet | globals.css 309→231 (floor 66) | GO (byte-identical TDD-sheet; spinner-story animation excluded) | [b6-message-mobile-chrome/](./b6-message-mobile-chrome/parity-review.md), [b6-command-indicator/](./b6-command-indicator/parity-review.md) |
| **b6-session-chrome** | `SessionInfoStrip`/`.session-status`/`.si-*`, `SessionContent`, `LayoutSwitcher`, `DebugActionCard`/`DebugStructuredCard`, `SessionGitPanel`/`.git-panel*`, `CopyableId`, `MobileInfoPanel`, docked-stage/tab-strip/layout-switcher | session.css 239→**23** | GO (per-story before/after desktop+mobile IDENTICAL; DebugStructuredCard divider/check colors completed — see §3.1) | [session-chrome/](./session-chrome/PARITY.md) |
| **b6-conversation-prompt-panel** | B-4-deferred `ConversationPanel` shell chrome (`.prompt-panel`/`.panel-*`/`.conv-stop*`/`.prompt-error*`/`.prompt-textarea*`/arg-hint), prompt.css, `.ctx-menu*` (`ConversationSidebarRowContextMenu`) | conversation.css 137→88 (floor 39), prompt.css 26→3 (floor 2) | GO (ctx-menu + PromptInputArea IDENTICAL; ConversationPanel shell by compiled-CSS selector equivalence; **Stop button byte-identical**) | [b6-conversation-prompt-panel/](./b6-conversation-prompt-panel/parity-review.md) |
| **b6-small-residuals** | dialogs separator, PeekPopover ≤800px reposition | dialogs.css 4→3, PeekPopover.css 9→8 | GO (mergeconflicts + peek-await IDENTICAL desktop+mobile) | [b6-small-residuals/](./b6-small-residuals/) |
| **b6-graph-builder** (LAST, riskiest) | fused graph/builder unit: session.css `.graph-workflow*`/`.workflow-builder*`, `workflows-builder.css` (**deleted**), `session-workflow.css` (**deleted**), `workflow-graph.css` JSX-authored `.wb-*`/`.graph-node*`/`.edge-*` chrome | workflow-graph.css 480→**58** (corrected floor), workflows-builder.css→0, session-workflow.css→0 | GO (node chrome valid 0.20% = pulse animation only; builder chrome by geometry + element-by-element CSS faithfulness — see caveat below) | [graph-builder/](./graph-builder/PARITY.md) |

---

## 2. Graph / builder — the riskiest, vendor-adjacent surface (emphasis)

The full graph/builder view is the highest-risk migration (React-Flow-adjacent, fused
across three owners). Its parity is established two ways because of a **harness caveat**:

- **Node chrome (valid pixel parity):** `ExecutionContextNode`/`ContextEdge` stories
  `import "./workflow-graph.css"`, so the legacy node is fully styled in isolation →
  valid before/after. Result: **0.20% desktop / 0.84% mobile**, and the diff bbox is
  exactly the `pulse-node` box-shadow **animation** on the running node — static states
  are pixel-identical.
- **Builder chrome (geometry + analytical faithfulness):** the legacy
  `WorkflowInspectorPanel`/`WorkflowDefinitionsSidebar`/`InspectorConfigBlock` stories
  **never imported** `workflows-builder.css`, so the legacy isolated render is
  *under-styled* (0 `.wb-inspector-block__body` rules loaded) → before/after pixel-diff
  is **invalid for builder surfaces**. Parity is instead proven by geometry numbers that
  match the legacy CSS exactly (block body `padding-top` 12px = `var(--space-md)`; head
  height 33px) and element-by-element CSS faithfulness against `workflow-graph.css@1b444830`.
  This is the documented graph/builder trap.

**Preserved per R6 (never converted), all verified intact in the final tree:**
14 React Flow vendor selectors (`.react-flow__*`/`.xyflow*`), the scrollbar selectors,
the **7 graph `@keyframes`**, and the **26 `.wb-markdown-inline*`** rendered-markdown
selectors. `workflow-graph.css` sits at **exactly its 58 floor** — every preserved rule
present, nothing extra. `wb-inspector-body`/`wb-sidebar-list` survive ONLY as
`::-webkit-scrollbar` anchors (R6); their layout migrated to utilities.

---

## 3. The Stop button (`.conv-stop-btn`) — byte-identical via minted soft-red tokens

The conv-stop soft-red `rgb(248,113,113)` is distinct from the system `--red` (`#ff3d5a`)
and has no Tailwind-scale entry, so the b6-foundation minted parity-only tokens. The
button now renders byte-identical through token-backed arbitrary utilities
(`ConversationPanel.tsx:160`):

| Property | utility | token value | == legacy `--cc-stop-*` |
|---|---|---|---|
| border | `border-[var(--cc-red-soft-a45)]` | rgba(248,113,113,0.45) | `--cc-stop-border` 0.45 ✓ |
| bg | `bg-[var(--cc-red-soft-a08)]` | rgba(248,113,113,0.08) | `--cc-stop-bg` 0.08 ✓ |
| hover bg | `hover:bg-[var(--cc-red-soft-a14)]` | rgba(248,113,113,0.14) | `--cc-stop-bg-hover` 0.14 ✓ |
| hover glow | `hover:shadow-[0_0_12px_var(--cc-red-soft-a25)]` | rgba(248,113,113,0.25) | `--cc-stop-glow` ✓ |

The pre-foundation `--cc-stop-*` copies are now **dead** (0 TSX/TS consumers) — retire in
B-final R9 token dedup. Text/hover-border use the system `--red` unchanged.

### 3.1 DebugStructuredCard divider / check-fail colors — byte-identical via integration-minted tokens

The session-chrome slice had **deferred** two `DebugStructuredCard` parity colors that had no
design token: the amber row-divider `rgba(255,179,0,0.08)` (a gap between `--cc-amber-a04`
and `-a09`) and the check-fail icon red `#ef4444` (distinct from `--red` `#ff3d5a`). They
were left as raw literals on bare BEM hooks in `session.css` (lines 147-157) — a residual
**mixed-ownership** state on an otherwise-migrated component. This integration pass closed
the foundation gap: two tokens were minted in `tokens.css` and `DebugStructuredCard.tsx`
now reproduces both via token-backed utilities; the `session.css` rules + dead BEM hooks
were deleted (session.css 28→23).

| Surface | utility | token value | == legacy literal |
|---|---|---|---|
| hypothesis / step row divider | `border-t border-solid border-t-[var(--cc-amber-a08)]` + `first:border-t-0` / `[&>li:first-child]:border-t-0` | rgba(255,179,0,0.08) → `#ffb30014` | `rgba(255,179,0,0.08)` ✓ |
| failed-check icon | `group-data-[ok=false]/chk:text-[var(--cc-red-check-fail)]` | `#ef4444` | `#ef4444` ✓ |

Verified in the compiled Tailwind output: `border-top-color:var(--cc-amber-a08)`,
`color:var(--cc-red-check-fail)`, and the first-child `border-top-width:0` rules all emit;
the `DebugActionCard` adjacency selector (`…:has(.debug-structured-card:last-child)+…`)
still resolves against the surviving `debug-structured-card` root hook. No visual change.

---

## 4. Integration gate verification

All gates green on the final merged tree (registration + baseline + the DebugStructuredCard /
collision-test remediation in this pass):

- `bun run build` — **success** (exit 0)
- `bun run build-storybook` — **success** (exit 0)
- `bun run lint` — **0 errors** (93 pre-existing `no-unused-vars` warnings in `lib/workflows`, unrelated)
- `bun run typecheck` — **clean**
- `bun run css:progress --check` — **OK** (no owner increased or below floor; session.css ratcheted 28→23)
- targeted Vitest (workflow-graph / workflows-builder / session-workflow / migrated components / guardrail / collision / css-progress / debug cards) — **green** (51/51 across the touched debug + mobile + collision surfaces in this pass)

**No mixed ownership / no unstyled regressions.** The one residual mixed-ownership case —
`DebugStructuredCard`'s deferred divider/check colors still in `session.css` — was closed
this pass (§3.1). The `tailwind-utility-collisions` allowlist was corrected to match the
file-scoped guardrail decision: the broad `features/session/mobile/` dir glob was replaced
with file-scoped entries (`MobileInfoPanel.tsx` migrated; `MobileSessionView.stories.tsx`
exempted for its intentional utility scaffolding), leaving the pure-legacy `MobileBottomBar.tsx`
**guarded** with no entry — consistent with the eslint/prettier registration. Now that the graph/builder + globals
+ session chrome dirs are in eslint `MIGRATED_UTILITY_FIRST`, `no-hardcoded-color` and
`no-dynamic-class` run on them and **pass** — confirming the graph-builder slice's gap-color
repoint to the foundation `--cc-graph-*`/`--cc-codex-violet-*` palette is complete. The only
raw color literals remaining are the two `<Background color="rgba(255,255,255,0.15)">`
React-Flow **JS props** (not classNames; correctly outside the color guard), per the
foundation-gap doc. `session/mobile/` is **mixed** — `MobileBottomBar`/`MobileSessionView`
still consume the legacy `.cc-tab`/`.mobile-bottom-bar` recipes (deferred graph-context),
so only `MobileInfoPanel` is registered (file-scoped); the legacy siblings stay guarded.

**Guardrail decision (LAYOUT_ALLOWED extension).** `WorkflowInspectorPanel`'s Tabs/Tab
`layoutClassName` (`flex-[1_1_auto] min-w-0 overflow-hidden` / `min-w-0 overflow-hidden
text-ellipsis`) is a byte-faithful reproduction of the original
`.wb-inspector-header .cc-tabs/.cc-tab` **descendant** rules
(`flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis`, verified at
`1b444830`). Removing them breaks parity, so per the B-3 precedent the
`no-appearance-in-layout-classname` allowlist was extended with flex sizing, overflow
clipping, and exact-match `truncate`/`text-ellipsis`/`text-clip` (parent-constrains-child
flow/clipping — not §2 appearance: color/bg/border/radius/shadow/opacity/padding). 3 valid
RuleTester cases added; guardrail suite 51/51 green.

---

## 5. Remaining migratable content (for B-final only)

Per the acceptance criteria's NEGATIVE clause, B-6 migrated **no surface beyond the
slices above**, deleted **no leaf recipe**, removed **no alias**, and made **no Preflight
change**. The only un-migrated CSS left is exactly B-final's scope:

1. **Shared leaf recipes** still consumed by ≥1 prod surface (`.cc-tab*`/`.cc-section-*`/
   `.mobile-bottom-bar`/`.mobile-action-*` etc.) — consumer-gated deletes (R9.x).
2. **`@theme` → legacy `var(--…)` alias bridge** + the dead `--cc-stop-*` family — R9 dedup
   (legacy NAMES survive; preserved CSS reads them). Two integration-minted parity tokens
   (`--cc-amber-a08`, `--cc-red-check-fail`) join the bridge; `--cc-amber-a08` is a candidate
   for normalization in the R9 amber-scale dedup (sits between `-a04` and `-a09`).
3. **Base reset** — incremental Preflight adoption below `reset.css`, human-gated.

Above-floor residual that is preserved/cross-owned, NOT incomplete migration (floor
tightening is B-final 9.2): conversation.css 88 (preserved R6 + out-of-slice authored
chrome owned by no B-6 slice + cross-owned shared recipes), session.css **23**
(sidebar-diff/prompt-panel/banners + AskQuestion-clearance + keyframes deferred to their owners).

---

## 6. Human review checklist

Please confirm before B-final begins:

- [ ] **Graph/builder view** (desktop + mobile) — nodes, edges, inspector, definitions
      sidebar, config blocks, mobile tab bar render identically to `main`.
- [ ] **Stop button** in an active conversation — soft-red border/bg + hover glow unchanged.
- [ ] Message/tool-use chrome, command indicator, mobile action menu.
- [ ] Session info strip / status / git panel / debug cards / copyable id / mobile info.
- [ ] ConversationPanel shell + prompt composer + sidebar context menu.

No regressions found at the integration gate; **paused at the human-approval gate.**
