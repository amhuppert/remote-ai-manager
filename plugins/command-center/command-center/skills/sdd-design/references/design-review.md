# Design review

Assess the current design against approved requirements, the user's appetite,
and the cited project evidence. The result is actionable findings and a readiness
recommendation for the existing human Design gate.

Apply the **Feasibility** lens from
[graph-workflow-review](../../graph-workflow-review/SKILL.md#three-lenses-weighted-equally)
and the existing **Premise rule** it references. Verify the author's evidence;
a "verified" label alone proves nothing. Apply runtime-fact and breadth checks
to design claims, using domain owners until delivery assigns contexts. The graph
skill's plan validation and verdict commands apply to plan revisions, not native
Design approval.

## Demonstrate the claims

Use the following demonstrations to expose evidence for that lens, rather than
score document completeness:

- Walk the principal scenario from normal entry to result and its important
  failure or unavailable state.
- Trace a critical datum from producer to visible output, identifying new work.
- Explain consequential transitions and the guarantees the application controls.
- Show agreement on shared contracts and integration responsibilities.
- Explain fit with the envelope and appetite, including the simpler alternative.
- Separate safe implementation choices from unresolved changes to behavior,
  shared contracts, ownership, or cost.

For substantial or uncertain work, use a fresh reviewer context when available
and authorized. A bounded rehearsal can ask another agent to outline the
implementation and list decisions still needed, using the design and its raw
sources. Invented navigation, retention guarantees, or shared interfaces expose
gaps; local helper names do not. Neither a reviewer nor a rehearsal adds a gate.

## Findings and completion

For each finding, identify the section or decision, observable consequence,
basis (evidence, inference, decision, or open question), and concrete repair.
Cite evidence for claimed defects; distinguish inability to verify from proof
of failure. Prefer narrowing, moving, removing, or splitting before adding work.
A speculative improvement alone does not justify expanding scope.

A finding that adds behavior names the envelope row or approved obligation that
pays for it; without one it is a suggestion, not a finding. When a rehearsal
exposes public behavior the design leaves unstated, list "unsupported in this
version, refused with a plain error" among the resolutions, not only "specify
it". Close the review with an aggregate line: what the accepted findings add,
what they remove, and at least one candidate for removal the author should
consider, or a statement that none exists. A review whose every finding pins
more behavior has reviewed the contract, not its proportion.

Report every known blocking class, grouping sibling instances, and keep optional
suggestions bounded. On repair rounds, review changed semantics and consistency;
reopen other decisions only for new evidence. Finish once the scoped claims have
been assessed and all known findings reported. Recommend readiness only when
blockers are resolved and the existing consistency checks pass. Approval and
assumption disposition remain human acts.
