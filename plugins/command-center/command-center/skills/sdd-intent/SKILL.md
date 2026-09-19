---
name: sdd-intent
description: Frame a native Command Center spec's problem, scope, and appetite before requirements. Use to create or revise a spec brief; by default, save the intent and stop before requirements or acceptance criteria.
---

# SDD Intent

Produce a brief the user can use to judge whether the problem and investment are
right. The default result is a saved native spec containing intent sections only.
Honor requests for discussion without saving, or for broader follow-on work.
Explicit user scope governs these defaults within the host's instruction hierarchy.

Use [native-sdd-authoring](../native-sdd-authoring/SKILL.md) for current spec state,
writes, and amendments. Intent lives in the existing Requirements
draft; it has no separate approval gate. Preserve any requirements, criteria,
or design already in a spec when revising its brief.

## Establish the intent

Start with the request, supplied decisions, and relevant project evidence. Search
native specs for existing coverage before creating one, and reuse the relevant
spec. Inspect enough current behavior to ground the problem and identify choices
that could change its scope. Leave new internals and implementation planning
for later.

When missing information about the problem, outcome, scope, success measures,
or appetite materially changes the brief, use [interview](../interview/SKILL.md).
It owns question selection, adaptive batches, and the asynchronous `cctl ask`
handoff. Reuse settled answers and investigate facts the project can supply.
Once the interview resolves the needed choices, resume the requested brief;
when input is unavailable, follow its fallback and identify material assumptions.

Use these existing section roles, checking the current section schema before
writing. A new native spec can begin with an intent section; requirements can
be added in a later task.

| Section role | What the brief must establish |
| --- | --- |
| `intent_problem` | The problem, evidence it occurs, and one representative situation. |
| `intent_outcomes` | The desired result and the surfaces where it matters. |
| `intent_success_measures` | How improvement can be observed; numbers when supported by a baseline. |
| `intent_non_goals` | Plausible adjacent work excluded and ownership boundaries. |
| `intent_constraints` | Appetite, real obligations, and operating conditions that bound the solution. |

Appetite is the investment worth making, such as "within the existing detail
page" or "a modest persistence change is justified." Preserve the user's budget
or scope statement rather than inventing an estimate. Use the target project's
operating envelope, such as `ENVELOPE.md`, when available; otherwise use known
constraints without requiring another document. Distinguish evidence, user
decisions, assumptions, and open questions.

If no spec was requested and the behavior is bounded with no consequential
uncertainty about durability, lifecycle, shared contracts, or integration,
ordinary session work may suffice. Respect existing spec obligations. Size the
work by consequence, not the "bug fix" label or execution-context count.

## Complete the brief

Finish when the requested brief is saved (or returned for discussion), covers
the concerns above, and makes any consequential uncertainty explicit. Verify
the saved content and report the spec's identity, scope, appetite, and remaining
questions. Do not describe unresolved scope as settled.

Leave an intent-only draft unproposed. Native Requirements submission needs
requirements with acceptance criteria; an empty-spec lint finding at this point
does not justify adding placeholders or expanding the task.

For an intent-only request, stop here and name
[sdd-requirements](../sdd-requirements/SKILL.md) as the next step on the same spec.
Saving the brief neither approves it nor authorizes that next step. When the
user already requested requirements as well, continue within that scope once
the necessary intent decisions are settled, using the existing native gates.
