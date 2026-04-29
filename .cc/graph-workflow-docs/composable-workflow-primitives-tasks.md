# Composable Workflow Primitives Tasks

Canonical task plan: `.kiro/specs/composable-workflow-primitives/tasks.md`

## Use This Document When

- Preparing `/kiro:spec-impl` work for composable workflow primitives
- Choosing which primitive service or adapter slice to implement next
- Checking the approved migration order for primitive extraction

## Task Groups

- Build the shared execution facade, lane service, and gate library first.
- Extract scoped status, artifact registration, and workflow envelope persistence next.
- Migrate existing features behind adapters before expanding the first primitive-native Collaboration Mode slice.
- Finish with backend-capability hardening, parity verification, and multi-lane safety checks.
