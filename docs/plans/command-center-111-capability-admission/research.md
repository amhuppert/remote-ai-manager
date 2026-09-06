# Capability admission research — command-center#111

Date: 2026-09-05. Ticket: **Cursor parity: enforce capability admission and accurate feature availability**, child of command-center#110.

Source revision: `06159859ac88c34706cc19943c9c5cfb3020606a`. Installed `@cursor/sdk`: `1.0.28`. The worktree had the parity audit as an existing untracked document; it was preserved. No application code was changed for this research.

## Conclusion

The ticket is implementable without adding Cursor provider capabilities. Its work is to enforce existing negative declarations, describe partially supported operations accurately, and introduce explicit execution eligibility before a future task runner is registered.

The design needs separate answers to three questions:

1. Does this backend expose the required execution facet and task profile?
2. Has the backend been admitted to this execution class?
3. Can that exact facet satisfy the request's instruction and filesystem requirements?

A task-facet boolean cannot answer all three. An ordinary conversation, an isolated formatting task, and a validator have different contracts. A restricted future Cursor task runner must not acquire governed eligibility simply by existing.

The solution and accepted design decisions are in [design.md](design.md). The findings below describe the researched baseline; subsequent implementation evidence is in [validation.md](validation.md). No native specification was created.

## Evidence and scope

The live ticket and its relationships were read through `cctl ticket get`. No native spec currently covers this ticket in `cctl spec list`. Memory recall for backend task/role admission returned no notes. The referenced [parity audit](../../reports/2026-09-04-cursor-backend-parity-audit.md) was checked against current source rather than treated as authoritative for mutable behavior.

The original [Cursor implementation brief](../command-center-59-cursor-backend/IMPLEMENTATION_BRIEF.md) permits ordinary conversations with first-user-message instructions, but requires privileged instructions and exact confinement before Cursor validators, ownership-confined roles, or charter-governed tasks become eligible. #111 establishes admission and refusal; #117 delivers and proves those mechanisms.

### Findings

| Finding | Current source evidence | Consequence |
| --- | --- | --- |
| Facet admission is intentionally broad | `src/lib/agent-backends/facet-gating.ts:25`; its test changes only `tasks` to true and expects admission (`facet-gating.test.ts:53`) | Keep facet existence as a primitive, but stop using it as complete role eligibility. |
| Catalog omits execution guarantees and task profiles | `agent-backends/catalog.ts:95` projects facet booleans and conversation capabilities; filesystem declarations live in separate static maps | Project an explicit client-safe execution policy from the same descriptor literals and use it in UI and server checks. |
| Built-ins are not filtered by backend requirements | `commands/backend-command-catalog.ts:63`; `commands/built-in-commands.ts:132`; `PromptEditorSlashCommandPopup.tsx:174` | Unsupported commands remain advertised; scope filtering alone is insufficient. |
| `/ticket` depends on a task | `tickets/slash-command.ts:361`; `conversation-commands/service.ts:684` | Reject before command transcript/conversation mutations and before ticket generation, with a service-level check for alternate callers. |
| Quick Ticket persists before discovering enrichment is unsupported | `tickets/create-attachment-planner.ts:265`; `tickets/service-factory.ts:186`; `tickets/enrichment.ts:222` | Keep ticket creation, preflight optional enrichment, and return the existing warning channel instead of starting a doomed task. |
| Task-backed settings only have UI facet checks | `NamingSection.tsx:104`; `CompactionSection.tsx:131`; `config/schemas.ts:93,142,472`; `config/loader.ts:285`; `config/route-handlers.ts:109` | Validate effective naming/compaction choices on writes and again before dispatch. Do not ban Cursor as the conversation default. |
| Unsupported forks return successful copied history | `conversations/service.ts:569,615,654,700`; `cursor/continuity.ts:323` | Refuse session-derived forks before creating a target. Treat unexpected adapter refusal as failure with cleanup. |
| Cursor silently retains an unenforceable filesystem policy | `cursor/conversation-runtime.ts:206`; `cursor/production-wiring.ts:171` | Refuse at runtime creation, before transport construction. This is already required by `conversation.ts:325`. |
| Some launches bypass AgentCall | `agent-runs/service.ts:393`; `workflows/conversation/execute-fresh-task-run.ts:191`; `conversations/name-generation.ts:168`; `tickets/enrichment.ts:222`; `sessions/service.ts:472` | One facade-only guard leaves holes. Cover direct task dispatch and runtime creation, including retries. |
| Runtime resolution can already spawn | `workflows/primitives/agent-call-facade.ts:389`; `collaboration/agent-caller-production.ts:297` | Check the known backend and role before resolving/constructing a runtime, then recheck the concrete dispatch. |

Paths in the table are relative to `src/lib/` unless a longer path is given; UI filenames are mapped in the design's change inventory. Line numbers identify this pinned revision and will move during implementation.

## Commands and optional stages

Seven built-ins need explicit product semantics, rather than a blanket task-facet filter:

| Command | Required work | Cursor behavior to preserve or expose |
| --- | --- | --- |
| `/ticket` | Task generates ticket fields from the conversation | Unavailable until task/profile admission succeeds. Ticket CRUD remains available. |
| `/collab` | Existing collaboration eligibility and configured lanes | Unavailable under the existing Cursor exclusion. Reuse the collaboration policy's reason. |
| `/commit` | Deterministic git operation; task can generate a message; failed validation may need agent repair | Keep the clean path. Select the existing default message directly when generation is unavailable. Disclose unavailable automatic repair. |
| `/merge` | Deterministic merge/validation; generated message, validation repair and conflict assistance are separate stages | Keep supported stages and their current rollback/recovery semantics. A default message does not establish task parity. |
| `/rebase` | Git rebase; conflict assistance is conditional | Keep a clean rebase. Refuse unavailable agent conflict assistance before dispatch. |
| `/align` | Ordinary conversation authors a charter draft | Available within existing session rules. Authoring a draft does not admit governed automation. |
| `/spec` | Ordinary conversation receives spec-authoring guidance | Available. Managed delivery uses separate workflow eligibility. |

The explicit message fallback is in `conversation-commands/service.ts:304–361,470–495`; rebase dispatch is at `:563`. Validation fixes dispatch at `workflows/validation-fix.ts:311,354`; conflict task dispatch is at `sessions/conflict-resolution.ts:494–550`.

The audit's exact Claude×Codex pairing statement is too restrictive: current `workflows/collaboration/backend-pair.ts:10,44` allows same-backend lanes and uses the pair for its default suggestion. Cursor is still excluded by the current eligibility/schema boundary. #111 should reuse that boundary without changing supported pairs.

## Quick Ticket and configuration

Enrichment currently uses `defaultAgentBackend`, independently of the originating conversation. It is scheduled only when diagnostics are present and auto-start was not requested (`create-attachment-planner.ts:265–285`). Initial persistence and attachment capture have their own useful outcome.

There is already an appropriate response path: `CreateAttachmentPlan.warnings` → `tickets/service.ts:284` → `tickets/route-handlers.ts:401` → `QuickTicketDialog.tsx:873`. Add a typed enrichment-unavailable warning and skip the optional stage. Capture the resolved backend and complete model selection for the admitted job so a later config read cannot silently change its provider.

Naming and compaction settings accept any canonical backend in server schemas. Their disabled UI choices do not protect API writes or manually edited configuration. Validate operation eligibility independently from model validity. Keep unsupported stored values visible for correction; do not rewrite them or make all configuration reads fail because one auxiliary operation is unavailable.

Session naming currently calls Claude directly (`sessions/service.ts:472`). Routing that operation through a configurable backend belongs to #116. It should still pass through the shared admission boundary as a Claude task.

## Fork semantics

The service already distinguishes two operations:

- A user message at index zero starts over with a fresh profile and no provider continuity (`conversations/service.ts:508–532`). Preserve it for Cursor.
- An assistant message or later user message derives context from an existing conversation. Cursor cannot currently provide that context.

The second path copies a transcript and stores a provisional conversation before asking the adapter to fork. The unsupported result is logged but finalized as success. Existing tests explicitly expect this (`conversations/service.test.ts:1483`, `agent-backends/consumer-locality.test.ts:946`); they establish the current defect, not the desired contract.

The API's existing validation failures are 400 and creation failures are 422 (`conversations/fork-route-handlers.ts:74`). The pane and peek surfaces converge on `src/components/conversation/MessageRow.tsx:270`, which already has backend, role and index. This is the shared presentation boundary for the same distinction.

## Execution policy and instruction fidelity

Instruction delivery differs by facet, including within Codex:

| Backend/facet | Current instruction transport | Exact filesystem declaration | Current policy to preserve |
| --- | --- | --- | --- |
| Claude conversation | SDK `systemPrompt.append` (`claude/query-session.ts:247,500`) | Enforced | Ordinary and governed conversation roles |
| Claude task | SDK `systemPrompt.append` (`claude/task-runner.ts:368,470`) | Enforced | Nongoverned and governed tasks |
| Codex conversation | Fenced instructions in first user input (`codex/conversation-runtime.ts:752–780`) | Enforced | Existing ordinary and governed conversation roles, at their current instruction fidelity |
| Codex task | `developer_instructions` (`codex/task-runner.ts:188–201,619–631`) | Enforced | Nongoverned and governed tasks |
| Cursor conversation | Fenced instructions in first user input (`cursor/conversation-runtime.ts:1029–1038`) | Unsupported | Ordinary conversations only |
| Cursor task | No facet | No runner | No task eligibility |

This prevents a tempting but incorrect design: requiring a privileged conversation channel for every existing governed role would disable Codex implementers, violating #111's preservation criterion. Conversely, declaring Codex conversations privileged would contradict their actual implementation.

The design therefore separates explicit role-admission policy from transport guarantees. Existing Codex conversation eligibility remains explicit policy at its present fidelity. A request that specifically requires privileged delivery must still be refused there. Cursor gains no governed admission through this ticket; #117's two evidence gates remain prerequisites to changing its policy. No provider-name exception or compatibility field is needed in the evaluator.

Task execution profiles remain `standard` and `isolated-one-shot` (`agent-backends/task.ts:15`). Isolation describes launch semantics, not authority. A schema-repair turn uses an isolated one-shot but must retain the original governing class and write policy (`agent-call-facade.ts:250–284,615–636`).

Agent profile library `readOnly` protects the profile record from editing (`agent-profiles/library-service.ts:225–229`); it is not a filesystem restriction on the agent. Profile text, `recommendedFor`, the autonomous flag and nonempty instructions must not be used to infer role authority. Concrete workflow validator/ownership policies come from trusted orchestration.

## Cursor provider boundary

The installed package is physically within this worktree. Its public declarations were inspected without traversing other worktrees:

- `node_modules/@cursor/sdk/dist/esm/options.d.ts:63–65` exposes sandbox enablement as a boolean, with no exact allow/deny path envelope.
- Main-loop tool controls do not constrain subagent toolsets (`options.d.ts:282–290,311–318`).
- Public agent methods expose create/resume/send; no fork is declared (`dist/esm/stubs.d.ts:40–57`).
- `AgentOptions` exposes no top-level privileged system/developer instruction field on this installed version.

These facts justify conservative refusal. They do not prove that every possible SDK extension or transport is incapable of supplying the mechanisms. That feasibility and authenticated adversarial verification belongs to #117 and the relevant parity children.

Cursor fresh and resumed conversations both enter `createRuntime`; a persisted ref only selects the later attachment mode. Check `fsWritePolicy !== undefined`, including an empty allowlist, before creating transport dependencies. Add the same pure assertion at the constructor boundary for direct callers. A send-only check would violate the neutral runtime-creation contract.

## Validation performed

Executed the registered focused baseline command:

```sh
cctl validate run test --queue-if-busy -- src/lib/agent-backends/facet-gating.test.ts src/lib/commands/backend-command-catalog.test.ts src/lib/conversations/service.test.ts
```

Result: **passed, three files**, run `vrun-71f0f748-ce64-4cc1-916f-9c40fd944dc5`.

Both authored documents passed local link-existence and whitespace checks. The registered formatter refused file-scoped invocation because its `pathArgs` is `forbid`; its changed-scope script writes every selected changed file, so it was not run broadly over the pre-existing audit and branch work.

This confirms the researched baseline can run; it does not test the proposed behavior. No new behavior tests or application fixes were authored, and no authenticated provider, browser, billing or confinement acceptance was executed. The design specifies the failing reproductions and live acceptance required during implementation.

## Remaining limits

- #111 does not need a provider research spike to refuse an unsupported operation.
- Existing Codex conversation instruction fidelity is a material limitation to disclose, not silently repair within this Cursor ticket.
- A capability declaration remains an adapter claim that needs conformance and live evidence. Unit tests using a limited descriptor prove admission logic, not vendor enforcement.
- This baseline report does not claim implementation completion; the linked validation report records the subsequent delivery work.
