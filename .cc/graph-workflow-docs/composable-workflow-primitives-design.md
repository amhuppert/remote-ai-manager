# Composable Workflow Primitives Design

Canonical design: `.kiro/specs/composable-workflow-primitives/design.md`

## Use This Document When

- Generating implementation tasks for composable workflow primitives
- Implementing `AgentCall`, `Lane`, `Gate`, `StatusBus`, `ArtifactRegistry`,
  or the minimal workflow envelope
- Adapting graph workflow, conversations, merge flows, or Collaboration Mode
  onto the shared primitive layer

## Key Takeaways

- The selected architecture is hybrid extraction with compatibility adapters,
  not an in-place extension and not a full up-front rewrite.
- `ConversationBackendRuntime` and `AgentTaskRunner` remain separate backend
  ports; `AgentCall` sits above them and normalizes execution concerns.
- `Lane`, `Gate`, `StatusBus`, `ArtifactRegistry`, and `WorkflowEnvelope`
  centralize the repeated orchestration mechanics while leaving feature-owned
  workflow logic explicit.
- Existing artifact paths and session/worktree safety rules are preserved.
- Collaboration Mode is the first feature intended to use the new primitive
  layer directly.

## Recommended Next Step

Read the canonical design file before task generation or implementation, and
use its migration strategy section to sequence extraction work behind adapters.
