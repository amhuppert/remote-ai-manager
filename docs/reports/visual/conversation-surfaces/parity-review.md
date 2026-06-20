# B-4 conversation-surfaces — parity review

Slice: the conversation.css conversation-surface families + B-3-deferred debt.
Migrated to utilities + `data-*` class maps and deleted from `conversation.css`
(311 → 178 tracked selectors; `css:progress --check` green, floor 39):

- `convo-list-*` / `convo-card*` / `convo-badge*` (ConversationList) + the
  `ConversationStatusDot` (`.session-status` reproduced as a `data`-keyed map)
  and the directly-rendered `.convo-list-meta .si-*` strip items
- `spec-browser*` (SpecBrowser), `docs-panel*` (DocsPanel)
- `workflow-card*` / `gw-launcher*` (GraphWorkflowCard — NOT `.graph-workflow*`)
- `commit-*` incl. the timeline `::before`/`::after` rail+node and the dead
  `.commit-diff-inline .diff-file-section` (CommitHistory — B-3 debt)
- `file-mention-chip*` / `conversation-mention-chip*` (the chips; the shared
  `.slash-command-chip` rules were split out and kept for the prompt slice)
- `right-pane*` / `right-pane-tabs` (RightPane), `synthetic-fork-badge`

## Method

Same-session before/after at the two fixed viewports (desktop 1440×900, mobile
390×844, DSF 1) via a **private Storybook in this worktree (`:6091`)** — CC's
`ensure_dev_server` resolves to the prefix-sibling `…3204f2`, not
`…3204f2.slice-collab`, so the shared server cannot see this slice's code.
"before" = the committed merge-base (`git stash` of the 11 working-tree files →
Vite HMR re-renders the legacy tree), "after" = the migrated tree (stash popped).
Playwright capture + `sharp` sha256 + per-channel pixel-diff, scripts run from
`/tmp` (outside the worktree). Animations + caret frozen via an injected reset.
A determinism control (same state captured twice) was **26/26 byte-identical**,
so any before/after delta is a real rendering change, not capture noise.

## Result — 26/26 byte-identical (6 story-backed surfaces × states × 2 viewports)

`docs/reports/visual/conversation-surfaces/{before,after}/` — every pair is
sha256-identical:

| Surface | Stories | Viewports |
|---|---|---|
| synthetic-fork-badge | `components-syntheticforkbadge--default` | desktop+mobile |
| conversation-mention-chip | `--default`, `--selected`, `--truncated` | desktop+mobile |
| spec-browser | `--features-nav`, `--feature-content`, `--steering-nav` | desktop+mobile |
| gw-launcher | `--with-definitions`, `--with-error` | desktop+mobile |
| workflow-card (execution status) | `--running`, `--completed` | desktop+mobile |
| commit (timeline) | `--multiple-commits`, `--single-commit` | desktop+mobile |

## One real regression caught by the screenshots and FIXED

**gw-launcher links rendered text-primary, not text-tertiary.** The
"Edit definitions" / "Build a workflow definition" links are `<a>` (next/link).
typography.css ships an UNLAYERED `a { color: inherit }` that outranks the
layered `text-text-tertiary` utility (cascade layers: unlayered > `@layer
utilities`), so the link inherited `--text-primary` (#dce2f0) instead of
`--text-tertiary`. The legacy `.gw-launcher-link { color: var(--text-tertiary) }`
won by specificity (unlayered 0,1,0 > `a` 0,0,1); the migrated utility could not.
Fixed with Tailwind's important modifier — `text-text-tertiary!` / `hover:text-cyan!`
— which beats the unlayered rule. (The `<div>` label with the same class was
already correct; only `<a>` hits `a { color: inherit }`. The `workflow-card` /
`convo-card` `<Link>`s are unaffected — their visible text lives in child
elements that set their own colours, and their own `text-inherit` matches
`a { color: inherit }`.)

## Dev-story fixture refresh

`ConversationMentionChip.stories.tsx`'s `ChipPreview` hard-coded the legacy
`.conversation-mention-chip*` markup (the chip is a Tiptap NodeView, not directly
renderable in a story). After the rules were deleted the preview lost its
background/border/colour. Refreshed the fixture to mirror the real component's
utility recipe — the owning-feature fixture refresh flagged in
`b4-shared-conversation-components-notes.md`. (This is the only non-component,
non-CSS file touched.)

## Attempt-2 corrections — ConversationList legacy-owned elements finished

The first validation correctly found ConversationList (an owned file) still
rendered legacy-owned elements from the migrated surface. All now migrated, and
the formerly-retained `.convo-card-meta` / `.convo-card-archive-btn` rules
DELETED from conversation.css (178 → 175 selectors; ratchet green):

- **The 6th `si-sep`** (after the Context button) was missed → it fell through to
  session.css's bare `.si-sep` (16px) once the `.convo-list-meta .si-sep` override
  was deleted. Now migrated to the same `inline-block h-[12px] w-px shrink-0
  bg-border-subtle` as the other five — reproducing the merged session.css-base +
  conversation.css-override computed style (12px, border-subtle). No `si-sep`
  consumer remains, so the deleted override is justified.
- **The id span** (`convo-card-meta convo-card-id`) → fully utility-migrated to
  `font-mono text-[0.72rem] text-text-tertiary opacity-70 hover:cursor-pointer
  hover:text-cyan hover:opacity-100` — the merged computed style (conversation.css
  `.convo-card-meta` font-size + session.css `.convo-card-id` opacity/hover, the
  latter loads earlier so the former wins font-size; both set font-mono/tertiary).
  `.convo-card-meta` (mine) now has no consumer → deleted. `.convo-card-id`
  (session.css/B-5) is left as a now-dead rule, not this slice's to delete.
- **The two archive/rename buttons** (`btn-icon-only convo-card-archive-btn`) →
  the `IconButton` primitive (`variant="square" layoutClassName="ml-auto"`).
  CASCADE PROOF that this is byte-identical: globals.css's `.btn-icon-only`
  (line 344) loads AFTER conversation.css (imported at globals.css:40), so on the
  same-specificity (0,1,0) conflict it OVERRIDES every `.convo-card-archive-btn`
  appearance property (font-size, color, border, hover) — the ONLY surviving
  effect was `margin-left: auto`. So the effective legacy = `.btn-icon-only` +
  `ml-auto` = `IconButton square` (proven == `.btn-icon-only` in B-2/B-3) +
  `layoutClassName="ml-auto"`. `.convo-card-archive-btn`'s appearance was already
  dead; the rule is deleted, `ml-auto` reattached via the layout allowlist.
- **Card rgba literals** → existing token vars / token-var color-mix (no raw
  literal): most-recent border `var(--cc-cyan-a35)`, imported bg `var(--cc-cyan-a10)`,
  archived-badge bg `color-mix(in_srgb,var(--text-secondary)_10%,transparent)`
  (= rgba(123,137,159,0.1); `--text-secondary` IS #7b899f; no solid-color token at
  that alpha, so the §8.3 var-in-arbitrary form, same idiom as the ask-question
  scrim). All three confirmed present in the build CSS.

The topbar **delete** button (`btn-icon-only danger`) in the Topbar sessionControls
is intentionally NOT migrated: it is a topbar session-control (alongside the
un-flagged `.status-indicator` / `.topbar-sep`) coupled to globals.css's
`.topbar-status-session .btn-icon-only` mobile descendant rule — dropping the class
would break that rule. It is the topbar surface (B-5), not a conversation-surface
family (the validator did not flag it).

The 6 story-backed surfaces above were unchanged this round, so their 26/26
byte-identical captures remain valid.

## Surfaces verified by 1:1 transcription (no isolatable story)

Per the Stage B-3 precedent (SessionActionsMenu / InfoDetailsPopover), surfaces
with no isolatable Storybook story are verified by a 1:1 rule→utility
transcription + the passing unit suite + the production build (every utility,
incl. the `:has`/`before:`/`after:` timeline variants and stacked `data-*`
chip variants, was confirmed present in the build CSS) rather than screenshots:

- **DocsPanel** (`docs-panel*`), **RightPane** (`right-pane*`) — layout/colour
  token utilities only; `<button>`-based, so the unlayered-`a` trap above does
  not apply. RightPane keeps `right-pane`/`right-pane-body` as structural hooks
  for the preserved `.markdown-viewer` / non-owned `.sidebar-diff-panel`
  descendant rules.
- **FileMentionChip** — same chip recipe as the byte-identical
  ConversationMentionChip (minus the codex border, plus the `__ext` badge).
- **ConversationList** card grid / badges / status-dot / rename input + the
  `.convo-list-meta .si-*` strip — `<span>`/`<div>`/`<input>` (not `<a>`);
  covered by the green `ConversationsPage` / `SessionContent` suites.

## Retained residuals + ctx-menu deferral

See the slice's `complete_task` summary and the css-inventory floor. In short:
`.session-status` (SessionInfoStrip), `.convo-rename-input` (ConversationSidebar),
`.convo-list-meta .si-item/.si-label/.si-val` (CopyableId), `.convo-card-meta` +
`.convo-card-archive-btn` (the id span / `.btn-icon-only`-bonded buttons), and
the `.right-pane*` descendant rules are retained because non-owned consumers
still use them. **`ctx-menu*` was NOT migrated** — its sole consumer
(`ConversationSidebarRowContextMenu.tsx`) is outside this slice's file allowlist
and a B-3-registered guardrail path whose `rgba(255,255,255,0.02)` shadow needs a
new token (which waves defer to integration); deferred to a sidebar-owning/B-5
context. RowContextMenu.tsx is byte-identical to the merge-base.
