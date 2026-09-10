---
name: graph-workflow-development
description: Use when designing or reviewing changes to Command Center's graph workflow feature, including audit-driven fixes and Native SDD integration. Does not cover authoring individual workflow plans.
---

# Graph workflow development

Keep graph workflows maintainable and easy for planning agents, implementers, and validators to reason about.

- **Complexity:** Assess both implementation complexity and the concepts and rules agents must understand. Prefer changes that reduce these burdens; justify any increase against its ongoing cost.
- **Root causes:** Before adding machinery or special cases, examine why the execution model produces the problem. Revisit prior design decisions and seek a simpler model that achieves the underlying goal.
- **General usefulness:** Ground recommendations in evidence and explain why they benefit typical future workflows. Leave the feature unchanged when an isolated audit finding does not justify the ongoing cost.
- **Native SDD parity:** Keep planning essentially the same for SDD and non-SDD workflows, with little to no added indirection. SDD-backed workflows must retain every graph workflow capability available to non-SDD workflows.

Keep the design rationale brief: expected general benefit, complexity tradeoffs, and SDD parity where affected.
