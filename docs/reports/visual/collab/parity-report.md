# Stage B-4 — collab slice parity report

Migration of the collab-* families (17 Collab* components) in `conversation.css`
to Tailwind utilities + static class maps, plus the D3 sr-only fix.

## Method

Byte-identical before/after comparison via a private Storybook serving **this**
worktree (`.slice-collab`, port 6026 — the shared 6009 server resolves to the
prefix worktree). 25 stories covering every migrated component and its riskiest
variants, **plus the out-of-scope `ConversationVirtuosoList` mock fixture** that
still consumes `.collab-passage`, captured at the two fixed viewports
(**desktop 1440×900**, **mobile 390×844**, device-scale-factor 1). Three
final-answer stories are **additionally** captured inside an injected
`.conversation-virtuoso-item` ancestor (`__virtuoso`) to exercise the production
context. **56 screenshots.**

"before" = the legacy collab components + `conversation.css` rules
(`git stash` of this slice's changes → Vite HMR rebuild → capture → `stash pop`).
Animations/transitions are frozen during capture
(`*{animation:none!important;transition:none!important}` via `addStyleTag`) so the
running `pulse-dot` animation on active phase pips cannot cause non-deterministic
frame-timing byte diffs.

## Result

**52 / 56 byte-identical.** The 4 differing pairs are all the **open-conflicts
*awaiting* card** (standalone + inside the paused passage), at both viewports —
and the only difference is the **D3 fix**: the answer `<label>` ("Answer for
Q-N"), which legacy rendered *visibly* (a placeholder BEM class with no CSS rule),
is now correctly visually-hidden via the real `sr-only` utility (screen-reader
available). The card is correspondingly ~2 lines shorter. This is the one
intended change for this slice; no other visual change exists.

### Production-context final-answer spacing — verified

`CollabFinalAnswerMessage` dropped the legacy `.message` class (no mixed
ownership). In production (inside `.conversation-virtuoso-item`) the article took
a 24px bottom from the shared `.conversation-virtuoso-item .message` rule; that is
reattached 1:1 with the §8.2 ancestor-context variant
`[.conversation-virtuoso-item_&]:pb-[24px]` (the shared rule itself is untouched —
MessageRow owns `.message`). Verified byte-identical in **both** contexts:

- `…finalanswermessage…__{desktop,mobile}` (standalone) → identical, 12px bottom.
- `…finalanswermessage…__{desktop,mobile}__virtuoso` → identical, 24px bottom.
- `…passage--converged-final-answer__{desktop,mobile}__virtuoso` → identical.

### `.collab-passage` consumer — preserved

`.collab-passage` is still consumed by the out-of-scope
`ConversationVirtuosoList` Storybook mock fixture (`src/components/**`), so the
rule is **retained** in `conversation.css` (commented for hand-off). The mock
story (`projects-conversationvirtuosolist--with-collab-row__{desktop,mobile}`) is
byte-identical before/after.

- `before/` — legacy, animations frozen
- `after/`  — migrated, animations frozen

## Animation behavior (verified separately)

With animations live, re-capturing the migrated state twice (after vs after2)
showed the active phase-strip pip dots as non-deterministic (they pulse) — i.e.
the migrated `animate-pulse-dot` is live, matching legacy. This caught one bug,
now fixed: the **amber `open_conflicts`+active** dot must keep `animate-pulse-dot`
(legacy's amber rule overrides only bg/border/shadow, not the `animation`
inherited from the base `[data-status=active]` dot rule).

## Verdict

GO — zero unintended visual change (incl. the production virtuoso context); the
sole change is the required D3 a11y fix.
