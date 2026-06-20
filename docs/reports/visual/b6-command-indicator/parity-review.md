# B-6 globals message/mobile chrome — parity review

**Outcome: GO.** 12/12 before/after screenshots byte-identical
(sha256) at the two fixed viewports (desktop 1440×900, mobile 390×844).

## Scope migrated this slice

- **CommandIndicator.tsx** — full chrome → utilities (`.command-indicator`,
  `.command-name`, `.command-args`, `.command-indicator--expanded`, and the two
  `.conversation[data-backend="codex"] …` ancestor overrides). The codex violet
  override is an arbitrary ancestor variant `[.conversation[data-backend=codex]_&]:`
  (no `group` hook needed on the out-of-component `.conversation` parent).
  `.command-indicator__body` (and its `p/ul/ol/li/:first-child/:last-child`
  descendant rules) is **kept** in globals.css — it styles react-markdown
  generated output (preserved-CSS, R6).

## Gotcha resolved: unlayered legacy `.text-cyan` beats the layered override

`typography.css` defines unlayered `.text-cyan` / `.text-violet`. The bare
`text-cyan` base class therefore resolves through the **unlayered legacy** rule,
which beats any layered `@layer utilities` rule regardless of specificity. The
codex override (`[…]:text-violet`, layered, specificity 0,3,0) silently lost to
unlayered `.text-cyan` (0,1,0) → the codex command name rendered cyan instead of
violet. **Only the screenshots caught this** (the codex story differed; the other
5 were already identical). Fix: `!important` on the override
(`[…]:text-violet!`) — the project's established remedy for "unlayered legacy
beats layered utility" (same pattern as the B-4 `text-*!` link fix). The
`border-l-violet` override needed no `!` because there is no unlayered
`.border-cyan` competitor.

## Dead globals.css rules deleted (grep-verified 0 consumers)

`.collaboration-status-card*` (component deleted in a prior stage),
`.virtuoso-fallback`, `.msg-editor-*`, `.msg-actions-confirm-label`,
`.msg-nav .nav-counter` (the component renders `.msg-counter`, never
`.nav-counter`), `.mobile-actions`.

globals.css selector+keyframe count: **309 → 278** (`css:progress --check` passes;
baseline ratcheted).

## Method

`#storybook-root` element screenshots of all 6 CommandIndicator stories at both
fixed viewports, captured against a private Storybook on this worktree's own port
(6017 — `ensure_dev_server`/6006 resolve to the prefix-sibling worktree). "Before"
= the same stories with `CommandIndicator.tsx` + `globals.css` git-stashed to the
pre-slice state (HMR rebuild), restored after capture. Byte-identical sha256 ⇒ zero
visual change.
