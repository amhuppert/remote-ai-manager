# Stage B-5a — globals.css chrome migration: consolidated parity review

**Human sign-off gate.** Stage B-5a migrated the migratable chrome in
`src/app/globals.css` (toasts, autocompletes, modal feature-bits, dev-server UI,
small chrome) to utility-first Tailwind across five slices. Goal: **ZERO visual
change**. Every slice verified its surfaces with before/after screenshots at
desktop (1440×900) and mobile (390×844); the great majority are **byte-identical
(sha256)**. This artifact links each slice's evidence and records the CSS each
owner intentionally retained.

## Integration outcome

| Gate | Result |
|---|---|
| `bun run build` | ✅ exit 0 |
| `bun run build-storybook` | ✅ exit 0 |
| `bun run lint` | ✅ 0 errors (93 pre-existing warnings in unrelated test files) |
| `bun run typecheck` | ✅ exit 0 |
| `bun run css:progress --check` | ✅ green |
| Targeted tests (autocompletes, BulkConfirmModal, prompt popups, collision) | ✅ 91 passed |
| Ratchet baseline | globals.css **851 → 568**, session.css **246 → 239** |

Token extraction: 11 new `--cc-*` alpha tokens minted in
`src/features/_root/styles/tokens.css` (Stage B-5a block); the remaining inline
parity literals were swapped to existing value-identical tokens. All migrated
class strings are now token-backed (`no-hardcoded-color` passes).

## Per-slice parity evidence + retained-CSS notes

### 1. Merge toast layer — `docs/reports/visual/merge-toast/`
- **Surfaces:** `MergeToast.tsx`, `InputNeededToast.tsx`, `PromptErrorToast.tsx`.
- **Evidence:** `{before,after}-<story>-<desktop|mobile>.png` (28 PNGs / 14 pairs). All **byte-identical**.
- **Retained:** `@keyframes toastSlideIn/toastSlideOut` (preserved floor — a keyframe can't be a utility).
- **Deferred (NOT this stage):** Family B — Mobile Action Menu + bottom bar (`.mobile-action-*`, `.mobile-bottom-*`); has a live out-of-scope consumer (`MobilePromptToolbar.tsx`) and is descendant-coupled to the `.cc-tab` leaf recipe → a future widened migration (collaboration 236bae14). `MobileActionMenu.tsx` not migrated/registered.

### 2. Unified panel + modal feature-bits — `docs/reports/visual/unified-panel-modals/`
- **Surfaces:** `BulkConfirmModal.tsx` (fully utility-first); `CreateSessionModal.tsx` (PARTIAL — only `.session-mode-toggle`/`.mode-btn`); dead `.unified-panel*` region pure-deleted (consumer is the already-migrated `.np-*` NotificationsPanel).
- **Removed (DEAD, not preserved floor):** the 3 component-specific keyframes `@keyframes unified-backdrop-in`/`unified-slide-in`/`unified-pulse`. They were defined **inside** the `.unified-panel*` block and referenced **only** by its dead rules (`.unified-panel-backdrop`, `.unified-panel`, `.unified-panel-dot.running/.waiting_for_input`) — zero JSX consumers. Per **R6** (preserve generated/vendor DOM), keyframes that animate removed JSX chrome are dead CSS, not the preserved animation library. See the source-of-truth note below.
- **Evidence:** `{before,after}-<story>-<desktop|mobile>.png` (16 PNGs / 8 pairs). 7/8 byte-identical; `createsession-sessions-mobile` differs by 4 sub-pixels at 1/255 (AA noise, visually inert).
- **Retained (cleanup-gate, B-final):** shared modal shell `.modal-overlay`/`.modal`/`.modal-title`/`.modal-actions`, `.form-*`, `.btn*` leaf recipes (still used by legacy modals incl. CreateSessionModal's shell).
- **Note:** `CreateSessionModal.tsx` intentionally NOT registered in eslint/prettier (still part-legacy) — its shell migrates in B-6+.

### 3. Autocomplete surfaces — `docs/reports/visual/autocompletes/`
- **Surfaces:** `CommandAutocompleteList.tsx` (owns shared popup recipes), `FileAutocomplete.tsx`, `FileAutocompleteList.tsx`, `ConversationAutocompleteList.tsx`; consumers `PromptEditorFileMentionPopup`/`PromptEditorConversationMentionPopup` (under the `session/prompt/` glob).
- **Evidence:** `<family>-<desktop|mobile>-<before|after>.png` (16 PNGs / 8 pairs). All **byte-identical**.
- **Retained:** `@keyframes cmdReveal` (preserved floor). Row state moved off `.active`/`--archived` classes onto `data-active`/`data-archived`/`data-status` attributes.

### 4. Dev-server UI — `docs/reports/visual/dev-server/{before,after}/`
- **Surfaces:** `DevServerDrawer.tsx` (+ `DevServerPanel`/`ServerRow`/`UnmanagedConflictDialog`), `DevServersButton.tsx` (session info-strip trigger).
- **Evidence:** `before/` + `after/` (11 pairs). All **byte-identical** (animations frozen before capture — `pulse-dot` is nondeterministic).
- **Deleted:** globals.css `.ds-*`/dead `.dev-server-*` panel region + dead `.ds-source-tag`; **session.css `.dev-servers*` region** (charter exception — same `DevServersButton` author).
- **Retained:** `@keyframes ds-panel-in`/`ds-sheet-in` (preserved floor). The active strip-trigger uses a deliberately distinct softer green (`--cc-devgreen-*`), not `--green`.
- **Acknowledged residual (B-6):** orphaned `.topbar-status-session .ds-wrapper{display:none}` selector in the topbar region references the deleted `.ds-wrapper`; no element carries that class, so it is NOT live mixed-ownership — the mobile-hide intent is baked into the migrated root.

### 5. Small chrome — `docs/reports/visual/globals-small-chrome/` (see its `README.md`)
- **Surfaces:** `ConversationLinkChip.tsx`, `CollapsibleText.tsx`, `ProjectsIndexPage.tsx` (projects header).
- **Evidence:** `<story>__<desktop|mobile>__<before|after>.png` (24 PNGs / 12 pairs). All **byte-identical**.

## Out-of-scope CSS intentionally retained across the whole stage

- **Agent-capability block** (`.agent-capability-*`/`.cap-*`/`.agent-capabilities-tab*`/`.agent-capabilities-drawer*`, ~257 selectors) — **Stage B-5b** (a separate workflow). Untouched.
- **Shared leaf recipes** (`cc-tab*`/`cc-badge*`/`btn-*`/`empty-state*`/`form-*`/`.status-*`/`.cc-page-title`/`.cc-toast`, ~82 selectors) — **cleanup gate (B-final)**. Not deleted.
- **session.css non-dev-server families** (SessionInfoStrip/`.session-status`/`.si-*`, `.debug-*`, `.git-panel-*`, `.copyable-id`, ~70 selectors) + conversation.css ConversationPanel chrome + `.ctx-menu*` — **Stage B-6**. Unchanged (conversation.css shows no diff).
- **Graph/builder families** (`.graph-workflow*`/`.workflow-builder*`) + `workflow-graph.css` — **Stage B-6 (LAST)**. Unchanged.
- **Preserved floor** — scrollbars (6), the genuinely-preserved `@keyframes` library (**18 definitions**; relocated where a slice deleted its surrounding region but every preserved keyframe survives — toastSlideIn/Out, np-backdrop-in/slide-in, ds-panel-in/sheet-in, cmdReveal, etc.), `.markdown-*` rendered output (40), tooltip/modal-overlay/toast portal positioning. Stays forever (R6).
- **Token aliases / keyframe dedup / Preflight adoption** — **cleanup gate (B-final)**.

## Source-of-truth resolution — the 3 `unified-*` keyframes

The css-inventory keyframe census (`docs/reports/css-inventory.md`, source rank 5)
recorded globals.css as holding **21** keyframes "preserved (the global `@keyframes`
library)". B-5a's net result is **18** definitions: the 3 `unified-backdrop-in`/
`unified-slide-in`/`unified-pulse` keyframes were removed.

**Resolution (conflict recorded per the charter's higher-rank rule):**
- **Criterion in tension:** css-inventory's "21-keyframe library is preserved floor".
- **Prevailing source:** **R6** (spec requirements, rank 1) — "preserve generated/
  vendor DOM". The 3 keyframes were defined inside, and referenced **only** by, the
  dead `.unified-panel*` family (zero JSX consumers; superseded by the migrated
  `.np-*` NotificationsPanel — proved by grep). Keyframes animating removed JSX
  chrome are **dead CSS**, the exact dead-rule category B-5a is chartered to delete —
  not the preserved animation library R6 protects.
- **Resolution:** the deletion stands; the keyframes are **NOT** restored. The
  inventory's "21" was an over-broad census snapshot (task 1.1 counted every keyframe
  present without separating dead component keyframes from the preserved library);
  its census/residual entries are corrected to 18 with this rationale. Verified the
  `git diff` of B-5a's whole range removes-and-relocates every other keyframe
  (net-preserved) and net-deletes **only** these three.
- The ratchet baseline (globals.css 568) is correct as-is; no regeneration is
  required for this resolution.

---

_This context pauses for human review before the workflow completes._
