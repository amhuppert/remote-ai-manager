---
name: sdd-design
description: Author or review a native Command Center design against approved requirements. Use to settle system fit, user journeys, runtime premises, shared contracts, and feasibility before the existing Design gate.
---

# SDD Design

Produce a design an implementer can execute without inventing promised behavior,
shared contracts, or integration ownership. Keep routine local implementation
choices open. Use [native-sdd-authoring](../native-sdd-authoring/SKILL.md) for
current spec state, writes, review repairs, and human gates. Start from the
approved requirements and the user's scope and appetite.

For a review request, use the [design review](references/design-review.md)
reference and return findings. For authoring, use the guidance below and that
same review before proposing. A review-only request does not authorize repairs.

## Ground the approach

Read the existing owners, interfaces, and production paths affected by the
change, plus the target project's operating constraints. Stop investigating when
the consequential claims can be supported and the changed boundaries explained;
broaden only for an unresolved dependency or new evidence.

Apply the existing [Premise rule](../graph-workflow-planning/SKILL.md#premise-rule)
at design time. Place its verified or inferred labels beside runtime claims,
with the source and observed fact. Identify planned new behavior separately,
including its proposed producer. A requirement can need new data or transitions;
the design must account for producing them rather than assert they already exist.

If feasibility changes the approved behavioral contract, use the native return
or amendment path. Keep that change visible to the human instead of absorbing
it into an implementation choice.

## Describe the design

Use the [design outline](references/design-outline.md) inside existing
`design_narrative` sections and decision elements. It covers system fit,
complexity, surfaces and states, ownership, lifecycle, runtime behavior, proof,
and consequential choices. Combine short concerns and identify unchanged ones
briefly; detail should resolve implementation uncertainty, not fill a template.

When UI or CLI behavior changes, include the outline's surface inventory and
principal journey. They connect discovery and actions to real data and owners,
so a component or command cannot silently become an isolated deliverable.

When an uncertain changed boundary or independently implemented consumers would
benefit from a shared shape, use the
[contract prototype](references/contract-prototype.md) guidance. It defines the
exploratory scope, evidence limits, and delivery handoff. Otherwise, a clear
contract in the narrative is sufficient.

## Complete the Design task

Before proposing, demonstrate the principal journey, trace a critical datum to
its visible result, and account for consequential transitions, changed contracts,
integration ownership, and scope within the appetite. Required premises must be
verified or supplied as explicit new work. Remaining choices must be local to
implementation or disclosed limitations consistent with the approved contract.

Use the design review reference to assess those claims, then finish the native
lint and consistency sweep and the requested draft or proposal. Report the
evidence, unresolved findings, and actual submission state. Human approval
remains the existing Design gate; the review adds no approval act.

After that gate, [sdd-delivery](../sdd-delivery/SKILL.md) prepares delivery of the
approved contract when requested.
