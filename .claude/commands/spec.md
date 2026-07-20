---
description: Author a durable native Command Center spec in this conversation
allowed-tools: Bash, Read, Glob, Grep
argument-hint: <what-to-specify>
---

# Native Spec Authoring

Author a native Command Center spec for `$ARGUMENTS` in this conversation.
Conversations author; Spec Studio reviews, approves, and browses. Do not write
or update `.kiro/specs/`, and do not treat a conversation document as the
authoritative spec object.

## Elicitation

Use the existing `cctl ask` machinery when missing product intent would
materially change the spec. Put each related question batch in a JSON payload
under `.cc/temp/`, then submit it with `cctl ask --file <payload>`. Keep every
batch small and explicitly skippable, keep questions and answers visible in the
conversation, and prune resolved or irrelevant questions and checklist items
from later batches. When `cctl ask` accepts a batch, end the turn as required by
the ask protocol and continue authoring after the answers arrive.

Elicitation is advisory: the server never blocks on elicitation. If a batch is
skipped or no answer arrives, proceed with the safest reasonable judgment and
record any meaningful assumption through `cctl spec assume` so it stays visible
for human disposition.

## Durable first save

1. Read `cctl spec --help` and the relevant leaf help before composing payloads.
2. Use `cctl spec list` and `cctl spec search` to avoid creating a competing
   object for work that already has a spec.
3. Choose a stable kebab-case slug, a clear name, and an intentional gate
   preset. When the user has not selected a preset, prefer `contract-bearing`.
4. No durable spec exists until the first successful draft save. When the
   first element is ready, run `cctl spec create --slug <slug> --name <name>
   --preset <preset> --file <element.json>` — one atomic call that creates the
   spec, its draft revision, and the first element together. Author payload
   files under `.cc/temp/`. Partial drafts are valid; do not wait for every
   section, and do not create the spec before the first element is ready. If
   the slug is taken, the server refuses with `slug_taken` — follow its
   instruction to continue the existing draft or choose a different slug.
5. Confirm the save through `cctl spec list`, `cctl spec show <slug>`, or
   `cctl spec get <slug>/<handle>`. The spec must be discoverable immediately
   from the CLI and Spec Studio while it is incomplete.

Continue authoring with element-granular `cctl spec draft` writes, always using
the last observed `--base-version`. Capture unresolved matters with the
`question`, `answer`, and `assume` verbs — `cctl spec question` opens a durable
Q record that stays visible in `spec status` until answered. Use `cctl spec status` to inspect coverage and gate state,
and run `cctl spec propose <slug>` only when the draft is ready for Studio
review. Never approve, sign off, change gate policy, or record proof verdicts on
the user's behalf.
