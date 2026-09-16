## cctl charter

Submit the session's **Alignment charter** — the free-text markdown document
that governs the whole session. Author one when the user invokes `/align` or
explicitly requests charter work; the existence of the write command is not
authorization to establish shared context on the user's behalf.

```
cctl charter write --file .cc/temp/charter.json
```

- The charter is structured, multi-paragraph markdown, so it is **file-only**:
  author `.cc/temp/charter.json` as a JSON object `{ "content": "<full markdown>" }`,
  then submit. There is no inline text flag.
- The submission fills the session's open Alignment draft (the one `/align`
  creates); if none is open it defensively opens a gated one. A normal `/align`
  draft remains pending in the **Approve Charter** panel and leaves the active
  charter unchanged. A draft opened after the user approves decisions activates
  immediately on submission; the decision review is already its human gate.
- The command reports the actual result: either `charter draft submitted;
  pending the user's approval` or `charter activated as version <n>`. Never ask
  for a second approval after decision incorporation. Either way `charter write`
  emits no next-command hint and exits `0` on submission. Report whether the
  charter is pending or active; this receipt does not grant approval for later work.
- Attended-only: on an autonomous/optimistic turn, or with no live conversation
  turn to author against, the server refuses and the command exits `1`.

```
cctl charter write --file .cc/temp/charter.json
# → charter draft submitted; pending the user's approval
```

## cctl decisions

Propose one or more **decisions** for the user to review. Review is
asynchronous; approved decisions fold into the Alignment charter.

```
cctl decisions propose --file .cc/temp/decisions.json
```

- **File-only**: author `.cc/temp/decisions.json` as a JSON object with a
  non-empty `decisions` array — each `{ "statement": "...", "rationale"?: "...",
  "context"?: "..." }`.
- The batch is persisted for human review. Write a brief handoff note, then end
  your turn immediately; do not begin more work. One complete result covering
  every approved or rejected decision and any rejection feedback arrives as the
  next user message, never in the proposing turn.
- The UI presents Approve/Reject as one explicit selection per decision, plus
  optional rejection feedback. `cctl` returns a load-bearing `instruction`
  field in JSON and the same instruction in text output. Attended-only, with the
  same refusals (exit `1`) as `charter`.

```
cctl decisions propose --file .cc/temp/decisions.json
# → proposed 2 decisions for the user's review
#   Decision review is pending. Write a brief handoff note, then end your turn now;
#   do not start new work. The complete decision review result will arrive as the
#   next user message.
```
