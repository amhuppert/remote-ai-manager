---
name: sdd-delivery
description: Prepare delivery of an approved native Command Center design, with owned contracts, production wiring, and journey evidence. Use for the managed plan, or to carry those obligations through authorized implementation and closeout.
---

# SDD Delivery

Make the approved design executable without losing its scope, premises, or user
journeys. Finish the delivery work requested: planning produces a reviewable
plan; implementation produces the approved behavior and evidence.

Use [native-sdd-authoring](../native-sdd-authoring/SKILL.md) for current state,
human gates, and discoveries. When planning a managed graph, use
[graph-workflow-planning](../graph-workflow-planning/SKILL.md) and its
[native delivery reference](../graph-workflow-planning/references/native-spec-delivery.md)
for decomposition, ownership, criteria, coverage, placement, and submission.
Plan against the attempt's pinned approved revision. For authorized session
delivery, apply the same ownership and proof principles to session tasks without
creating an unnecessary graph.

## Prepare the handoff

Map the design's surfaces, contracts, state classes, and critical data path to
implementation responsibilities. Use the planning skill's producer, consumer,
and matched-deferral rules to assign production wiring. Leave no behavior,
shared interface, or integration responsibility for separate agents to invent.

Use a foundation context when shared changed contracts must precede independent
consumers, and limit it to what the first working path consumes. If design
supplied a prototype, apply its
[delivery handoff](../sdd-design/references/contract-prototype.md#handoff-to-delivery),
including source availability and adoption responsibilities. Schedule the thin
working path the design named, through a real entry point, action, and
observable result, as the first context after tooling; broaden or parallelize
once the necessary boundaries are settled. A broad safety or persistence owner
scheduled ahead of that path is the first circuit breaker waiting to fire. Cut
contexts at validation boundaries, not to achieve a preferred context count.

Plan-authored criteria (records with no `covers`) are obligations the spec
never approved. Keep them to what the design names, and expect the propose gate
to list every context that owns nothing but plan-authored criteria; each one
needs a justification in its description or a `covers` entry.

Give each changed journey an integration owner and criteria that exercise its
normal entry point, meaningful action, and result. Split separately failable
outcomes, for example:

- From the normal records list, open a record, change its label, and return to
  the list; the saved label is shown after reload.
- When saving is refused, the detail view explains the refusal and retains the
  editable value.

For CLI work, include help discovery, production invocation, output, and state.
Use the composed-UI rule when applicable. Map context-local criteria with
`covers` to pinned spec criterion IDs under the native delivery reference;
several spec criteria may share one journey proof. Final live verification
checks the composition; implementation owners still build its production callers.

## Keep scope visible

Carry the operating envelope into the charter itself, not only as a ranked
source: put its "outside the envelope" list and the accepted-input policy into
`nonGoals`, where implementers decline against them and validators treat
findings that need those conditions as advisories. A source document ranked
below the pinned design loses to it on every disputed reading; in one audited
run the envelope sat twenty-ninth of thirty-nine sources and never bounded a
verdict. Still include the document as a source resolvable from execution
worktrees. Apply global constraints globally and scope feature-specific sources
to their consumers. Without an envelope document, carry known constraints in
the charter rather than requiring another file or assuming Command Center's
operating conditions.

Put this convention once in the charter's `conventions`, or in session
implementation instructions:

> Make the smallest coherent change satisfying the approved behavior. Reuse
> existing owners, preserve unrelated code, and justify each new abstraction or
> safeguard by an approved obligation or observed failure within scope.

Keep process conventions separate from validator-checked outcomes. Preserve the
project's engineering rules and the agreed appetite.

## Complete the requested delivery work

For planning, account for the selected criteria, contract dependencies,
production wiring, and evidence owners. Check that cited sources reach their
consumers and that no required runtime premise remains inferred. Finish the
existing graph validation and requested review, then submit the authorized
proposal. Report its state and unresolved items; launch requires authorization
and the existing human sign-off.

For implementation, verify the agreed behavior at the appropriate layers and
exercise the live journeys assigned by the plan. Before browser work, use
`cctl dev ensure` and confirm the served code contains the candidate under review.
Honor registered validation commands. Record the actions, observed results,
durable state where required, and important paths left unverified. Completion
requires the applicable checks and existing delivery gate, not just a compiling
contract or a component demonstration.

Route discoveries changing approved behavior or consequential design choices
through native-sdd-authoring's capture and amendment mechanisms. Broaden or repeat
verification only for changes, failures, or unresolved concerns.

At closeout, add a short trial note to ordinary delivery evidence: consequential
decisions invented during implementation, plan repairs, missed wiring, scope
growth, clarification burden, and effort through acceptance when known. Separate
observations from estimates. Use this to improve the guidance after real use;
the note adds no acceptance condition, and pass rate alone does not establish
workflow quality.
