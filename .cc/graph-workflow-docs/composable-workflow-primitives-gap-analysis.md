# Composable Workflow Primitives Gap Analysis

Canonical analysis: `.kiro/specs/composable-workflow-primitives/gap-analysis.md`

## Use This Document When

- Starting the design phase for composable workflow primitives
- Deciding which existing subsystems should seed `AgentCall`, `Lane`, `Gate`, `StatusBus`, `ArtifactRegistry`, and the workflow envelope

## Key Takeaways

- The codebase already contains strong seeds for the target primitives, especially in graph workflow continuity, structured-output validation, reference-document handling, and SSE delivery.
- The work should be an extraction with compatibility adapters, not a rewrite.
- The main requirements-quality blocker found during gap validation was an omitted `Context Limit` gate requirement. That requirement has been added to `requirements.md`.
- Collaboration Mode is still absent and remains the best proving ground for the extracted primitives.

## Recommended Next Step

Read the canonical gap analysis file before writing `design.md`, and use Option C from that document as the starting design direction.
