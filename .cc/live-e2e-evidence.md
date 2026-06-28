# Task 9.2 — Live end-to-end verification (markdown-doc-feedback)

Run date: 2026-06-27. Driven with Playwright against a worktree-local private dev
server (`PORT=3097 bun run dev`, `CC_CONFIG_DIR=$PWD/.config`) so all state is
the worktree-local `command-center.db` / transcripts — NOT production.

- Project: `plc-test-lab`  ·  Session: `docreview-probe` (worktree
  `.worktrees/docreview-probe-8e2ed3`)
- Target conversation: `d1f37b5a-f9d2-4c61-8f39-aff8bdfb13eb`
- Document under review: `review-doc.md` (written by a real Claude agent turn —
  one `Write` tool_use, which is what drives the transcript file card)

Every PASS is cited to durable backend state (SQLite rows, transcript JSONL,
recogito computed styles), not the optimistic UI.

## 1. Open a document from a transcript file card  (req 4.3) — PASS
Clicking the `MarkdownFileCard` (`<button title="review-doc.md">…wrote…Open →`)
in the conversation opened `review-doc.md` in the document viewer: 7 blocks
stamped with `data-cc-line`, headings Wildlife Observation Log / Morning /
Afternoon / Evening. The content endpoint served the worktree file.

## 2. Select → comment → queue  (req 5.1, 5.3, 5.4) — PASS
Real in-document text selection (Range + `pointerup`) surfaced the `+Comment`
affordance on a single-block selection; the popover's Add/Add&send were disabled
while the note was empty and enabled once typed. Two queued comments persisted as
**pending** with exact quote + heading/line anchor:
- `07092af3` morning L4 quote="A great blue heron" note=FEEDBACK-ALPHA
- `1fb106ab` afternoon L7 quote="A family of white-tailed deer" note=FEEDBACK-BRAVO

## 3. Conversation target picker  (req 9.1, 9.2) — PASS
The "Send to" picker opened a searchable list of conversations across sessions
(docreview-probe + mdfeedback-live) and resolved a default target. Chosen target:
`docreview-probe 1` (= d1f37b5a).

## 4. Bulk-send + comments flip to sent  (req 7.4, 9.5) — PASS
"Send 2" delivered ONE feedback submission to the chosen conversation. Both
comments flipped to **sent** with `sent_at` set (DB). Viewer pins+highlights
flipped cyan→green live.

## 5. Feedback card appears in the chosen conversation  (req 8.2) — PASS
- Transcript `d1f37b5a….jsonl` contains a `document_feedback` block with BOTH
  items (docPath, path, headingLabel, line, quote, note) — see below.
- UI: `[data-testid=document-feedback-card]` rendered (808×303) in that
  conversation: "Document feedback · 2", each item showing path · §heading · Lline
  · quote · note.

```
document_feedback.items[0] = {review-doc.md, Morning, L4, "A great blue heron", FEEDBACK-ALPHA…}
document_feedback.items[1] = {review-doc.md, Afternoon, L7, "A family of white-tailed deer", FEEDBACK-BRAVO…}
```

## 6. Pending vs sent highlights distinguished  (req 6.x) — PASS
A third pending comment (`5ecc91ac` evening L10 "A pair of red foxes…")
was created while A+B were sent, so all three rendered simultaneously. Mapped per
comment id (recogito `.r6o-annotation` computed `background-color` + gutter pin
classes):

| comment | status | highlight fill | gutter pin |
|---|---|---|---|
| 5ecc91ac (C) | pending | `rgba(0,229,255,0.28)` cyan #00e5ff | cyan |
| 07092af3 (A) | sent | `rgba(0,230,118,0.2)` green #00e676 | green |
| 1fb106ab (B) | sent | `rgba(0,230,118,0.2)` green #00e676 | green |

Screenshot: `.cc/live-e2e-pending-vs-sent.png`.

## 7. Changed document → comment stale yet actionable  (req 11.3, 11.5) — PASS
Edited `review-doc.md` line 10 on disk so comment C's exact quote no longer
matches (kept single line so L4/L7 unaffected). Reloaded + reopened the doc:
- C **failed to re-anchor** → no gutter pin, no recogito highlight (only A+B, both
  green, remained — their paragraphs were untouched).
- C surfaced in the pending tray with an amber **"Stale"** chip + its note +
  Jump / Remove / bulk-Send (actionable).
- Proved **sendable**: "Send 1" delivered the stale comment → C flipped to **sent**
  (`sent_at` set) and a 2nd `document_feedback` block carrying FEEDBACK-CHARLIE
  landed in the transcript.

Screenshot: `.cc/live-e2e-stale-comment.png`.

## 8. Comment card edit + sent→pending revert  (req 6.5, 6.7) — PASS (bonus)
Opened a sent comment's card via its green gutter pin, edited the note, saved →
comment reverted **sent → pending** (DB: `07092af3` status=pending, sent_at
cleared). Confirms the card is editable live and the revert-on-edit rule fires.

## 9. Stale comment is EDITABLE live (req 11.5) — PASS  (reopened-gap closure, 2026-06-27 second run)

Prior runs proved a stale comment stays visible/removable/**sendable** from the
tray, but the tray exposed only Jump/Remove, so a stale comment's CommentCard
(its edit surface) was **unreachable** — a stale comment has no highlight/gutter
pin to click. Design §"Components" line 539 specifies the tray row as
`jump/edit/remove`; the per-row **edit** action had been dropped. Fix: added an
`onOpen` prop + per-row **Edit** button to `PendingCommentsTray` (Jump hidden for
stale rows, which have no passage), wired in `DocumentSurface` to open the
`CommentCard` straight into note-editing (`CommentCard` gained `initiallyEditing`).

Live proof, two independent stale comments, each confirmed against SQLite +
transcript (not the optimistic UI):

**(a) Edit an existing pending comment after its passage changed.**
- Edited `review-doc.md` line 4 on disk so comment `07092af3`'s stored quote
  `"A great blue heron"` no longer appears in the rendered doc (`.r6o-annotatable`
  body contains `"A solitary great egret"`, NOT the stored quote → re-anchor fails).
- The doc showed **0** recogito highlights for it and **no** gutter pin; it
  surfaced only in the tray with an amber **Stale** chip and **Edit / Remove**
  (no Jump). Clicking **Edit** opened the card in edit mode (textarea prefilled
  with the note; chips `Pending` + `Stale`; `§ Morning · L4`).
- Changed the note and saved. DB (`document_comments` row `07092af3`):
  `note = "STALE-EDIT-LIVE-VERIFY-7x9 reanchor failed but still editable"`,
  `status = pending`, `sent_at = NULL` (still stale + still sendable).
- Then **Send 1** → row flipped `status = sent`, `sent_at` set, and the target
  conversation transcript (`d1f37b5a….jsonl`, user turn) gained a **3rd**
  `document_feedback` block carrying the EDITED note:
  `{docPath: review-doc.md, headingLabel: Morning, line: 4, quote: "A great blue heron", note: "STALE-EDIT-LIVE-VERIFY-7x9 …"}`.

**(b) Edit a freshly-created pending comment after its passage changed.**
- Real text selection on the Afternoon paragraph → `+Comment` popover → **Add
  comment** created pending `18b18108` (quote `"One fawn bounded between the
  does"`, L7). Edited line 7 on disk to drop that phrase → reopened the doc → the
  comment went **stale** (tray row: Stale chip, Edit/Remove, note shown).
- Tray **Edit** opened the card in edit mode (`cardText: "Pending Stale §
  Afternoon · L7 One fawn bounded between the does <note> Cancel Save"`). Saved a
  new note → DB row `18b18108`: `note = "STALE-SCREENSHOT-DEMO EDITED please cite
  Sibley 2014"`, `status = pending`, `sent_at = NULL`. (Throwaway comment removed
  afterward via the live tray **Remove**; row count → 0.)

Screenshots: `.cc/live-e2e-stale-card-editing.png`, `.cc/live-e2e-stale-card-closeup.png`.
Component coverage: `PendingCommentsTray.test.tsx` ("opens a comment's card for
editing" + "offers an edit affordance for a stale comment"), `CommentCard.test.tsx`
("opens straight into note-editing when initiallyEditing is set").

Fixture restored: `review-doc.md` lines 4 and 7 reverted to their session-start text.

## Artifacts
- `.cc/live-e2e-sent-feedback-card.png`, `.cc/live-e2e-pending-vs-sent.png`,
  `.cc/live-e2e-stale-comment.png`, `.cc/live-e2e-stale-card-editing.png`,
  `.cc/live-e2e-stale-card-closeup.png`, `.cc/live-e2e-stale-editable.png`
- Transcript: `.config/transcripts/d1f37b5a-f9d2-4c61-8f39-aff8bdfb13eb.jsonl`
  (3 `document_feedback` blocks; the 3rd carries the edited stale-comment note)
- DB: `.config/command-center.db` → `document_comments` (session `docreview-probe`)
