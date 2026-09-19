# Contract prototype

Use a prototype when it materially reduces uncertainty at a changed boundary
or gives independent consumers a common shape. State the question it answers
and keep the experiment within the authorized scope and project conventions.

## During design

Prototype only the relevant schemas, interfaces, persisted shapes, event or route
contracts, and a realistic consumer. Keep exploratory code out of active production
behavior; use clearly failing stubs where needed. Clear boundaries do not require
a prototype.

Record the paths, inspected revision or diff, checks performed, and unresolved
runtime obligations in the design. Compilation proves shape compatibility, not
retention, identity across revisions, provider precedence, or reachability. Verify
those facts under the existing premise rule. A commit reference identifies what
was inspected; Native SDD approval does not fingerprint the referenced source.

## Handoff to delivery

Make the contract available where its consumers will execute. A path in ignored
session scratch such as `.cc/temp` is only an inspection locator. Transfer its
needed content through a source in the execution worktrees, a
[seeded document](../../graph-workflow-planning/references/seeded-documents.md),
or a complete contract in the pinned design before launch.

Assign adoption, revision, or replacement to the delivery foundation owner and
verify the actual consumer baseline. Assign producers, mappings, and production
wiring under the planning skill's ownership rules. A compiling scaffold does
not satisfy runtime obligations: the thin production path must execute through
real callers. Apply the project's ordinary test policy to adopted behavior and
remove experimental remnants before shipping.
