## cctl ask

Ask the user one or more multiple-choice questions. Unlike a built-in
question tool, the question is
**registered, not awaited**. You end your turn after asking; the answer arrives
as your **next user message**, delivered through the normal prompt queue.

```
cctl ask --file .cc/temp/questions.json
cctl ask-check --file .cc/temp/questions.json
```

- `--file` — a JSON object `{ "questions": [ … ] }`, each question
  `{ "id"?, "question", "header"?, "context"?, "options": [ … ],
  "multiSelect"?, "required"?, "allowNote"? }`. Each option is
  `{ "label", "description"?, "recommended"?, "tradeoff"?: { "pro"?, "con"? } }`:
  `recommended` renders a "Suggested" badge (with a one-click "Accept all
  suggested" action), `tradeoff` renders as `+ pro` / `− con` lines under the
  option, and the question-level `context` supports markdown-lite (`**bold**`,
  `` `code` ``, `- ` bullets). Author the file under `.cc/temp/` with the available file-writing tool.
The file is required for a single question as well as a batch. Use
`ask-check` to validate it before registering the handoff. For example:

```json
{ "questions": [{ "id": "migration-order", "question": "Which migration order?",
  "options": [{ "label": "Phases in order", "recommended": true },
              { "label": "Fast path" }] }] }
```

On success, `payload.data.questionBatchId` identifies the registered batch.
The top-level `instruction` is the required end-turn action:

```sh
cctl ask --file .cc/temp/questions.json --json
```

### End-turn discipline

- Ask **only at real forks** — consequential, hard-to-reverse, or genuinely
  ambiguous decisions. Make sensible calls on trivial or reversible choices.
- **Batch related, independent questions into one call** — only one batch can pend per
  conversation, and a batch already holds multiple questions.
- After `cctl ask` succeeds: write a **brief handoff note** — what you asked
  and what you will do with each possible answer — then **end the turn**. Do
  not start new work; anything you produce after asking may be invalidated by
  the answer.
- Exit `1` with `question batch q_… already pending`: you already asked — end
  your turn now; the pending batch reaches the user without a second call.
- Exit `1` with `autonomous conversation — proceed with best judgment`: this
  conversation has no interactive user; decide yourself and record the
  rationale.
- Exit `1` with `no turn is running`: `ask` only works from inside a live
  conversation turn.

### Asking from a run seat

A seat of a supervised run asks its **owner**, the conversation that launched
the run, not the user. Its first order says whether it may ask; the run's
`ownerQuestions` setting is on unless the launch turned it off, and when it is
off the ask is refused as an autonomous conversation.

- `cctl ask` takes the same file. The context waits for the answer; other
  contexts of the run go on. End your turn after asking. The answer arrives as
  your next order, headed "Your question was answered", with the question and
  the answer; continue the interrupted work.
- The owner reads each question with its options' labels, descriptions and
  recommended marks, not its header or context.
- One batch at a time: a second ask while one is open is refused; end your turn.

The owner answers in text with
`cctl run answer <run-id> --question <question-id> --text "<answer>"`, using
the ids the wake and `cctl run show` print. Only the owner answers. The user
sees the open question on the run page but does not answer it there: when the
decision is theirs, the owner asks them with its own `cctl ask` and relays the
answer.

### Reading the answer

The answer arrives in your next user message as a self-contained block:

```
<cc-question-answers batch="q_ab12">
{ "approach": { "selected": ["Phases in order"], "note": "but land 2.3 early",
                "skipped": false, "question": "Which migration order?" } }
</cc-question-answers>
```

Entries are keyed by question id: `selected` holds the chosen label(s), `note`
is the user's free-text addition (may qualify or override the selection —
read it), and `skipped: true` means the user declined that question —
**proceed with your best judgment**. Ordinary user text can also answer or redirect the question. Apply explicit
direction while preserving unresolved pending decisions; an unrelated message
or elapsed time is not an answer or approval.
