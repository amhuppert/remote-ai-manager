# Kickoff prompt for the implementing agent

You are implementing Command Center ticket #59, “Add Cursor as a third agent
backend,” in a non-Command Center environment.

Start by reading the live repository's `AGENTS.md`, active Kiro specs, and this
bundle in this order: `README.md`, `IMPLEMENTATION_BRIEF.md`,
`PROPOSED_DESIGN.md`, `EXECUTION_PLAN.md`, `CODE_MAP.md`, then
`sources/ticket-attachments/final-research-answer.md` and
`negotiation-audit.md`. The two research drafts are supporting evidence only;
their SDK-first and ACP-first preferences were superseded by the negotiated
transport bake-off.

Do not begin by adding `"cursor"` to the backend enum. First:

1. Reconcile this bundle's baseline commit
   `fa6bf4306f52926be195bef101e09598494dac3e` with the current checkout.
2. Confirm the repository's Requirements → Design → Tasks approvals with Alex;
   this handoff is proposed design, not approval.
3. Implement and test the standalone command-route unknown-backend validation
   fix.
4. Run the authenticated 2–4 day spike comparing a per-conversation isolated
   `@cursor/sdk` Node worker against a per-conversation ACP child. Produce
   fixtures and a decision table for all ten exit-criteria categories.
5. Select exactly one production transport using the priority in
   `EXECUTION_PLAN.md`, get the decision reviewed, then implement Phase 1 as
   ordinary interactive Cursor conversations.

Keep all Cursor-native behavior under `src/lib/agent-backends/cursor/`. Use a
small injected Cursor-local transport port; do not `vi.mock()` internal project
modules. Preserve native events losslessly, keep `AgentSessionRef.ref` opaque,
use structured logging without secrets, and reuse shared structured-output,
timeout/stall, environment, MCP, and managed-skills patterns only where Cursor
evidence supports the same contract.

Phase 1 is conversation-only. Declare filesystem restriction unsupported,
queue only for the next turn, structured output as post-validation, fork as
synthetic or unsupported, and no external/native-ask/capability-cascade claims
unless the spike proves otherwise. Do not add `cursorFastMode`, a static Cursor
model catalog, token-price cost estimates, governed task eligibility, validator
eligibility, or Cursor participation in Collaboration Mode.

When blocked by missing auth, an approval gate, or the non-CC validation-rule
exception, stop and ask Alex. Do not silently weaken scope, safety claims, or
repository process.

