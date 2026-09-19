# Design outline

Use these concerns as headings within existing `design_narrative` sections,
not as new schema roles or nine required elements. Combine short concerns and
mark unchanged ones briefly. Choose detail by consequence and uncertainty.

| Concern | What the design must explain when it changes |
| --- | --- |
| Proposed change and boundary | The approved behavior delivered, its requirement references, and excluded adjacent work. |
| Existing-system fit | Current owners, interfaces, and production entry points reused or changed, with supporting sources. |
| Envelope and complexity | Operating conditions that justify new mechanisms and why simpler existing approaches are insufficient. |
| Experience | How the user or agent discovers, acts, understands the result, and recovers; affected surfaces and state classes. |
| Ownership and contracts | Canonical definitions, producers, consumers, and integration responsibilities for changed boundaries. |
| Data, lifecycle, compatibility | Changed records, identity, retention, transitions, mappings, and applicable migration or compatibility obligations. |
| Runtime behavior | Consequential ordering, concurrency, failures, and cross-boundary effects, including limits of application control. |
| Integration and proof | A critical data path, an early thin production path, and the evidence that can establish each important obligation. |
| Decisions and limits | Consequential choices, deliberately unhandled cases, remaining questions, and safe implementation freedom. |

## Operating conditions and decisions

Use the target project's envelope or documented constraints, including users,
concurrency, trust, lifetime, compatibility, scale, and failure cost where relevant.
For each proposed mechanism, connect its cost to an approved obligation or
observed failure and explain why the simpler approach falls short. Keep
abstractions that hide real complexity; ordinary engineering quality applies
within every envelope.

Record consequential choices in native decision elements. Include a credible
simpler alternative, consequences, reversal cost, and what would require
revisiting the decision. Use existing fields: the current decision schema's
`reason` text can carry consequences and reversal cost. Trace requirements and
reference the decision from the narrative rather than duplicating it.

## Surfaces and states

For UI or CLI changes, describe the principal journey and inventory the changed
surfaces at the level of places, actions, and connections:

| Surface | Entry point | Interaction | Relevant states | Data source | Action owner | Evidence owner |
| --- | --- | --- | --- | --- | --- | --- |
| Page, panel, control, or verb | Existing way in, or explicit work adding it | Action and information needed to use it | Applicable state classes | Producer of displayed facts | Production mutation or command and owning module | Responsibility for proving the journey |

Use domain or module responsibilities now; delivery assigns execution-context
IDs. Name new entry points as work. For CLI changes, include help discovery,
invocation, output modes, and resulting state. Consider empty, loading, populated,
truncated, error, unavailable, and narrow-layout states only where they apply.

Inventory other consequential state spaces where they belong: parser input
classes, revision transitions, retained histories, or concurrency cases. Say
whether the inventory is exhaustive. Enumerate relevant classes rather than
every combination. Use state, sequence, or deployment diagrams when they make
lifecycle, ordering, or process boundaries clearer.

## Evidence and remaining choices

Connect each important obligation to suitable evidence: structural checks for
shapes, behavior tests for rules, persistence round trips for durability, and
live journeys for discovery and wiring. A sketch explains a proposed experience;
a component story demonstrates selected inputs. Neither proves live reachability.

Keep premise evidence beside each claim, using the existing premise rule. Collect
unresolved consequential items in Decisions and limits. Resolve them by verifying
the fact, specifying the new work, or returning a changed contract to the user.
An accepted risk cannot establish a required runtime fact.
