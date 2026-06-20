# CSS Ownership Inventory & Preserved-CSS Catalog

> GENERATED FILE — do not edit by hand. Regenerate with `bun scripts/css-inventory.ts` (verify with `--check`).
> Source of truth: the `OWNERS` catalog in `scripts/css-inventory.ts` (taxonomy + residual prose) plus live marker detection over `src/**/*.css`.

Tailwind migration task 1.1 (requirements 6.1, 6.2, 7.1, 8.1). Maps every CSS owner to a migration **taxonomy** and records the **preserved-CSS residual** it keeps forever. Feeds the progress ratchet's residual floors (task 6.x) and the conventions doc's do-not-convert catalog (task 1.5).

**Owners:** 26 CSS files under `src/` · **approx. declaration blocks:** 482. The 3 prototype stylesheets under `command-center-multi-tasking-ui-improvements/` are a design reference, not part of the app CSS pipeline, and are intentionally excluded.

## Taxonomy

| Taxonomy | Meaning |
| --- | --- |
| `foundation` | tokens, reset, base typography, the import index, the global entry stylesheet |
| `canonical-primitive` | shared `.cc-*` recipes that become React primitives |
| `feature-layout` | layout + appearance scoped to one feature surface |
| `generated-content` | styling for renderer output (markdown / syntax-highlighter / Mermaid) |
| `vendor` | styling for third-party library DOM (React Flow / Tiptap) |
| `animation` | a file dominated by `@keyframes` |
| `one-off` | a small single-purpose / placeholder file |

Each owner gets one **primary** taxonomy. `canonical-primitive`, `generated-content`, and `animation` have **no dedicated file** in CC — the `.cc-*` recipes live appended in `globals.css` / `typography.css`; markdown/Mermaid styling lives inside `globals.css` / `conversation.css`; keyframes are interleaved throughout. These are surfaced as **also-contains** below and enumerated in the preserved-CSS catalog.

## Owner inventory

| Owner | Taxonomy | Also contains | ~blocks | Detected markers | Preserved-CSS residual |
| --- | --- | --- | ---: | --- | --- |
| `src/app/globals.css` | `foundation` | `canonical-primitive`, `generated-content`, `animation`, `one-off` | 206 | markdown/Mermaid, scrollbars, keyframes×20 | PRESERVED: scrollbar styling (`::-webkit-scrollbar*`); tooltip/modal/toast/notification-panel portal positioning (`.tooltip-portal`, `.modal-overlay`, `.np-backdrop`); rendered-markdown output (`.markdown-content`/`.markdown-viewer`/`.markdown-fallback`); the global `@keyframes` library. The leaf-recipe swap wave deleted every consumer-free canonical recipe (`.btn-icon`, `.btn-toggle*`, `.empty-state*`, `.cc-section-*`, `.form-*`, `.cc-toast`); the recipes still present (`.btn*`, `.btn-icon-only*`, `.cc-tabs`/`.cc-tab*`, `.status-dot*`, `.modal*`) each retain ≥1 escape-hatched prod consumer and are tracked above the preserved floor for a follow-up remediation wave (see `.cc/graph-workflow-docs/integration-retained-recipes.md`). |
| `src/components/workflow-graph/workflow-graph.css` | `vendor` | `animation` | 59 | react-flow, scrollbars, keyframes×7 | PRESERVED (whole file): targets React Flow (`@xyflow/react`) vendor DOM (`.react-flow__*`, handles, edges, minimap, controls) + its own scrollbars + 7 graph `@keyframes`. Stays bespoke forever (decision 4 / R6.1). Migrated LAST and only its JSX-authored chrome — never the vendor DOM (Stage B 9.1). |
| `src/features/_root/spawn-card/spawn-card.css` | `feature-layout` | — | 0 | — | None preserved — fully migratable feature layout (`.spawn-card*`). |
| `src/features/_root/styles/approval-gate.css` | `feature-layout` | — | 0 | — | None preserved (`.approval-gate*`; references the shared `pulse-dot` keyframe). |
| `src/features/_root/styles/conversation-panes.css` | `feature-layout` | — | 3 | — | None preserved (`.pane*` split-screen layout). |
| `src/features/_root/styles/conversation-tabs.css` | `feature-layout` | — | 0 | — | None preserved (`.conversation-tab*` tab strip; add-conversation menu). |
| `src/features/_root/styles/conversation.css` | `feature-layout` | `vendor`, `generated-content`, `animation` | 100 | ProseMirror, markdown/Mermaid, scrollbars, keyframes×6, reduced-motion | PRESERVED: Tiptap `.ProseMirror` editor DOM; Mermaid output (`.mermaid*`, `mermaid-overlay-fadein`); rendered markdown/code; one `::-webkit-scrollbar`; `@media (prefers-reduced-motion)`; AskQuestion overlay/scrim portal positioning; atmospheric `rainbow-*` keyframes. Only the authored conversation chrome migrates. |
| `src/features/_root/styles/dialogs.css` | `feature-layout` | — | 4 | — | PRESERVED: modal overlay/backdrop portal positioning for the conflict-resolution dialog (`.cr-*`). Authored dialog content migrates. |
| `src/features/_root/styles/index.css` | `foundation` | — | 0 | — | None — pure `@import` aggregator for the 15 _root partials. |
| `src/features/_root/styles/keyboard-shortcuts-modal.css` | `feature-layout` | — | 6 | — | PRESERVED: modal portal positioning (`.hotkey-help*`). Authored content migrates. |
| `src/features/_root/styles/prompt.css` | `feature-layout` | `animation` | 2 | — | PRESERVED: atmospheric `rainbow-*` keyframes / rainbow-border effect. Authored prompt chrome migrates. |
| `src/features/_root/styles/reset.css` | `foundation` | — | 5 | body-atmospherics | PRESERVED: body atmospherics — `body::before` (noise-texture overlay) + `body::after` (scanline overlay) stay scoped forever (decision 4 / R6.2). The base reset (`*`, `html`, `body`) is the reconciled canonical base reset — Preflight is not imported (recommended Option A, pending ratification at the B-final human gate; R9.3). Stays in `@layer base`. |
| `src/features/_root/styles/session.css` | `feature-layout` | `animation` | 28 | keyframes×3 | None hard-preserved. `session-status-pulse` / `debug-rec-pulse` / `info-details-pop-in` keyframes reconciled in the token bridge; dense authored session layout migrates. |
| `src/features/_root/styles/shell.css` | `feature-layout` | — | 9 | — | None preserved (`.app[data-page]` grid template). Responsive layout migrates 1:1. |
| `src/features/_root/styles/sidebar-nav.css` | `one-off` | — | 0 | — | None — empty reserved placeholder (comment only, no rules). |
| `src/features/_root/styles/sidebar.css` | `feature-layout` | — | 0 | — | None preserved (`.convo-sidebar*`). Responsive layout — incl. the `min-width:769px` desktop companion — transcribes 1:1 via `max-*`/`min-*` variants. |
| `src/features/_root/styles/theme.css` | `foundation` | — | 2 | — | None (no DOM-targeting rules). The Tailwind v4 `@theme` token surface — currently a minimal sanity token + a spike `@source inline` safelist; the token-bridge context populates the full alias + extract lanes. Imported by globals.css alongside the Tailwind layer imports. |
| `src/features/_root/styles/tokens.css` | `foundation` | — | 1 | react-flow | None (no DOM-targeting rules). Entire file is the CSS-custom-property token source and the Stage-A alias-bridge surface for `@theme`; removed only in Stage B token finalization. |
| `src/features/_root/styles/topbar.css` | `feature-layout` | — | 9 | — | None preserved (`.topbar*`; references the shared `pulse-dot` keyframe). |
| `src/features/_root/styles/typography.css` | `foundation` | `canonical-primitive` | 12 | — | Base element typography preserved as part of the reconciled base reset (Preflight not imported). The dead `.cc-*` typography helpers were deleted; the surviving rules are the utility-shaped `.text-*` color helpers (retire in the R9 token/alias-collapse pass) plus `.cc-diff`. |
| `src/features/project-detail/cockpit/styles/cockpit.css` | `feature-layout` | `animation` | 13 | keyframes×3, reduced-motion | PRESERVED: diff slide-over portal positioning (`.plc-diff-*`) + `@media (prefers-reduced-motion)`. `plc-*` keyframes reconciled in the token bridge; cockpit/spawn-card design-system brittle assertions deleted on migration (Stage B 7.7). |
| `src/features/project-detail/styles/project-detail.css` | `feature-layout` | `animation` | 5 | keyframes×1 | None hard-preserved. The leaf-recipe swap wave deleted every `.cc-*` recipe (`.cc-primary*`, `.cc-ibtn*`, `.cc-checkbox*`, `.cc-toast`) — all were consumer-free after their ProjectDetailView/CCCheckbox consumers swapped to primitives/inline utilities. What remains: the page-level `.main` layout override (targets a shared shell class), the `.project-detail-shell` flex column, and the preserved `kebab-in` keyframe. |
| `src/features/projects-index/styles/projects-index.css` | `feature-layout` | — | 0 | — | None preserved (`.project-card*`). This is the Stage-A pilot surface (ProjectCard + a leaf control). |
| `src/features/session-diff/styles/session-diff.css` | `feature-layout` | — | 0 | — | None preserved (`.session-diff-*` full-page diff). |
| `src/features/session/sidebar/styles/PeekPopover.css` | `feature-layout` | `vendor`, `animation` | 14 | ProseMirror, keyframes×3 | PRESERVED: Tiptap `.ProseMirror` editor DOM (second location, after conversation.css); peek modal portal/backdrop positioning; `peek-*` keyframes. Only the authored peek chrome migrates. |
| `src/features/workflows-catalog/styles/workflows-catalog.css` | `feature-layout` | — | 4 | — | None preserved (`.workflow-*` catalog + `.mc-*` machine-canvas primitives). |

## By taxonomy

### `foundation` — 6 owner(s)

- `src/app/globals.css`
- `src/features/_root/styles/index.css`
- `src/features/_root/styles/reset.css`
- `src/features/_root/styles/theme.css`
- `src/features/_root/styles/tokens.css`
- `src/features/_root/styles/typography.css`

### `vendor` — 1 owner(s)

- `src/components/workflow-graph/workflow-graph.css`

### `feature-layout` — 18 owner(s)

- `src/features/_root/spawn-card/spawn-card.css`
- `src/features/_root/styles/approval-gate.css`
- `src/features/_root/styles/conversation-panes.css`
- `src/features/_root/styles/conversation-tabs.css`
- `src/features/_root/styles/conversation.css`
- `src/features/_root/styles/dialogs.css`
- `src/features/_root/styles/keyboard-shortcuts-modal.css`
- `src/features/_root/styles/prompt.css`
- `src/features/_root/styles/session.css`
- `src/features/_root/styles/shell.css`
- `src/features/_root/styles/sidebar.css`
- `src/features/_root/styles/topbar.css`
- `src/features/project-detail/cockpit/styles/cockpit.css`
- `src/features/project-detail/styles/project-detail.css`
- `src/features/projects-index/styles/projects-index.css`
- `src/features/session-diff/styles/session-diff.css`
- `src/features/session/sidebar/styles/PeekPopover.css`
- `src/features/workflows-catalog/styles/workflows-catalog.css`

### `canonical-primitive` — 0 owners

No file has this as its **primary** taxonomy; it appears only as an interleaved concern (see also-contains + preserved-CSS catalog).

### `generated-content` — 0 owners

No file has this as its **primary** taxonomy; it appears only as an interleaved concern (see also-contains + preserved-CSS catalog).

### `animation` — 0 owners

No file has this as its **primary** taxonomy; it appears only as an interleaved concern (see also-contains + preserved-CSS catalog).

### `one-off` — 1 owner(s)

- `src/features/_root/styles/sidebar-nav.css`

## Preserved-CSS do-not-convert catalog

DOM CC does not author in JSX, body atmospherics, scrollbars, keyframes, and portal positioning stay as scoped CSS forever (decision 4 / R6). Detected occurrences (live, by marker):

| Preserved category | Owners holding it |
| --- | --- |
| React Flow vendor DOM (`.react-flow*` / `.xyflow*`) | `src/components/workflow-graph/workflow-graph.css`, `src/features/_root/styles/tokens.css` |
| Tiptap `.ProseMirror` editor DOM | `src/features/_root/styles/conversation.css`, `src/features/session/sidebar/styles/PeekPopover.css` |
| Markdown / syntax-highlighter / Mermaid output | `src/app/globals.css`, `src/features/_root/styles/conversation.css` |
| Body atmospherics (`body::before` / `body::after`) | `src/features/_root/styles/reset.css` |
| Scrollbars (`::-webkit-scrollbar*`) | `src/app/globals.css`, `src/components/workflow-graph/workflow-graph.css`, `src/features/_root/styles/conversation.css` |
| `@keyframes` definitions | `src/app/globals.css`, `src/components/workflow-graph/workflow-graph.css`, `src/features/_root/styles/conversation.css`, `src/features/_root/styles/session.css`, `src/features/project-detail/cockpit/styles/cockpit.css`, `src/features/project-detail/styles/project-detail.css`, `src/features/session/sidebar/styles/PeekPopover.css` |
| Reduced-motion blocks (`prefers-reduced-motion`) | `src/features/_root/styles/conversation.css`, `src/features/project-detail/cockpit/styles/cockpit.css` |

Portal/overlay positioning is preserved per R6.2 but is not a single machine-detectable token; it is recorded per-owner in the residual column (globals.css tooltip/modal/toast, conversation.css AskQuestion overlay, dialogs.css `.cr-*`, keyboard-shortcuts-modal, cockpit.css diff slide-over, PeekPopover backdrop).

## `@keyframes` census

| Owner | Keyframes |
| --- | --- |
| `src/app/globals.css` | `bulk-float-in`, `cmdReveal`, `ds-panel-in`, `ds-sheet-in`, `fadeIn`, `fadeInOut`, `library`, `library`, `mcp-skeleton-shimmer`, `np-backdrop-in`, `np-slide-in`, `pulse-border`, `pulse-dot`, `slideUp`, `slideUpSheet`, `spin`, `staggerReveal`, `toastSlideIn`, `toastSlideOut`, `voice-recording-pulse` |
| `src/components/workflow-graph/workflow-graph.css` | `dash-flow`, `merging-chevron`, `pulse-dot`, `pulse-node`, `pulse-node-merging-selected`, `pulse-node-selected`, `pulse-node-validating-selected` |
| `src/features/_root/styles/conversation.css` | `ask-question-scrim-in`, `collab-card-pulse`, `mermaid-overlay-fadein`, `rainbow-border-shift`, `rainbow-shift`, `typingBounce` |
| `src/features/_root/styles/session.css` | `debug-rec-pulse`, `info-details-pop-in`, `session-status-pulse` |
| `src/features/project-detail/cockpit/styles/cockpit.css` | `plc-diff-scrim-in`, `plc-diff-slide-in`, `plc-rise-fade` |
| `src/features/project-detail/styles/project-detail.css` | `kebab-in` |
| `src/features/session/sidebar/styles/PeekPopover.css` | `peek-dot-pulse`, `peek-fade`, `peek-in` |

