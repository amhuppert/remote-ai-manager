---
name: sdd-requirements
description: Turn a native Command Center spec brief into observable requirements and acceptance criteria, or revise its behavioral contract. Use sdd-intent when the requested deliverable is only problem framing, scope, and appetite.
---

# SDD Requirements

Define the behavior that would satisfy the user, precisely enough for two
implementers to build compatible results and a reviewer to identify failure.
Use [native-sdd-authoring](../native-sdd-authoring/SKILL.md) for discovery,
current state, element schemas, amendments, lint, and proposal mechanics.
Honor the requested scope and the existing human gates.

## Establish the starting contract

Read the spec's intent and current stage alongside subsequent user decisions.
Reuse its outcome, scope, success measures, and appetite. A request to expand
the brief authorizes Requirements authoring; no separate intent approval is needed.

If intent is missing, use [sdd-intent](../sdd-intent/SKILL.md) to establish it.
That skill owns the section mapping and conditional interview. Supplied decisions
can be recorded directly. A request for requirements already authorizes continuing
past the brief once consequential unknowns are resolved; do not require another
invocation merely because the intent had not been saved.

## Write observable obligations

Inspect the existing surfaces and capabilities the requirements depend on. For
each intended outcome, state its trigger, relevant state, observable result,
and important negative or unavailable case. Use revealing acceptance examples
to expose ambiguity rather than generating an exhaustive-looking catalogue.
Keep unresolved questions separate from accepted behavior.

Technical language is appropriate when it names a real obligation: stdout shape,
refusal codes, durability, and protocol constraints can be requirements. New
storage layouts, services, frameworks, and task order are design or delivery
choices. For example:

> Inspecting a stopped run shows its recorded reason, or explicitly says that
> the reason is unavailable.

"The reason remains available after restart" is another obligation if desired.
If the current system cannot supply it, identify the gap for Design to resolve
through new work or a proposed change to the contract.

Apply the [acceptance-criteria rules](../graph-workflow-planning/SKILL.md#acceptance-criteria)
to spec criteria: one independently failable obligation per criterion, bounded
named surfaces, and outcomes an inspector can observe. Inventory a surface
before using "all" or "every" over it. Keep process conventions outside criteria.
EARS is optional; sentence shape does not establish completeness.

Every requirement carries one line naming what it obliges downstream: a new
owner, a new class of proof, a new class of accepted input, or a new failure
classification. Where a simpler contract would serve the envelope, present it
as the requirement and the fuller one as an alternative with what it gives up;
the reviewer then approves a choice instead of editing a proposal.

State the accepted-input policy once, in a section: which inputs the tool
refuses with a plain error (for example symlinks inside selected trees,
special files, names that collide under the destination's rules) and which it
handles. Do not derive per-criterion defenses from the envelope's trust row;
"external data can be hostile" means it is never executed, not that every
layout it can take is handled.

Set each criterion's validation-strategy kinds and leave the note empty unless
it says something specific to that criterion. A verification approach shared
by several criteria belongs once in the design; lint reports identical notes.

For each changed journey, include an example from the normal entry point through
the meaningful action to its result. Name important failure or unavailable
behavior as separate obligations where independently failable. Design settles
the route and wiring; delivery assigns responsibility for proving the journey.

## Complete the Requirements task

Account for every in-scope outcome in requirements and criteria, with traceable
acceptance examples and no consequential question silently treated as settled.
Check the two tests again: compatible observable behavior across implementers,
and evidence that would falsify each obligation.

Write into the existing Requirements draft or the appropriate amendment. Run
native-sdd-authoring's lint and consistency sweep, repair findings, and complete
the requested draft or proposal. Report its actual state and unresolved items.
Repeat review only for changed content, failures, or new evidence.

The next phase is [sdd-design](../sdd-design/SKILL.md), after the existing
Requirements gate is satisfied and the user has authorized that work.
