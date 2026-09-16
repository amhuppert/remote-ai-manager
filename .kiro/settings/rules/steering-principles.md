# Steering principles

Steering records durable project rules and decision context. A feature's requirements and design belong to its spec; current commands, versions, and file inventories remain in their executable or structural sources.

## Select useful guidance

Include conventions that change an agent's decisions: responsibility boundaries, naming/import patterns, architectural choices, and non-obvious constraints with their reasons. Use a small concrete example when it clarifies a convention. If new code follows an existing pattern, that alone does not require a steering update.

Keep one domain per document and one authoritative home per rule. Put detailed, conditional guidance in a reference and add a pointer stating when to read it. Do not copy exhaustive file/component/dependency lists, generic best practices, or agent tooling inventories. Link a tooling instruction when it is necessary for the domain.

Use the actual repository as evidence. Templates suggest topics to investigate; they do not establish policies. Keep credentials and sensitive data out of guidance; use placeholders where an example needs them.

## Update without accumulating drift

Preserve valid user decisions and examples. Correct demonstrably stale claims, remove duplication, and retire obsolete guidance rather than appending contradictory layers. If the intended rule and current code disagree, identify which is authoritative before changing the policy. Record historical rationale in a dated report or lessons log when it matters, leaving steering about the current contract.

Root instructions determine which steering loads automatically. For an on-demand file, provide a pointer with the condition for reading it; directory membership does not load it. Core files cover product purpose, technology decisions, and organization patterns. Custom files cover specialized domains at the same standard of accuracy.
