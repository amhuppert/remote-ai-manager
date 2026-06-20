# B-6 ConversationPanel chrome + prompt + ctx-menu — parity review

Migrated the B-4-deferred ConversationPanel shell chrome (conversation.css), the
prompt surface (prompt.css), and the sidebar context menu (`.ctx-menu*`), and
deleted the now-dead `.session-status` / `.si-*` conversation.css rules.

## Parity method

Byte-identical before/after capture (per `tailwind-parity-screenshot-method`):
private Storybook on the own-worktree port (6019), Playwright at the two fixed
viewports (desktop 1440×900, mobile 390×844, device-scale-factor 1). "before" =
`git stash` of `src/` back to the pre-migration commit (Storybook HMR recompiles),
"after" = the migrated tree. sha256 compared.

Stories captured: `Session/ConversationSidebarRowContextMenu` (Default +
WithDangerItem — exercises items, divider, kbd hint, danger tone) and
`Session/PromptInputArea` (Default + Sending — the prompt composer textarea +
toolbar). ConversationPanel itself has no Storybook story; its shell chrome is
verified by compiled-CSS selector equivalence (below).

## Result — GO

| Surface | desktop | mobile |
|---|---|---|
| ctx-menu Default | IDENTICAL | IDENTICAL |
| ctx-menu WithDangerItem | IDENTICAL | IDENTICAL |
| PromptInputArea Default | IDENTICAL | IDENTICAL |
| PromptInputArea Sending | animation-only* | IDENTICAL |

\* `prompt-sending-desktop` differs only because the story renders a live
spinning loader (`.spinner`, a CSS animation untouched by this slice). Two
captures of the *same* after-state also differ — confirmed non-deterministic
animation phase, not a regression. The mobile capture is identical because the
desktop toolbar (and its spinner) is hidden under `max-768:hidden`.

## ConversationPanel shell — verified by compiled-CSS selector equivalence

No story exists. Each deleted conversation.css/prompt.css rule has a 1:1 utility
equivalent confirmed in the production build's compiled CSS, e.g.:

- `.conversation-stage:has(.ask-question-overlay) .panel-body{padding-bottom:58px}`
  → `group-has-[.ask-question-overlay]/stage:pb-[58px]` emits
  `:is(:where(.group/stage):has(.ask-question-overlay) *){padding-bottom:58px}`
  (and the `[data-compact=true]` → 66px variant).
- `.prompt-panel[data-agent=codex] > .panel-header{background:linear-gradient(...);border-bottom-color}`
  → `group-data-[agent=codex]/panel:bg-[linear-gradient(...)]` +
  `group-data-[agent=codex]/panel:border-b-[var(--cc-violet-a18)]`.
- New tokens `--cc-violet-a18`, `--cc-stop-{border,bg,bg-hover,glow}`,
  `--cc-red-border` all resolve in compiled CSS.

Gates: `bun run lint`, `bun run typecheck`, `bun run build`, targeted Vitest, and
`bun run css:progress --check` (conversation.css 137→88, prompt.css 26→12, both
above floor) all pass.

## Re-run delta — conv-stop button repointed to the canonical foundation tokens

The first pass minted its own `--cc-stop-{border,bg,bg-hover,glow}` set before the
b6-foundation context existed. Per `.cc/graph-workflow-docs/b6-foundation-tokens.md`,
the canonical parity-only family is `--cc-red-soft-*`, byte-identical to the
`--cc-stop-*` copies:

| `--cc-stop-*` (retired in B-final R9) | canonical `--cc-red-soft-*` | value |
|---|---|---|
| `--cc-stop-border`   | `--cc-red-soft-a45` | `rgba(248,113,113,0.45)` |
| `--cc-stop-bg`       | `--cc-red-soft-a08` | `rgba(248,113,113,0.08)` |
| `--cc-stop-bg-hover` | `--cc-red-soft-a14` | `rgba(248,113,113,0.14)` |
| `--cc-stop-glow`     | `--cc-red-soft-a25` | `rgba(248,113,113,0.25)` |

`ConversationPanel.tsx` now reads `border-[var(--cc-red-soft-a45)]`,
`bg-[var(--cc-red-soft-a08)]`, `hover:bg-[var(--cc-red-soft-a14)]`,
`hover:shadow-[0_0_12px_var(--cc-red-soft-a25)]` (text + hover border keep the
existing `--red`). Because the values are byte-identical, the Stop button's
computed styles (default + hover) are unchanged — parity is preserved **by
construction**, so the prior IDENTICAL captures still hold. The dead `--cc-stop-*`
tokens stay in `tokens.css` (not editable from this migration slice) and are
retired in the B-final R9 dedup.
</content>
