# Stage B-4 — conversation / prompt / panes cluster — consolidated parity review

Stage B-4 migrated the single densest stylesheet, `conversation.css` (725 tracked
selectors, ~5200 lines), plus `prompt.css` (81) and `conversation-panes.css` (39),
to Tailwind utilities + static class maps with **zero intended visual change** —
the one approved visual change (the Badge/Tab-count contrast fix) already shipped
in B-3. This document collects every B-4 slice's before/after evidence into one
review artifact for the human sign-off gate, with per-owner residual notes.

The `conversation.css` chain ran as a **serial** lane (collab → ask-question →
shared-conversation-components → conversation-surfaces → prompt — each slice owns
its components AND deletes only its own rules from the single shared file);
`conversation-panes.css` ran as a **disjoint parallel** lane. All six upstream
slices completed and merged successfully.

## Result at a glance

| Slice | Owner families | Evidence (dir = `docs/reports/visual/<dir>/`) | Verdict |
|---|---|---|---|
| collab | `collab-*` (17 Collab* components) + D3 sr-only fix | `collab/{before,after}/*__{desktop,mobile}.png` (56 shots) + `collab/parity-report.md` | **52/56 byte-identical**; the 4 deltas are the **intentional D3 sr-only fix** (see below) |
| ask-question | `AskQuestionPanel` (docked + overlay/scrim preserved) | `ask-question/*-{before,after}.png` (5 pairs, flat) | byte-identical (overlay/scrim portal preserved) |
| shared-conversation-components (MessageRow) | `message-*/msg-*`, `agent-pill*`, `backend-toggle*`, `voice-*`, `typing-*`, `attachment-*`, `focus-confirm*`, `.collab-pinned-top-target` | `shared-conversation-components/{before,after}/*__{desktop,mobile}.png` (32 shots) + `parity-review.md` | **all five MessageRow consumers byte-identical** (HIGH-TRAFFIC — gated) |
| conversation-surfaces | `convo-list-*`/`convo-card*`, `spec-browser*`, `docs-panel*`, `workflow-card*`/`gw-launcher*`, `commit-*`, `*-mention-chip*`, `right-pane*`, `synthetic-fork-badge` | `conversation-surfaces/{before,after}/*__{desktop,mobile}.png` (26 shots) + `parity-review.md` | **26/26 byte-identical** |
| prompt | `session/prompt/**` + `MobilePromptToolbar` | `prompt/*-{desktop,mobile}-{before,after}.png` (70 pairs, flat) | byte-identical pairs (desktop + mobile) |
| conversation-panes | `session/panes/**` split-screen frame | `conversation-panes/{before,after}-*-{desktop,mobile}.png` (14 pairs, flat) | byte-identical pairs (desktop + mobile) |

Note the two layouts: collab / shared-conversation-components / conversation-surfaces
use `before/` + `after/` subdirs with `<story>__{desktop,mobile}.png`; ask-question,
prompt and conversation-panes use flat files with `-before`/`-after` (or `before-`/
`after-`) in the filename. All pairs were captured at the two fixed viewports —
**desktop 1440×900, mobile 390×844, device-scale-factor 1** — with animations/
transitions/caret frozen, via a private Storybook in the slice's own worktree (CC's
`ensure_dev_server` resolves to the prefix-sibling worktree, so a private port was
used per the established method). See each slice's `parity-*.md` for the per-pair
sha256 table.

## The one intentional visual delta — D3 sr-only restoration (NOT a regression)

The charter directs B-4 to pick up the B-3-deferred **D3** debt: the
`CollabOpenConflictsCard` answer `<label>` ("Answer for Q-N") that the legacy tree
rendered **visibly** (a placeholder BEM class with no backing CSS rule). The collab
slice restored it as a proper `className="sr-only"` label (screen-reader-only). The
4 differing collab pairs (the *awaiting* open-conflicts card, standalone + inside
the paused passage, at both viewports) are exactly this fix — an accessibility
restoration, not a styling regression. Verified at `CollabOpenConflictsCard.tsx:223`.

## MessageRow consumer surfaces (emphasized — the highest-traffic surface)

MessageRow is rendered by 5+ features; the shared-conversation-components slice
captured direct before/after artifacts for **every** consumer named in the
acceptance criteria, all byte-identical:

All five MessageRow-consumer surfaces have direct before/after artifacts under
`shared-conversation-components/{before,after}/` (verified present at integration):

| Consumer | Evidence file (in `shared-conversation-components/{before,after}/`) |
|---|---|
| Session transcript | `b4-parity-harness--message-row-renderer-claude__{desktop,mobile}.png`, `…-codex__…` |
| Cockpit transcript | `project-cockpit-projecttranscripthost--messages-only__…`, `…--with-spawn-card-slot__…` |
| Workflow viewer | `b4-parity-harness--workflow-viewer__{desktop,mobile}.png` |
| Peek popover | `session-peekpopover--{awaiting,running}__{desktop,mobile}.png` |
| Panes body | `session-panesgrid--two-panes__{desktop,mobile}.png` |

Mobile prompt toolbar evidence lives with the prompt slice:
`prompt/mobile-mobileprompttoolbar--*-{desktop,mobile}-{before,after}.png`.

## Per-owner retained CSS (intentional residuals — NOT incomplete work)

The migration is constrained by the rank-2 **no-mixed-ownership** rule (a slice may
only migrate rules whose rendering component it owns) and the **preserved generated/
vendor DOM** rule (R6). The residuals below are therefore retained on purpose; they
will be cleared by later contexts as their owning components are migrated.

**`conversation.css` — 137 tracked selectors retained** (`css:progress` floor 39):

- **Preserved floor (~39, R6 — never migrated):** Tiptap `.prompt-editor__content
  .ProseMirror*`, Mermaid `.mermaid-diagram*`/`.mermaid-overlay*` +
  `@keyframes mermaid-overlay-fadein`, rendered markdown/code
  `.markdown-viewer`/`.code-block-*`, the AskQuestion portal
  `.ask-question-overlay`/`.ask-question-scrim` + `@keyframes ask-question-scrim-in`
  + the `:has(.ask-question-overlay)` stage rule, the atmospheric keyframes
  `rainbow-shift`/`rainbow-border-shift`/`collab-card-pulse`/`typingBounce`, the one
  `::-webkit-scrollbar`, and the `prefers-reduced-motion` blocks. **All verified
  present at integration.**
- **Deferred to a future ConversationPanel / Stage B-5 slice** (rendered by the
  non-owned `ConversationPanel.tsx`): `.prompt-panel`, `.panel-header`/`.panel-title`,
  `.conv-stop-btn*`, `.prompt-error*`, `.prompt-cancelled*`, `.prompt-textarea*`
  (also story-consumed), `.prompt-editor__arg-hint`, `.attachment-btn*` (shared with
  B-3 PromptDesktopToolbar/CreateSessionModal).
- **Deferred — needs a sidebar owner + the now-added `--cc-white-a02`:** `.ctx-menu*`
  (rendered by `ConversationSidebarRowContextMenu`).
- **Retained — non-owned consumers** (`SessionInfoStrip`, sidebar): `.session-status*`,
  `.convo-list-meta .si-*`, `.convo-rename-input`, plus the `right-pane`/`spec-browser`/
  `docs-panel` `.markdown-viewer` descendant hooks for generated content.
- **Removed this integration:** the dead, zero-consumer `.session-badge*` block
  (grep-verified — only a `.kiro` spec design-doc mention remained).

**`prompt.css` — 26 tracked selectors retained** (floor 2):

- Preserved `.mobile-prompt-model-chip.cc-rainbow-border*` (the rainbow-border
  effect — **verified present**).
- Deferred-to-ConversationPanel `.prompt-error*`/`.prompt-cancelled*` and the mobile
  `@media (max-width: 768px)` override hooks for migrated toolbar elements.

**`conversation-panes.css` — 3 tracked selectors retained** (floor 0): the two
rule-less residual anchors (`.panes-toolbar__add-wrap` legacy AddConversationMenu
popup; `.pane__body` density hook) + the separator residual.

**Out of scope — deferred to later stages (unchanged by B-4):**

- `globals.css` migratable chrome (agent-capability, dev-server, autocompletes,
  toasts, sessions-table) → **Stage B-5**. `globals.css` is **byte-unchanged** by B-4.
- The fused graph/builder (`session.css` graph/workflow families + workflows-builder
  + `workflow-graph.css`) → **Stage B-6**. `session.css` and `workflow-graph.css` are
  **byte-unchanged** by B-4; no `.graph-workflow*`/`.workflow-builder*` rule touched.
- Shared leaf recipes (`cc-tab*`/`cc-badge*`/`btn-*`/`empty-*`/`form-*` in
  `globals.css`) → **Stage B-final cleanup**. None deleted (globals.css unchanged).
- Token aliases / keyframe dedup / Preflight adoption / dead `prompt-textarea`
  (story-consumed) / dead `msg-editor*` story refactor → **Stage B-final**.

## Source-of-truth note (recorded per charter §"Applying the source-of-truth hierarchy")

The acceptance estimate "`conversation.css` ~39 / `prompt.css` ~2" conflicts with
the true residual (137 / 26). The prevailing source is the rank-2 design
no-mixed-ownership rule + the rank-4 per-slice protocol, which require deferring
families coupled to non-owned consumers (ConversationPanel chrome → B-5, ctx-menu →
sidebar, session-status/si-* → SessionInfoStrip). The CSS baseline therefore records
the legitimate residual (137/26/3); the floors stay at the true preserved minimum
(39/2/0) so B-5/B-6 ratchet the counts further down. No slice was failed for this
mismatch.

## Integration verification (this context)

- **Guardrail registration:** B-4 surfaces added to `MIGRATED_UTILITY_FIRST`
  (eslint) + the `.prettierrc` class-sort overrides (the
  `tailwind-utility-collisions` allowlist was already slice-synced). `bun run lint`
  → exit 0 (0 errors); prettier `--check` on all registered paths → clean.
- **Token extraction:** the deferred raw rgba className literals extracted to
  value-identical `--cc-bg-base-a60` / `--cc-black-a35` / `--cc-white-a02` and
  repointed; every `var(--cc-*)` reference in the B-4 surfaces resolves.
- **Legacy idiom conversion:** `cc-tab${cond ? " active" : ""}` (RightPane/SpecBrowser/
  ConversationList) → `cn("cc-tab", cond && "active")` (byte-identical output) so
  `no-dynamic-class` passes and prettier cannot trim the significant join space.
- **Baseline:** `conversation.css` 725→137, `prompt.css` 81→26,
  `conversation-panes.css` 39→3; `css:progress --check` green.
- **Builds/gates:** `bun run build` ✓, `bun run build-storybook` ✓,
  `bun run typecheck` ✓ (exit 0), targeted tests ✓ (47 files, 368 passed / 1 skipped).
- **Preserved floor / ownership:** the full `conversation.css` preserved floor and
  `prompt.css` rainbow-border verified present; `globals.css` / `session.css` /
  `workflow-graph.css` byte-unchanged; no shared leaf recipe deleted; no
  `.graph-workflow*`/`.workflow-builder*` rule touched.

**Recommendation:** GO — zero unintended visual change; the single delta is the
approved D3 a11y restoration. Awaiting human sign-off at this gate.
