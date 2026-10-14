# Workflow orchestration

Conversation turns use `conversation-core/`, composed and owned by `supervision/`. Runs use `runs/`, execution contexts use `execution-context/`, and repository operations use `workspace/`. Hosted task calls enter through `runConversationTask` in `supervision/production.ts`; ephemeral calls use the core task lane. These semantic boundaries own admission, cancellation, continuity and durable settlement. Callers do not coordinate backend runtimes themselves.

Merge, commit and rebase remain ephemeral XState job machines under `workflows/`, hosted by `jobs/queue.ts` and `jobs/machine-host.ts`. Their durable record is the job outcome, not a machine snapshot; startup recovery closes orphaned jobs. Every invocation has an error transition. Tests provide actor implementations through `.provide()`, and domain callers use the job APIs rather than sending machine events.

Collaboration remains an imperative composition under `workflows/collaboration/`, with client hooks in `lib/collaboration/`. Its manager composes shared lanes, envelopes and gates. `workflows/primitives/` owns the shared AgentCall facade, lane service, human and structured-output gates, and output-schema predicate evaluation. Keep orchestration private behind these semantic modules.

## Runs

A session conversation owns a run; implementer and reviewer seats belong to its execution contexts. `RunHost.amend` and `runs/amendment.ts` own structural changes to a launched run. Route semantics live in `runs/route-projection.ts`; evaluate authored predicates only through `workflows/primitives/output-schema-subset.ts`. Workspace provisioning and landing go through `workspace/`, with explicit ownership and effect receipts.

The launch settings owner is `runs/settings.ts`. Global, template and context tiers use `config/settings-cascade.ts`: the nearest tier setting a key replaces it whole, absent keys fall through, and provenance names the winning tier. Templates live in `run-templates/`, with project/global storage and `{{inputs.name}}` text parameters; CRUD and preparation enter through its service. Use the shipped `run-planning` skill and `cctl run` help when authoring or operating runs.

Conversation turns and queue recovery run on the core. Persisted graph-role conversations without a run seat binding are read-only history. Role memory policies come from file-only `memory.roles` in `config.json`; ordinary conversations use `memory.conversations`.

## Shared ownership

| Concept | Canonical owner |
|---|---|
| Agent execution and structured output | `workflows/primitives/agent-call-facade.ts`, `agent-backends/structured-output.ts` |
| Conversation attempts and runtime continuity | `conversation-core/`, `supervision/` |
| Runs and amendments | `runs/` |
| Execution contexts and seats | `execution-context/` |
| Git workspaces, ownership and landing | `workspace/` |
| Collaboration envelopes and lanes | `workflows/collaboration/`, `workflows/primitives/` |
| Template storage and launch preparation | `run-templates/service.ts` |
| Agent-profile deletion references | `agent-profiles/library-service.ts` port, `run-templates/profile-references.ts` implementation |
| Registered validation | `validation/` |

Native specs stop at approved requirements and design. They do not own execution plans, delivery gates or merge admission. Run planning and delivery are independent of spec authoring.
