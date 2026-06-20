# Stage B-3 — parity review (human sign-off)

Single review surface for Stage B-3 of the Tailwind migration. B-3 did two things:

1. **The ONE approved intentional visual change** — the Badge `subtle` / Tabs
   inactive-count **accessibility contrast fix** (§A below). This is the only
   pixel that is *supposed* to differ in the entire migration (Requirement R3.4
   relaxed here; R5.2 strengthened).
2. **Four confined feature-surface waves** migrated to Tailwind utilities at
   **strict parity (zero visual change)** — project-detail shell chrome, the
   add-conversation dropdown, the conversation sidebar + PeekPopover, and the
   session.css non-graph chrome (§B below).

All before/after captures live under `docs/reports/visual/<surface>/`. Each wave
captured them from a private Storybook on this worktree's own port (the shared
`ensure_dev_server` Storybook resolves to the prefix-sibling worktree), at fixed
viewports (desktop 1440×900 / 1440-wide, mobile 390×844), animations frozen,
device-scale-factor 1; "before" = the wave merge-base, "after" = the migrated
tree. Several waves verified per-pixel identity (PIL `ImageChops`).

---

## A. APPROVED a11y delta — Badge `subtle` + Tabs inactive count (the ONE intentional change)

Pre-existing Stage-A debt: both faded de-emphasized text with `opacity`, which
multiplies the text toward its background and drops it **below the WCAG AA
contrast threshold**. B-3 replaces the opacity fade with a real low-emphasis
palette / color inheritance — every state now meets AA. This is a **deliberate
visual change**, so it has no before/after "parity" pair (the point is that it
differs); it is pinned instead by automated a11y guarantees + axe.

**`Badge` `subtle`** (`src/components/ui/Badge.tsx`):
- before: `cn(base, appearance, subtle && "opacity-50", …)` — the variant faded to 50%.
- after: a dedicated `subtleAppearance = "bg-bg-raised text-text-secondary"`
  (neutral muted, **4.59:1**), selected instead of the variant; no opacity.

**`Tabs` inactive count** (`src/components/ui/Tabs.tsx`):
- before: `tabCountBase = "… opacity-[0.85] data-[active=true]:opacity-100"`.
- after: opacity removed; the count **inherits the parent tab's color**
  (inactive `text-secondary` on `bg-surface`, active `text-inverse` on cyan,
  hover `text-primary`) — every state meets AA.

Evidence (no screenshots needed — the change is intentional and contrast is a
computed property, not a visual judgment):
- `src/components/ui/primitives.test.tsx` — Badge/Tabs appearance assertions updated.
- `src/lib/shared/design-system-guarantees.test.ts` — the WCAG guarantee made
  **opacity-aware** so a future opacity-fade of de-emphasized text fails the suite.
- `Badge.stories.tsx` / `Tabs.stories.tsx` — the subtle/count stories' a11y
  parameter flipped from `"a11y": todo` to enforced (axe-verified via the
  private worktree Storybook on chromium-1223).

---

## B. Strict-parity surface waves (zero visual change)

| Surface | Captures (`docs/reports/visual/…`) | Pairs | Result |
|---|---|---|---|
| **project-detail chrome** — ProjectDetailView, SessionRows/SessionRow, CommandConsole, KebabMenu, ModeDot, StatusPill, BranchChip, CCCheckbox, CreateSessionModal, bulk | `project-detail-chrome/` | 10 (page, sessionrows ×2, console chips/slash/suggest, bulk, targets, page-mobile) | parity GO |
| **add-conversation dropdown** — AddConversationMenu (conversation-tabs.css residual) | `add-conversation-menu/` | 2 (desktop+mobile) | parity GO |
| **conversation sidebar + PeekPopover** — ConversationSidebar(+Header/Filters/Row/RowContextMenu), PeekPopover | `sidebar-peek/` | 12 (sidebar mixed/needs-you/mobile-drawer, 6 row variants, peek running/awaiting ×desktop+mobile) | parity GO |
| **session.css non-graph chrome** — DiffPanel, SessionGitPanel, DebugModeToggle, DebugStatusStrip, CommitHistory, SessionActionsMenu, InfoDetailsPopover | `session-chrome/` (+ `session-chrome/PARITY.md`) | 11 | **all 11 PIXEL-IDENTICAL** |

`session-chrome/PARITY.md` records the two bugs its screenshots caught that the
deterministic gates could not (two unstyled diff-toolbar buttons from a
single-line `replace_all`; default `<button>` UA borders because Preflight is
OFF). **SessionActionsMenu** and **InfoDetailsPopover** (popover open state) have
no isolatable Storybook story — their migration is a 1:1 rule→utility
transcription covered by the border-none audit + unit tests.

---

## C. Integration-time changes (this context) and why the wave captures stay valid

The integration step makes the migrated surfaces pass the guardrails and registers
them. **Every integration change is value-/class-identical, so the wave-captured
after-screenshots above remain representative** (same approach as the Stage B-2
review's token-extraction note):

- **Token extraction (no-hardcoded-color).** 16 inline parity rgba literals the
  waves deferred were extracted to named `--cc-*` tokens in `tokens.css` and
  referenced via `var()` — **value-identical** (e.g. `bg-[rgba(255,179,0,0.2)]` →
  `bg-[var(--cc-amber-a20)]`; reuses `--cc-shadow-popover`, `--cc-cyan-a04/a10`,
  `--cc-amber-a40`). Visually inert.
- **`cn()` conversion (no-dynamic-class).** 9 residual `` `cc-tab${…?" active":""}` ``
  conditional-suffix classNames (on preserved BEM recipes) became
  `cn("cc-tab", … && "active")` — **same classes emitted**.
- **Class-sort.** `prettier-plugin-tailwindcss` reordered classes on the newly
  registered files — **utility order does not affect applied CSS**.
- **SessionRow `layoutClassName` (no-appearance-in-layout-classname).** The wave
  placed `ModeDot`/`StatusPill` into the mobile grid via
  `layoutClassName="max-768:[grid-area:mode] …"` / `"max-768:hidden"`. The
  guardrail's `LAYOUT_ALLOWED` was missing area-based grid placement and
  responsive display. **A controlled A/B (capture with a wrapper vs. without,
  identical pipeline) proved that wrapping these primitives is NOT visually inert**
  — a wrapper that carries `grid-area` becomes the grid item and shifts the dot
  ~7px on desktop (14px-wide diff band) and changes the mobile grid ~7.5%. So the
  parity-correct original `layoutClassName` code was **kept**, and the guardrail's
  allowlist was extended to recognize `[grid-area:*]` (placement, like the
  already-allowed `col-*`/`row-*`) and `hidden` (layout-flow, not appearance);
  `docs/tailwind-conventions.md` §2 + the rule message + the rule's unit tests
  were updated to match. Zero visual change.

---

## D. Per-owner retained CSS (intentional residuals — not regressions)

The css:progress ratchet drove the five B-3 owners down; what remains is preserved
by design or deferred to a later stage (see the charter's stage map). New baseline
counts: project-detail.css **33**, session.css **246**, sidebar.css **3**,
PeekPopover.css **9**, conversation-tabs.css **1**.

- **`project-detail.css` (33).** Shared leaf recipes `cc-primary`/`cc-ibtn`/
  `cc-checkbox` (+ other `cc-*` recipes) are retired only at the **cleanup gate**
  (Stage B-final), per the non-goals.
- **`session.css` (246).** The `.graph-workflow*` / `.workflow-builder*` families
  (54 + 50 selectors) stay → **Stage B-6 (LAST)**. The git-panel header is fused
  with `.cc-section-*` (kept). `.debug-toggle__dot` base stays — rendered by
  `MobilePromptToolbar` (out of scope). `.session-info-strip`/`.si-*`/
  `.session-status` were **reverted to legacy** (co-consumed by `ConversationList`
  via conversation.css and by `CopyableId` in `src/components`) → **B-4 / B-5**.
  `CommitHistory`'s `.commit-*` + the now-dead `conversation.css`
  `.commit-diff-inline .diff-file-section` → **B-4**. `dev-servers` / `copyable-id`
  → **B-5**. `sidebar-diff-panel` hook + preserved keyframes stay.
- **`sidebar.css` (3).** `.convo-sidebar-mobile-toggle` is a cross-component anchor;
  the `.convo-sidebar` structural hooks are kept (consumed via descendant selectors
  that migrate with conversation.css in **B-4**).
- **`PeekPopover.css` (9, floor 6).** Tiptap `.ProseMirror` editor DOM + peek
  backdrop portal positioning + `peek-*` keyframes + the `@media (max-width:800px)`
  residual stay scoped forever.
- **`conversation-tabs.css` (1).** Minimal structural leftover; finishes with the
  tabs surface.

**Out of scope for B-3 (deferred, untouched):** `globals.css` and
`conversation.css` are **not modified** by B-3 (verified: empty diff); their
migratable chrome is Stage B-4 (conversation/prompt/panes) / B-5 (globals
agent-capability, dev-server, autocompletes, etc.); the graph/builder is B-6;
end-state cleanup (delete leaf recipes, remove token aliases, dedup keyframes,
Preflight) is Stage B-final.

---

## E. Gate status (integration)

- `bun run build` ✓ · `bun run build-storybook` ✓ · `bun run lint` ✓ ·
  `bun run typecheck` ✓ · full unit suite ✓ · `bun run css:progress --check` ✓.
- Ownership: no shared leaf recipe deleted (globals.css cc-tab/cc-badge/btn-/
  empty-state/form-/status- and project-detail.css cc-primary/cc-ibtn/cc-checkbox
  all present); no `.graph-workflow*` / `.workflow-builder*` rule deleted;
  globals.css + conversation.css untouched by B-3.
- Registered in all three utility-first allowlists (eslint `MIGRATED_UTILITY_FIRST`,
  `.prettierrc` class-sort, `tailwind-utility-collisions` `UTILITY_FIRST_PATHS`);
  `ConversationsPage.tsx` is collision-allowlisted only (partial: just its
  sidebar-expand-float button migrated).

**This context pauses for human review before the workflow completes.**
