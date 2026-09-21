# Agent Backends

Claude, Codex, and future providers vary behind one registered composition boundary. Provider identity is data at the edge, not a reason for feature code to grow parallel pipelines.

## Canonical boundary

- `src/lib/agent-backends/descriptor.ts` defines the registered descriptor and its metadata, conversation, task, MCP, and failure-classification facets.
- `registry-core.ts` owns registration and lookup; `registry.ts` bootstraps production descriptors. Neutral consumers import the registry surface, never a provider implementation.
- `conversation.ts` and `task.ts` define the execution ports. Workflow code normally composes them through AgentCall (`src/lib/workflows/primitives/agent-call-facade.ts`).
- `AgentSessionRef` is the opaque continuity handle: `{ backend, ref }`. Outside the owning adapter, never parse `ref`, infer semantics from its shape, or store a provider-specific session/thread field.
- Capability descriptors answer whether and when behavior is supported. Do not branch on `backend === "claude" | "codex"` when a capability, task profile, normalized result, or registered policy can own the decision.

## Managed skills

Command Center's own skills (the bundled `plugins/command-center` plugin) are host environment, not user capabilities: they are published at startup as an immutable content-addressed bundle (`src/lib/managed-skills/`) and attached to every normal launch below the seam. Every descriptor declares `managedSkills` per execution facet (`bundled` or an explicit `hermetic`); a backend cannot register without deciding. Delivery is adapter-owned: Claude attaches the published bundle as an SDK-local plugin (suppressing a non-equivalent user-installed copy via the flag layer only); Codex reconciles one `info/exclude`-hidden `.agents/skills/command-center` link in the launch checkout before each turn (`codex/managed-skills-bridge.ts`) because the exec transport has no skill-root injection — replace the bridge with native process-scoped roots if that changes. Isolated one-shot profiles stay hermetic. Managed skills never enter the user capability cascade and never write backend-owned user configuration.

## Native provider memory

Command Center's memory library replaces the provider's own memory, so every descriptor declares `nativeMemory` (`src/lib/agent-backends/native-memory.ts`) in one of two states and cannot register without deciding: `disabled` with the lever it pulls, applied in every CC-launched environment for that backend, or `none` with the reason no lever exists. There is no third state — "the prompt asks it not to" is not a mechanism. Adapters own the disable (Claude on the SDK `Settings` layer, Codex in the `memories` config table); a new launch path for either backend applies that backend's shared constant, because the claim covers every environment. CC runs on unmanaged hosts; Claude checks its shared flag-tier memory settings once per server process and refuses launches if those flags are unreadable. A `none` declaration is disclosed on both operator surfaces — the `cctl memory index` stderr header and the Memory Library — from the declaration itself, never from a hardcoded backend name.

## Ownership rules

Provider adapters own:

- SDK construction, environment, permission/sandbox translation, and native tool configuration
- native frame interpretation and lossless transcript envelopes
- continuity validation, resume/recovery/fork behavior, and stale-reference classification
- provider-specific failure classification and `ContinuationDisposition`
- structured-output transport and provider-native enforcement

Neutral callers own:

- domain intent, semantic task profile, timeout, cancellation, and portable inputs
- **declaring conversation scope**: `ConversationBackendCreateInput.conversationTarget`
  is a `ConversationTarget`, so the caller states whether this is a session or a
  project conversation. A runtime passes it to `buildSessionEnvContract` and never
  re-derives scope from a session name, the `__project__` sentinel, or a worktree
  path — see the conversation scope contract in `CONTEXT.md`.
- post-parse domain validation and state transitions
- behavior selected from declared capabilities rather than provider identity

Raw provider payloads may cross the seam only inside the lossless transcript envelope. Code above the seam records the envelope without reading or branching on its `raw` payload.

## Provider-billed cost

A turn result carries the cost attributed to THAT turn (`costUsd`) and, for providers with cumulative counters, the lineage cumulative (`cumulativeCostUsd`). Cost the provider settles outside a turn result — late billing, a pending settlement reconciled on resume, or agent-level cost no turn owns — reaches the conversation through `ConversationBackendCreateInput.onCostSettled`, which `src/lib/conversations/cost-settlement.ts` folds into the hosted actor (machine event `COST_SETTLED`) or the row, the transcript (`cost_settlement` frame) and the `conversation-usage-updated` SSE event. The adapter owns exactly-once reporting; Cursor keeps a durable per-conversation billing ledger (`cursor/billing-ledger.ts`) because its provider never ties a billing entry to the run that produced it, so per-turn attribution is an inference the ledger states honestly, and an account without the usage API keeps cost unknown rather than estimated.

## Structured output

Structured callers use AgentCall with the authoritative `outputSchema` and an
optional `structuredOutputTurns: "work_then_format" | "single"`. The default is
`work_then_format`: schema-free prose work, a format turn on the same session,
one format repair with named gate issues if necessary, then a refusal.

- `agent-call-facade.ts` owns the sequence, gate, repair, and result aggregation.
  No caller extracts a facade result again: domains apply Zod `safeParse` to its
  structured payload and own semantic guards. A domain correction is one
  conditional call, with its latest continuation and `single` mode.
- Schemas belong only to turns. Runtime creation, runtime configuration and
  recreation decisions carry no output schema. Claude, Codex, and Cursor use
  `post_validation`; adapters append the shared instruction from
  `structured-output-prompt.ts` and do not send provider-native schema fields.
- Format and repair turns retain session identity, working directory, governing
  instructions, and write policy. They omit new per-turn tooling, context, and
  images and instruct the model not to run tools. They never reconstruct work
  in a fresh context from the rejected text alone.
- Task formatting resumes the immediately preceding turn's `backendRef`.
  Missing or cleared continuation refuses two-turn completion. Isolated
  one-shots must use `single` and never repair. Failed or cancelled work and
  question-ending conversation turns do not dispatch a format turn.
- The shared extractor tries native output, raw response JSON, then the last
  fenced JSON block. The facade gates every candidate against the authored
  schema; the first passing candidate wins. Domain Zod remains authoritative.
- Results retain work artifacts and ordered transcripts, use the last turn's
  payload and continuity, sum usage counters, and retain the latest snapshots.
  A refusal exposes the last rejected content and gate issues.
- `single` is explicit for naming/enrichment, ticket/commit payloads, D2 output
  capture, and the one domain correction call compaction, checkpoint working
  state, and advisory response make on their latest continuation. Every other
  structured caller, including validators, advisory response, plan repair,
  debug phases, compaction, and checkpoint working state, runs the default
  protocol; the actor's pending-question fact is checked before formatting.
- Checkpoint handoff capture remains the deliberate exception to the facade:
  its capture-window path shares the prompt builder and validates text through
  `validateStructuredOutput`, without repair.

Keep transport below the backend seam; select behavior from declared
capabilities rather than provider identity.

## Model selection

Every backend descriptor exposes a model-catalog facet, and conversation factories validate complete atomic selections against the project-effective catalog:

- `modelCatalog.getCatalog({ projectPath, configuredSelection })` returns complete model definitions, parameter definitions, exact valid variants, provenance, and one atomic default.
- `validateModelSelection` accepts a whole `{ modelId, parameters }` value and returns the canonical complete selection. Cursor applies `CommandCenter.json`'s `agentBackends.cursor.disabledModels` — an opt-out, so every generated model is available unless the project names it — while resolving its effective catalog. A configured default the project disabled remains an invalid applied selection and is never substituted, but the filtered catalog stays available so an explicit complete available selection can recover.

`GET /api/projects/[name]/model-options` projects every descriptor's effective catalog, atomic default, provenance, and diagnostics. Conversation-creation surfaces render those definitions directly. A selection outside the projection remains visible with a diagnostic and blocks submission; it is never substituted.

Neutral callers carry complete selections and do not interpret provider parameter names or branch on backend identity.

## Adding or extending a backend

1. Add or extend a descriptor and the required facets under that provider's adapter directory, including the `nativeMemory` declaration.
2. Declare capability and application-timing differences in descriptor data.
3. Normalize failures and continuation disposition inside the adapter.
4. Preserve native transcript bytes in the lossless envelope; expose only neutral operational events/results above it.
5. Extend the parameterized conformance, consumer-locality, transcript-boundary, and capability-specific structured-output transport tests.
6. Run the registered `seams` and `typecheck` validators through `cctl validate run`; a new provider must not require identity branches or deep provider imports in neutral consumers.

Product policy may intentionally name a provider only at an explicit selection/pairing site. Mark such a survivor in the seam catalog with its policy reason and deletion condition; do not use it as precedent for domain branching.
