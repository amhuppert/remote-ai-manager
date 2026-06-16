# workflows-catalog — Tailwind migration visual-parity evidence

Before/after screenshots for the Stage B-1 workflows-catalog Tailwind migration,
captured at the conventions doc's fixed viewports (`docs/tailwind-conventions.md`
§4.3 / §"Fixed viewport dimensions"):

- **Desktop:** 1440 × 900
- **Mobile:** 390 × 844

`before-*` = legacy CSS (`.workflow-*` / `.mc-*`), captured by stashing the
migration on this session worktree. `after-*` = the migrated build (utilities +
shared primitives + wave-local `PanelTab`). Both rendered from the same Next dev
server in this worktree.

| Pair | Surface |
|---|---|
| `*-index-desktop.png` | `/workflows` index grid (full page) |
| `*-index-mobile.png` | `/workflows` index (full page, single column) |
| `*-detail-desktop.png` | `/workflows/conversation` canvas + rail |
| `*-detail-mobile.png` | `/workflows/conversation` mobile (tabs + diagram panel) |

**Result: parity confirmed — no visible drift at either viewport on either
surface.** `before-index-desktop.png` and `after-index-desktop.png` are
byte-identical; the rest differ only by sub-perceptible PNG-encoding noise.
The selected-node state (cyan border/glow, highlighted edges, selected-state
rail with the cyan "initial" tag) was additionally spot-checked live.

> Evidence lives here, under this wave's ownership, rather than the conventions'
> canonical `docs/reports/visual/<slice>/` — `docs/reports/*` is outside this
> parallel wave's write scope (charter non-goals / OWNERSHIP). Stage B-2 / the
> integration context may relocate it.
