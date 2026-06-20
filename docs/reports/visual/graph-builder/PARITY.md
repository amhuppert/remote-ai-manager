# B-6 graph/builder migration — parity report

Slice: the fused graph/builder unit (the last migratable surface). Owners migrated:
`session.css` `.graph-workflow*`/`.workflow-builder*`, `workflows-builder.css` (deleted,
floor 0), `session-workflow.css` (deleted, floor 0), and `workflow-graph.css`
JSX-authored chrome (`.wb-*` families, `.graph-node*`, `.edge-line`/`.edge-arrow`,
the `.app[data-page=workflow*]` layout anchors).

Preserved per R6 (never converted): React Flow vendor DOM (`.react-flow__*`/`.xyflow*`),
the 12 scrollbar selectors, the 7 graph `@keyframes`, and the `.wb-markdown-inline*`
rendered-markdown selectors. `workflow-graph.css` therefore ratchets to a **58-selector
floor** (its true preserved residual), corrected up from the earlier conservative 33 in
`scripts/css-migration-progress.ts` `OWNER_FLOORS`.

## Method

Storybook on a private own-worktree port (6019; `ensure_dev_server` resolves to the
prefix-sibling worktree). The whole graph/builder migration is **uncommitted on top of
HEAD** (`f04d2297`, the b6-session-chrome commit), so HEAD is a clean legacy "before".
Before = `git stash` (reverts working tree to HEAD legacy), Storybook HMR rebuild allowed
to settle, capture; after = working tree (stash popped). Viewports: desktop 1440×900,
mobile 390×844, device-scale-factor 1. Diffs computed with PIL (`max-channel delta > 16`).

## Result: PARITY (with two harness caveats below)

### Node chrome — valid before/after, parity confirmed

`ExecutionContextNode` / `ContextEdge` stories `import "./workflow-graph.css"`, so the
legacy node is **fully styled** in isolation and the before/after comparison is valid.

| Surface | Desktop Δ | Mobile Δ | Interpretation |
|---|---|---|---|
| ExecutionContextNode (Running) | 0.20% | 0.84% | Diff bbox is exactly the node glow; it is the `pulse-node` **animation** (the running node's box-shadow pulses), not a layout/appearance change. Static node states are pixel-identical. |

### Builder chrome (inspector / sidebar / config block) — before captures are an under-styled legacy harness artifact, NOT a regression

The workflows-builder stories (`WorkflowInspectorPanel`, `WorkflowDefinitionsSidebar`,
`InspectorConfigBlock`) **never imported `workflows-builder.css`** and the legacy panel
chrome (`.wb-inspector`, `.cc-tabs`) lived in `workflow-graph.css` which those stories
also don't import. Verified at HEAD inside the running story:
`document.styleSheets` contains **0** `.wb-inspector-block__body` rules; the legacy block
renders with `padding:0`, `border:0`. So the legacy isolated story is **under-styled** —
it is not a faithful baseline. The migrated components are **self-contained** (utilities,
no CSS-import dependency) and render correctly in isolation.

Geometry proof on the deterministic `InspectorConfigBlock/Overridden` story (no store):

| Element | Legacy-in-story | Migrated | Legacy CSS value (HEAD) |
|---|---|---|---|
| block body `padding-top` | 0px (rule not loaded) | 12px | `.wb-inspector-block__body { padding: var(--space-md) }` = **12px** ✓ |
| block head height | 20px (rule not loaded) | 33px | head `padding: var(--space-sm) var(--space-md)` + chevron 16px ✓ |

The migrated values **match the legacy CSS exactly** — the migrated render reproduces what
the legacy shows **in the real app** (where `workflows-builder.css` is loaded); the legacy
*story* simply lacked that CSS. So the large isolated-story pixel diffs
(inspector 40% mobile / 5.85% desktop, sidebar 27% mobile) are the missing-CSS artifact,
not drift.

### Mobile width — ancestor-scoping harness artifact

Legacy mobile full-width for the builder panels was ancestor-scoped:
`.app[data-page="workflow-builder"] .wb-inspector { width:100%; min-width:0; flex:1;
border-left:none }` (and the `.wb-sidebar` equivalent). The migration transcribes the
**identical values** as unconditional `max-768:` utilities (`max-768:w-full
max-768:min-w-0 max-768:flex-1 max-768:border-l-0`). Proof: injecting
`.app[data-page=workflow-builder][data-mobile-panel=inspector]` onto the legacy story's
ancestor flips the legacy panel to the same `flex:1` behaviour as the migrated one. In the
real app (always inside `.app[data-page=workflow*]`) both render identically; the isolated
story lacks the `.app` ancestor so the legacy panel keeps its 340px base width.

## Analytical CSS faithfulness (element-by-element, HEAD vs migrated)

Every migrated value was verified against the legacy rule it replaces:
config-block box (`border` 1px + `border-l-2` accent + `rounded-md` + `bg-surface` + `p-0`
+ `mb-sm`), source-variant left-accent + badge colours, badge pill (`px-8 py-2`
`rounded-full`), body (`p-md` + `border-t` + `bg-base` + `rounded-b-[calc(radius-md-1)]`),
foot (`mt-md flex justify-end gap-sm`), field editors (`wb-editor-stack`→`flex flex-col
gap-sm`, `wb-editor-field`→`flex flex-col gap-[4px]`, `wb-editor-segmented`/`-option`
verbatim), tab strip (`cc-tabs`/`cc-tab`→`WB_TABS`/`WB_TAB`, 5px/10px padding, min-h-28,
gap-2px, p-3px), chevron/label leaf recipes. Spacing tokens map 1:1
(`--spacing-sm`→`--space-sm`=8px, `--spacing-xs`=4px). The selects are the unchanged shared
`ModelSelector`/`ReasoningLevelSelector` styled by the unchanged global `.form-input`.

## Leaf-recipe swaps (the prior halt's blocker)

No graph/builder element carries a legacy leaf class anymore (grep-verified):
`cc-tabs`/`cc-tab` → wave-local `WB_TABS`/`WB_TAB` (the shared Tabs primitive can't carry
the mobile parity overrides); `empty-state*` → `EmptyState` primitive; `cc-section-*` →
inlined utilities in InspectorConfigBlock; `mobile-bottom-bar` usage → migrated pattern in
WorkflowMobileTabBar (the globals.css rule stays — owned by b6-globals-message-chrome). The
leaf RULES themselves stay in globals.css for B-final's consumer-gated delete (e.g.
`.cc-section-*` is still consumed by `SessionGitPanel.tsx`, a different context's surface).

## Reopen fixes (v3) — tokens.css ownership + native button chrome

Two validator-flagged issues were resolved without altering the migrated geometry:

1. **tokens.css ownership** — a prior attempt minted the ~27-color parity-only graph
   palette in `tokens.css`, violating the b6-foundation-only ownership boundary. Reverted.
   The gap colors are now reproduced as **inline raw literals inside arbitrary utilities**
   (byte-identical values), which is lint-clean because these dirs are not in eslint
   `MIGRATED_UTILITY_FIRST` (`no-hardcoded-color` does not run on them). Central
   tokenization + the remaining allowlist sync are deferred to integration — full spec in
   [`.cc/graph-workflow-docs/b6-graph-builder-foundation-gap.md`](../../../../.cc/graph-workflow-docs/b6-graph-builder-foundation-gap.md).
   Proof of value-identity: `node-running-v3` vs the legacy `before-desktop/node-running`
   = **0.15%** (the `pulse-node` glow animation only, matching the 0.20% above).

2. **Native button chrome** — with Preflight OFF and no `button{}` rule in `reset.css`,
   `bg-transparent` equals the *initial* `background-color`, so the browser keeps native
   light button chrome on transparent-bg/no-border buttons. Added explicit `appearance-none`
   to each such migrated button. `after-desktop/configblock-header-closeup-v3` shows the
   InspectorConfigBlock head rendering fully dark; computed style of the head button is
   `appearance: none; background-color: rgba(0,0,0,0)`.

## Files

`before-{desktop,mobile}/` and `after-{desktop,mobile}/`: node-running (valid parity),
inspector-context-tab, sidebar-with-footer, exec-inspector-overview, configblock-overridden.
Builder befores are the under-styled legacy harness renders described above; the afters are
the correct self-contained migrated renders. `*-v3` afters (configblock-overridden,
configblock-header-closeup, node-running, node-completed) capture the reopen fixes above.
