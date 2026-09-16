# Content & Voice

UI copy rules: voice, casing, person & address, empty states, and microcopy patterns. Use when writing any user-facing text — button labels, dialog titles, empty states, confirmations, toasts, status strings.

---

## Voice

- **Operator-tone, not marketing.** Copy is terse, technical, trusts the reader. No exclamation marks, no emoji, no rhetorical questions, no "Let's get started!" warmth.
- **Imperative for actions, declarative for state.**
  - Buttons: `Merge`, `Commit`, `Archive`, `Delete session`.
  - Status: `Running`, `Awaiting input`, `Idle`, `Merged`.
- **Domain words used precisely.** *Session, conversation, worktree, branch, prompt, diff, target branch, fork, finalize* — technical terms with exact meanings. Don't paraphrase.
- **State consequences accurately.** Use "will" for guaranteed effects and explain the condition for effects that depend on state; terse copy must not hide uncertainty.

---

## Casing

| Casing | Where |
|---|---|
| **Sentence case** | Buttons, menu items, dialog titles: `Create session`, `Merge to main`, `Confirm focus`. |
| **UPPERCASE MONO with letter-spacing** | Section labels, metadata labels: `BRANCH`, `PROMPTS`, `WORKTREE`, `LAST ACTIVE`. |
| **lowercase mono** | Breadcrumbs and paths: `projects / remote-ai-manager / fix-auth-flow`. |
| **`CC`** | Brand mark — uppercase, two letters, never spelled out in chrome. |

---

## Person & address

| Form | Where | Example |
|---|---|---|
| **Second-person** | Confirmations | *"This action cannot be undone. **Your** working changes will be lost."* |
| **Imperative, no subject** | Instructions | *"Press ⏎ to send. Shift+⏎ for newline."* |
| **First-person plural** | System narration in toasts (use sparingly) | *"We've finalized the focus document."* |

---

## Empty states

Two short lines max — a display-font title and a mono description capped at ~320px width. No illustrations, no CTAs stacked inside.

```
No sessions yet
Create one with the button above to start a coding session.
```

---

## Microcopy patterns

| Pattern | Rule |
|---|---|
| **IDs** | Copy affordance (inline SVG copy icon) + middle truncation (`a1b2c3…ef0123`). |
| **Counts** | Raw numerals. Never "1 session" / "0 sessions" — labels are UPPERCASE below the number. |
| **Null temporal** | `—` em-dash in `--text-tertiary`. Never "N/A" or "never". |
| **Null counts** | `0`. Never `—`. |
| **Time** | Short locale format: `Apr 15, 4:15 PM`. Relative time only inside dropdowns/tooltips. |
| **Confirmations** | Title is the action, body is the consequence. *Title:* `Delete session?` *Body:* `This permanently removes the worktree and conversation history.` |

---

## Vibe

> Air traffic control transcript — high signal, low ceremony, every line earns its place. Filler ("Welcome!", "Great choice!", emoji bullets) is treated as visual noise and removed.

---

## Reviewing existing copy

When auditing copy:

1. **Does it pass the operator-tone rule?** No exclamation marks, no emoji, no warmth.
2. **Are the verbs right?** Imperative for actions, declarative for state.
3. **Are the casings right?** Sentence case for buttons, UPPERCASE MONO for section labels, lowercase mono for paths.
4. **Are null values rendered right?** `—` for null temporal, `0` for null counts.
5. **Are time strings formatted right?** `Apr 15, 4:15 PM` short-locale; relative only in tooltips.
6. **Are confirmations titled by the action?** *Delete session?* — not *Confirm action* or *Are you sure?*
