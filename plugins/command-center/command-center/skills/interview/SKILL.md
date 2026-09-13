---
name: interview
description: >-
  Interview the user through Command Center questions to clarify an objective,
  scope, and success criteria. Use when the user asks to be interviewed or when
  consequential ambiguity needs several related decisions before work can
  proceed. Adapt each batch to prior answers so conditional questions wait
  until relevant.
---

# Interview

Reach a shared understanding of what the user wants, why it matters, and what
would count as success, while spending their attention only on decisions that
affect the outcome. Use Command Center's `cctl ask` for questions on either
backend. An interview request authorizes clarification; subsequent planning
or implementation follows the user's requested scope.

## Prepare the next batch

Start from the conversation and relevant available project evidence. Carry
forward established decisions; inspect facts the project can answer instead
of asking the user to look them up. Keep this investigation proportional to
what you need to choose useful questions.

Before asking, sketch a compact working map of candidate questions. For each,
identify the decision its answer changes, any prerequisite answer, and which
follow-ups the likely answers would enable or eliminate. Look ahead far
enough to find dependencies; a complete questionnaire for every possible
branch is unnecessary. Keep this planning in working context; show the user
the questions and their practical implications.

Prioritize unknowns that could change the objective or invalidate other
questions: intended outcome, audience or workflow, next deliverable, scope,
and hard constraints. Then probe relevant success criteria and edge cases.
These are lenses for finding gaps, not a checklist to ask in every interview.
A concrete example of success or failure often resolves several gaps at once.

**Batch only questions that are independent given what is already known.**
For each proposed pair, consider whether any plausible answer to either
would change the other's relevance, wording, choices, or recommendation.
If so, ask the prerequisite first and hold the dependent question for a later
turn. An unresolved prerequisite keeps its follow-ups out of the batch;
phrasing them as "if applicable" still makes the user do unnecessary work.

Usually send one to three focused questions. One question is enough when it
determines most of the remaining path; batch related independent questions
when that saves a round trip. Omit questions already answered, inferable from
evidence, or about routine reversible details. Every question should change
the brief or the next action.

For example, when "help with customer onboarding" leaves the deliverable open:

| Candidate question | When to ask |
| --- | --- |
| Is the next result a recommendation, an interactive prototype, or a working feature? | First: it determines which details matter. |
| Is there a fixed date the result must be ready? | Can share the first batch if it matters equally to all three results. |
| Which interactions must the prototype demonstrate? | Only after a prototype is selected. |
| Which existing systems must the feature integrate with? | Only after a working feature is selected, if project evidence does not answer it. |

After an answer, discard branches it rules out, resolve questions it answers
incidentally, and reconsider the remaining map before selecting another batch.

## Ask through Command Center

Read `cctl ask --help` before the first submission for the current command
contract. Write a JSON payload under `.cc/temp/` in the assigned worktree,
then run:

```sh
cctl ask --file .cc/temp/interview-questions.json
```

Use stable, distinct question `id`s so answers can be matched across turns.
Keep each question about one decision. Offer a few meaningful alternatives
with short labels and descriptions of their consequences. Use `context` to
explain why the answer matters; add `tradeoff` when it helps compare options.
Mark an option `recommended: true` only when the known objective supports
it, rather than guessing the user's preferences. `multiSelect: true` fits
compatible choices; mutually exclusive directions use `false`.

This illustrates the payload shape; adapt the content to the actual unknown:

```json
{
  "questions": [
    {
      "id": "next-result",
      "header": "Next result",
      "question": "What should this work produce next?",
      "context": "This determines which follow-up details we need to settle.",
      "options": [
        {
          "label": "Recommendation",
          "description": "Assess the onboarding problem and propose a direction."
        },
        {
          "label": "Interactive prototype",
          "description": "Let stakeholders try the proposed experience.",
          "tradeoff": {
            "pro": "Makes interactions concrete for feedback.",
            "con": "Leaves production integration for later."
          }
        },
        {
          "label": "Working feature",
          "description": "Deliver usable onboarding in the existing product."
        }
      ],
      "multiSelect": false,
      "required": false,
      "allowNote": true
    }
  ]
}
```

Keep `allowNote: true` so the user can qualify a choice or give an unlisted
answer. When useful choices cannot be grounded yet, invite an example in the
note instead of inventing a false set of alternatives. Use `required: false`
when the user may delegate the choice or skip it; use `true` only when their
answer is essential to proceed.

**Submission registers the batch; it does not return the answers.** Only one
batch can be pending. After success, write a brief handoff stating what you
asked and how the answers will guide the next step, then end the turn. Make
any working notes before submitting; further tool calls, polling, or work
after a successful ask violate this handoff.

An "already pending" refusal also means end the turn and await that batch.
An autonomous-conversation refusal means use best judgment within the
authorized scope and state material assumptions. For other failures, follow
the CLI's recovery guidance (`cctl doctor` for connection/auth problems);
report an unresolved failure without claiming a question was delivered.

## Resume and finish

Answers arrive in a subsequent prompt inside `<cc-question-answers>`, keyed
by question id. Read both `selected` labels and `note`: the note may qualify
or override the selections. `skipped: true` means proceed with best judgment,
not acceptance of a suggested option. Treat ordinary user text as current
direction too, including corrections to earlier answers. Carry forward settled
decisions and the remaining branches rather than restarting the interview.

If an answer is unclear or conflicts with a constraint, ask a focused
follow-up only when the difference changes the outcome. If the user delegates
a choice, make it and state any material assumption. If they stop the
interview, summarize what is known and what remains unresolved.

Finish when the intended outcome and next deliverable are clear, scope and
hard constraints are settled, success can be recognized in concrete terms,
and no unresolved question could materially change the authorized next step.
Distinguish confirmed decisions from assumptions and deliberately deferred
details; avoid extending the interview to eliminate every minor uncertainty.

Return a concise objective brief covering the outcome and who benefits,
deliverable and scope boundaries, constraints, success criteria, and any
material assumptions or open items. A final confirmation question is useful
only if that synthesis exposes a consequential gap or contradiction. For an
interview-only request, the brief is the deliverable. If the user already
requested follow-on work, continue it once the interview is complete within
the existing authorization and any applicable approval gates.
