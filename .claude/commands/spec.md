---
description: Author a durable native Command Center spec in this conversation
allowed-tools: Bash, Read, Glob, Grep
argument-hint: <what-to-specify>
---

# Native Spec Authoring

Author a native Command Center spec for `$ARGUMENTS` in this conversation.

<!-- BEGIN SHARED SPEC GUIDANCE -->

## Authoring surface

Conversations author; Spec Studio reviews, approves, and browses.
Do not write or update `.kiro/specs/`, and do not treat a conversation
document as the authoritative spec object.

Read `cctl spec --help` and the relevant leaf help before composing
payloads: every verb documents its own flags, refusals, and next step.

## Find an existing spec before creating one

`cctl spec list` returns this project's durable inventory with each
spec's phase and approval summary. `cctl spec search --all <query>`
matches requirement and decision text across every spec in the project
and reports each hit's slug, phase and preset. Use either before creating
anything so you do not open a competing object for work that already has
a spec; search answers it directly when you have wording to match on.

`cctl spec search <slug> <query>` is the single-spec form: with a slug
positional it matches requirement and decision text within that one spec
only.

## Durable first save

Choose a stable kebab-case slug, a clear name, and an intentional gate
preset; prefer `contract-bearing` when the user has not chosen one.

No durable spec exists until the first successful draft save. When the
first element is ready, run `cctl spec create --slug <slug> --name <name>
--preset <preset> --file <first-element.json>` — one atomic call that
creates the spec, its draft revision, and the first element together,
visible immediately through `cctl spec list` and Spec Studio. Do not
create the spec before the first element is ready.

Partial drafts are valid. Continue with element-granular `cctl spec draft`
writes carrying the last observed `--base-version`; a stale write returns
the winning content and version. If create refuses with `slug_taken`,
follow the returned instruction: continue the existing draft or choose a
different slug.

## Staged authoring

`cctl spec status` reports the draft's authoring stage, and that stage is
the server-enforced write boundary: requirements admits intent and context
prose, requirements, and acceptance criteria; design adds decisions and
design narrative; plan adds tasks. A `stage_blocked` refusal means the
element belongs to a later stage — follow its instruction instead of
authoring ahead.

Conclude a stage with `cctl spec propose <slug>`, which freezes the
editable revision for review of that stage. When the stage's concluding
dial is Notify or Off, cross the boundary explicitly with `cctl spec
advance <slug> --from <requirements|design>`; the expected stage keeps a
stale command from advancing a replacement revision. When the dial is
Gate, only human sign-off advances the draft. A pure combined-approval
policy opens directly at plan stage and preserves single-pass authoring.

Before saving tasks, read `cctl spec draft --help` for the plan-stage
graph discipline the compiler and reviewers expect.

## Continuing an approved spec

An approved gate ends that revision, not the spec. When the gate is
approved and no draft is open, continue the spec by opening an amendment:
`cctl spec amend <slug>` opens the next draft from the approved revision,
and authoring resumes through `cctl spec draft`.

An amendment opens at the stage after its approved base, so an amendment
on an approved plan-stage revision opens at plan stage and admits every
element kind.

## Execution start is a handoff

Only an approved plan-stage revision can execute, and `cctl spec start
<slug> --file <scope.json>` does not launch a lane. It compiles the
approved revision and the selected scope into a graph workflow definition
and parks the spec execution in `definition_review` with no workflow
execution attached.

The run begins when that definition is started: `cctl workflow start
<definitionId>`, using the `definition.id` the start response returns. The
spec execution leaves `definition_review` once the linked workflow reports
a live status.

When the `execution_start` dial is Gate, the compiled definition carries
an approval requirement and the run parks at a human approval boundary
that opens a durable Needs You request. That boundary is intentional:
report it and hand off. There is no agent route around it.

## Human-only acts

Approvals, sign-off, waivers, assumption disposition, rename, and gate
policy changes are human-only Spec Studio acts. No `cctl spec` verb
changes gate policy, and an agent transport that reaches a human-only
action receives a typed `human_act_required` refusal telling it to
perform the action from the authenticated browser session.

Never approve, sign off, dispose assumptions, or change gate policy on
the user's behalf. Ask the operator to act in Spec Studio and continue
with whatever remains authorable.

Proof verdicts are recorded only by the delivery gate from machine
evidence (test runs, validator verdicts, commits). No one records them
by hand. When a criterion cannot be machine-proven, the human remedy is
a waiver: Spec Studio → Controls → Merge gate → Waive…

## Elicitation

Use `cctl ask` only when missing product intent would materially change
the spec. Question batches stay small, skippable, visible in the
conversation, and prunable as they resolve. The server never blocks on
elicitation: if a batch is skipped or no answer arrives, proceed with the
safest reasonable judgment.

Open questions that belong to the spec itself are recorded durably with
`cctl spec question` — they become addressable (Q1, Q2, …) and reviewable
in Spec Studio, where the human answers them (`cctl spec answer` is the
human half; agent transports receive a typed refusal). Record meaningful
assumptions through `cctl spec assume` when proceeding without an answer.

## Ask payloads

Put each related question batch in a JSON payload under `.cc/temp/`, then
submit it with `cctl ask --file <payload>`. When `cctl ask` accepts a
batch, end the turn as required by the ask protocol and continue authoring
after the answers arrive. Author spec element payload files under
`.cc/temp/` as well.

## Plan-stage execution graph

Apply the graph-workflow-planning discipline before saving tasks:

- Size each task for one agent lane. Split work that one agent cannot
  complete coherently; compilation can group tasks but never splits one.
- Record `dependsOnTaskElementIds` as ordering truth. Two tasks without a
  dependency path are an explicit claim that they may execute in parallel.
- Use `laneGroup` only when several small tasks intentionally share one
  lane. Intra-group dependencies determine their order.
- Declare normalized repo-relative POSIX `touchedPaths` so conflicting
  parallel surfaces are reviewable, and cover every applicable criterion.
- Review `cctl spec status` for the resulting dependencies, grouping,
  touched surfaces, criterion coverage, and graph-shape findings before
  proposing.

<!-- END SHARED SPEC GUIDANCE -->
