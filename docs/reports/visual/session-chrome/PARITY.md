# Stage B-3 — session.css non-graph chrome: parity evidence

Before/after screenshots at the fixed viewports (desktop 1440×900, mobile 390×844;
device-scale-factor 1, animations frozen) for the migrated session.css non-graph
families. Captured from a **private Storybook on this worktree's own port** (the
shared `ensure_dev_server` Storybook resolves to the prefix-sibling worktree, so a
private instance is required). "before" = the wave merge-base (`git stash` of the
tracked changes → HMR reload → capture → `git stash pop`); "after" = the migrated
working tree. Verified with per-pixel diff (PIL `ImageChops.difference`).

## Result: all 11 production-component pairs are PIXEL-IDENTICAL

| Story | Viewports | Result |
|---|---|---|
| DiffPanel — MultipleFiles | desktop + mobile | identical |
| DiffPanel — SingleFile | desktop | identical |
| SessionGitPanel — WithChangesAndCommits | desktop + mobile | identical |
| SessionGitPanel — ChangesOnly | desktop | identical |
| DebugModeToggle — Inactive / Active | desktop | identical |
| DebugStatusStrip — Recording / Paused | desktop | identical |
| CommitHistory — MultipleCommits | desktop | identical |

## Bugs the screenshots caught (the deterministic gates could not)

1. **Two diff toolbar buttons left unstyled.** The collapse-all/expand-all buttons
   had `className="diff-nav-btn"` on its own line; the single-line `replace_all`
   only matched the 4 chevron buttons, so those two kept the (now-deleted)
   `.diff-nav-btn` class and rendered as slivers. Fixed.
2. **Default `<button>` UA border (Preflight is OFF).** Three migrated buttons whose
   legacy rule was `border: none` (DebugStatusStrip rec, SessionActionsMenu items,
   InfoDetailsPopover copy) rendered the browser's default button border because the
   reset was dropped. Fixed by adding `border-none`. Audited every migrated
   `<button>`: each now carries either an explicit `border …` or `border-none`.

## Surfaces without an isolated story (parity by faithful transcription + tests)

- **SessionActionsMenu**, **InfoDetailsPopover** (popover open state), the real
  **SessionInfoStrip**, and **session-status** have no isolated/openable Storybook
  story. Their migration is a 1:1 rule→utility transcription, covered by the
  border-none audit above, the unit tests (SessionActionsMenu/InfoDetailsPopover/
  SessionContent), and the shared `session-status-classes.ts` module.

## Families DEFERRED (reverted to legacy this wave — co-consumed out of scope)

The `.session-info-strip` / `.si-*` / `.session-status` families were initially
migrated but are now **reverted to their committed (legacy) form**, and their
session.css rules are **restored**, because they are co-consumed by surfaces outside
this wave's ownership — so they are not cleanly migratable here:

- **`.session-status`** is fully co-defined in `conversation.css` (base + dot + the
  live conversation-level variants new=blue / awaiting=green / waiting_for_input=amber
  pulse / running=cyan pulse-dot). `ConversationList`'s `ConversationStatusDot` renders
  `convo.status` styled by that conversation.css recipe → Stage B-4.
- **`.si-item`/`.si-label`/`.si-val`** are reused by `CopyableId` (src/components,
  out of scope) → Stage B-5. Restoring the rules keeps CopyableId + the
  InfoStrip/CopyableId/AskQuestionPanel demo stories rendering correctly.

Because these are reverted to legacy, they are trivially at parity (no diff vs HEAD);
no screenshots required. They migrate when conversation.css (B-4) / CopyableId (B-5)
do.

## Other deferred / residual (per the hand-off doc)

`.debug-toggle__dot` base is **kept** in session.css — MobilePromptToolbar
(src/features/session/mobile, out of scope) renders it. `DebugModeToggle` itself IS
migrated (button via utilities; its dot is a utility span, not `.debug-toggle__dot`),
so the restored rule serves only MobilePromptToolbar.
