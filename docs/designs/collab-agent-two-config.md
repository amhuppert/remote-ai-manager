# Collaboration Mode: Agent 2 configuration and agent profiles

Design for making Agent 2 in Collaboration Mode fully configurable at start —
backend (Claude or Codex, including the same backend as Agent 1), model,
reasoning effort, Codex fast mode — and for staffing Agent 2 with an agent
profile from the library. Agent 1 continues to run on the conversation's own
settings, exactly as today.

## Current state (verified against this branch)

- **Init surface.** `/collab <brief>` renders `CollabConfigRow`
  (`src/components/session/CollabConfigRow.tsx`) above the composer. It exposes
  rounds and auto-resolve threshold; "1st agent" and "2nd agent" are read-only
  ("Second agent is fixed to X for now"). Draft state is in-memory zustand
  (`src/stores/collaboration.store.ts`, default `secondAgent: "codex"`).
- **Start payload.** `collaborationStartRequestSchema`
  (`src/lib/workflows/collaboration/manager.ts:205-225`) carries `backend`,
  `modelId`, `effort`, `codexFastMode` — all Agent 1 only. Agent 2 (the
  opposite backend) always runs on global config defaults
  (`resolveCollaborationBackendModelConfig`). Three payload paths converge on
  `manager.start`: the collaboration route, the prompt route's `collab`
  sub-object (`src/lib/prompt/schemas.ts:17-24`), and the session-scope
  `/collab` branch in `sdk-driver.ts`.
- **Pairing is hardcoded.** `COLLABORATION_BACKEND_PAIR = ["claude","codex"]`
  and `oppositeCollaborationBackend()`
  (`src/lib/workflows/collaboration/backend-pair.ts`). Agent 2's backend is
  *derived*, never stored, at six sites (`envelope.ts:302`,
  `workflow-collaborator-caller.ts:176`, `use-collab-context.ts:144-158`,
  `UnifiedComposer.tsx:545`, `CollabPassage.tsx:113-114`,
  `collab-pending.ts:63-64`).
- **Lane identity = backend name.** `laneId === backend`
  (`backend-pair.ts:74-87`, `helpers.ts:214`), lane rows keyed
  `workflowId + NUL + laneId` in `sessions.workflow_lanes`. Model settings are
  keyed by backend too: `collaborationAgentModelSettingsMapSchema =
  { claude: {model, effort}, codex: {model, effort} }`
  (`src/lib/workflows/collaboration/types.ts:75-89`), and `buildCallAgent`
  takes flat `claudeModel/codexModel/...` slots (`manager.ts:1256-1276`),
  dispatched by `resolveLaneDefaults(input, backend)`
  (`agent-caller-production.ts:186-217`). **Two same-backend lanes would
  collide into one lane record and share one continuity ref.**
- **Request kind is a backend property.** Claude lane → `conversation_turn`
  (fresh synthetic conversation `collab-${workflowId}-${newId()}` per call);
  Codex lane → `task_run` (`helpers.ts:229-250`).
- **Fast mode already exists end to end** as a Codex-only boolean:
  `codexConfigSchema.fastMode`, capability predicate
  `backendSupportsFastMode(backend) => backend === "codex"`
  (`catalog.ts:405-407`, a documented provider-name survivor), wire effect
  `service_tier: "fast"` + `features.fast_mode`
  (`codex/fast-mode-config.ts`), UI control `CodexSpeedToggle`.
- **Agent profiles are delivered** (`src/lib/agent-profiles/`): prompt identity
  only ({tier, id} refs, no runtime/policy), fail-closed resolution, snapshot
  persisted at assignment (`buildAgentProfileSnapshot` →
  `renderedInstructionBlock` + hashes, replayed byte-for-byte), default
  `builtin:standard-agent` whose empty block is dropped by the instruction
  channel. `resolveConversationProfileSnapshot`
  (`src/lib/conversations/profile-resolution.ts`) is the single resolution
  entry point for creation sites; `AgentProfilePicker`
  (`src/components/agent-profiles/AgentProfilePicker.tsx`) is the one picker
  every surface renders.
- **The instruction channel to both lanes already exists.** `callPrimitive`
  (`helpers.ts:209-250`) threads `systemInstructions` (built from
  `sessionContext`) into both request kinds; the Claude path maps it to
  `sessionInstructions` at runtime creation
  (`agent-caller-production.ts:335-359`), the Codex task port has
  `systemInstructions?: string[]` (`task.ts:75`). The profile composer's
  contract ("one entry appended to the backend-neutral session-instruction
  channel") plugs straight in.
- **Persistence.** Collab config lives in the workflow envelope
  `featureSnapshot` (`envelope.ts:730-762`) in the `sessions.workflow_envelopes`
  JSON column; the user-origin snapshot variant is `.passthrough()`
  (`feature-snapshot.ts:38-49`), i.e. today's `agentModelSettings` is untyped.
  Round-trip backstops:
  `default-session-workflow-envelope-store-integration.test.ts:165-235`
  (maximal snapshot), `sessions-repo.contract.test.ts:388-496`,
  `persisted-blob-bounds.contract.test.ts`.

## Design

### D1 — Request shape: an explicit `agentTwo` block

Add to `collaborationStartRequestSchema` (and mirror in the prompt route's
`collab` sub-object and the sdk-driver session-scope path — all three converge
on `manager.start`, which stays the single resolution point):

```ts
agentTwo: z.discriminatedUnion("backend", [
  z.object({
    backend: z.literal("claude"),
    model: claudeModelSchema.optional(),
    reasoningEffort: claudeEffortLevelSchema.optional(),
    profile: agentProfileRefSchema.optional(),
  }),
  z.object({
    backend: z.literal("codex"),
    model: codexModelSchema.optional(),
    reasoningEffort: codexReasoningEffortSchema.optional(),
    fastMode: z.boolean().optional(),
    profile: agentProfileRefSchema.optional(),
  }),
]).optional()
```

- The discriminated union makes model↔backend mismatches unrepresentable at
  parse (same pattern as `graphWorkflowAgentConfigSchema`,
  `src/lib/workflow-graph/config-schemas.ts:25-48`). `fastMode` exists only on
  the codex branch, so "fast mode for Claude" is a 400 by construction.
- `agentTwo` absent ⇒ exactly today's behavior (opposite backend, global
  config defaults, standard-agent profile). CLI/SSE `/collab` keeps working
  unchanged.
- Agent 1's fields stay top-level (`backend`/`modelId`/`effort`/
  `codexFastMode`) — they are the conversation's settings and double as the
  transcript stamp; no change.

### D2 — Server-side resolution to concrete per-agent configs

At `manager.start`, resolve BOTH agents to fully concrete configs before
anything runs (a lane must never reach the SDK without a model — the
"$ must be object" incident class):

- Ladder per field: explicit request value → global `agentBackends[backend]`
  config default (`resolveConfiguredAgentBackendDefaults`) → catalog default.
- Effort clamped by `resolveModelValidEffort` semantics; `fastMode` forced
  absent unless `backendSupportsFastMode(backend)`.
- Run `factory.validateModelAndEffort` for both agents (parity with
  `sdk-driver.ts:874-895`).
- Resolve Agent 2's profile ref **fail-closed before the envelope is created**
  via `resolveConversationProfileSnapshot(projectPath, ref)` — unknown/deleted/
  quarantined ref ⇒ typed 400, nothing persisted (matches conversation
  admission semantics).
- Log resolved per-agent settings on the existing `collaboration.manager.start`
  event: backend/model/effort/fastMode + profile `{tier, id, revision,
  resolvedInstructionHash}`. Never the instruction contents.

Resolved shape (persisted; replaces the backend-keyed map):

```ts
collaborationResolvedAgentSchema = z.object({
  backend: agentBackendSchema,
  model: z.string().min(1),          // always concrete
  effort: z.string().optional(),     // absent = model has no effort axis
  fastMode: z.boolean().optional(),  // codex lanes only
  profileSnapshot: agentProfileSnapshotSchema.optional(),
});
// featureSnapshot.agents: { agent_one: ..., agent_two: ... }
```

### D3 — Lane identity re-keyed by flow agent (the deep change)

`laneId` becomes the flow-agent id (`agent_one` | `agent_two`) instead of the
backend name. This is what makes same-backend pairs sound: today two claude
lanes would merge into one lane row and share a continuity ref (Agent 2 would
literally resume Agent 1's session).

- `callPrimitive` already receives `flowAgent` in its context (`helpers.ts:190`)
  — `laneRef` becomes `{ workflowId, laneId: ctx.flowAgent }`.
- `buildCollaborationLaneSeeds` seeds `agent_one`/`agent_two` with each lane's
  resolved backend recorded on the lane row.
- `buildCallAgent` input: replace the flat `claudeModel/codexModel/...` slots
  with `agents: { agent_one: ResolvedAgent, agent_two: ResolvedAgent }`;
  `resolveLaneDefaults(input, flowAgent)` dispatches on flow agent and reads
  the backend from the resolved config. Timeout/stall-timeout stay
  backend-derived from global config, resolved into each agent's struct at
  start.
- Request kind stays a backend property (`claude → conversation_turn`,
  `codex → task_run`), evaluated per lane from that lane's resolved backend.
  Claude+Claude ⇒ two conversation runtimes with distinct synthetic
  conversation ids (already unique per call, `agent-caller-production.ts:317`);
  Codex+Codex ⇒ two task_runs. Lane scheduling is unchanged — write-capable
  turns already serialize on the session key
  (`scheduling-single-owner.test.ts`).
- **Migration (next state-store slot, 0014 at time of writing):** re-key
  existing collab lane rows whose `laneId` is `claude`/`codex` →
  `agent_one`/`agent_two`, mapping via the owning envelope's
  `primaryAgentBackend` (primary backend's lane = `agent_one`). Only collab
  lanes use bare backend names as lane ids, so the predicate is exact; a lane
  row with no owning envelope is dead and dropped. One-time migration, no
  ongoing shim. Graph-workflow collab lanes (same machinery via
  `workflow-collaborator-caller.ts`) are covered by the same predicate.

### D4 — Persistence: typed `agents` map in the feature snapshot

- Write the resolved per-agent map (D2 shape) as `featureSnapshot.agents`,
  **typed** in `feature-snapshot.ts` rather than grown through the
  `.passthrough()` blob. `agentModelSettings`, `primaryBackend`,
  `secondaryBackend` stop being written; `primaryAgentBackend` remains (it
  names Agent 1 = the conversation's backend).
- Agent 2's full `AgentProfileSnapshot` is persisted inside its entry —
  full, not redacted, because restart must replay `renderedInstructionBlock`
  byte-for-byte (same reason conversations store the full snapshot). The
  envelope already carries instruction-grade content to the client
  (`sessionContext` = charter + ticket view), so this adds no new exposure
  class; the envelope adapter surfaces only `{tier, id, name, revision}` to UI
  props.
- Legacy read: `envelope-adapter.ts` already `safeParse`s and degrades for
  pre-existing runs. Add a display-only decode of the old
  `{claude, codex}`-keyed `agentModelSettings` (mapped through
  `primaryAgentBackend`) so old collab passages keep their model/effort meta
  line. Scoped to the adapter; needs Alex's shim approval — the alternative is
  old passages losing that meta line.
- Extend the maximal round-trip fixture in
  `default-session-workflow-envelope-store-integration.test.ts`, the
  sessions-repo contract test, and the persisted-blob-bounds declaration.

### D5 — Profile staffing for Agent 2

- Resolution at start via `resolveConversationProfileSnapshot` (D2). Default
  `builtin:standard-agent` — a qualified ref, never a nullable "no profile"
  (R7 of the profile spec). Its empty block composes to nothing and the
  instruction channel drops empty entries, so the default is a true no-op.
- Delivery: append `agents.agent_two.profileSnapshot.renderedInstructionBlock`
  as one additional entry in the lane's `systemInstructions` in
  `callPrimitive`, for `flowAgent === "agent_two"` only. Both backends already
  transport this channel (Claude `sessionInstructions` at runtime creation,
  Codex task `systemInstructions`); backend-specific rendering stays below the
  seam. No new transport.
- Immutability: collab config has no post-start edit surface, so the snapshot
  is fixed at start by construction — no `profileLockedAt` analog needed.
  Library edits/deletes never touch a running collab (snapshot semantics), and
  collab snapshots are exempt from deletion blocking exactly like conversation
  snapshots.
- Provenance: profile identity (`tier:id@revision` + hashes) in the start log
  event and in the envelope; the UI shows the profile name on Agent 2's cards.

### D6 — Agent 1 semantics (unchanged, plus one decision)

Agent 1 keeps deriving from the conversation: backend = the conversation's
(adopted/locked) `agentBackend`; model/effort/codexFastMode = the composer
selection sent top-level with the start request, falling back to global config
(existing behavior). The config row shows this read-only.

**Decision (recommended: yes):** carry the originating conversation's stored
`profileSnapshot.renderedInstructionBlock` into Agent 1's lane instructions,
verbatim (fork-inherits-snapshot semantics). Today the collab Claude lane runs
in a fresh synthetic conversation and silently drops the conversation's
profile — arguably a latent gap: a conversation staffed as `project:reviewer`
collaborates as nobody. The delivery channel is the same one D5 builds. If
declined, Agent 1 lanes simply stay profile-less as today.

### D7 — Same-backend pairs

- `COLLABORATION_BACKEND_PAIR` / `oppositeCollaborationBackend` stop being
  derivation authority and survive only as the *default suggestion* (UI
  pre-selects the opposite backend). All six derivation sites take the
  explicit Agent 2 backend from config/draft/envelope instead.
- `backend-pair.test.ts` assertions that pin `laneId === backend` and the
  opposite-only pairing are rewritten to pin the new contract (flow-agent lane
  ids; pair = default suggestion only).
- Graph-workflow collab (`workflow-collaborator-caller.ts`) keeps its current
  semantics — agent_two configured, agent_one = opposite — as that caller's
  own policy; it adapts to the per-agent plumbing without behavior change.
  Extending `workflowCollaborationConfigSchema` with fastMode/profile is a
  follow-up, not in scope.
- Display with identical backends: keep backend tone tokens (cyan/violet are
  backend-semantic across CC); disambiguation comes from the existing
  "Agent 1/2" labels plus a richer meta line (D8). Role-recoloring the cards
  is the alternative if Alex prefers stronger visual separation.

### D8 — UI

`CollabConfigRow` grows a second line; controls are all existing components:

- **Line 1 (unchanged frame):** `/collab` chip · **1st agent** read-only
  summary — backend · model · effort (· fast) chips mirroring the live composer
  selection, captioned "uses this conversation's settings" · Rounds ·
  Auto-resolve · dismiss.
- **Line 2 — 2nd agent:** backend `SegmentedControl`/`BackendToggle`
  (default: opposite of Agent 1) · `AgentProfilePicker`
  (`audience="conversation"`, default standard-agent) · `ModelSelector` ·
  `ReasoningLevelSelector` (options from `useBackendCatalogQuery` for the
  chosen backend) · `CodexSpeedToggle` (rendered only when
  `backendSupportsFastMode(backend)`).
- Backend switch resets model/effort/fastMode to that backend's defaults
  (mirrors `use-backend-model-effort` behavior).
- Defaults: extend the server-component-provided defaults to a per-backend map
  (`resolveConfiguredBackendSelectionDefaults` → per-backend variant threaded
  as a prop) so Agent 2 seeds from global config defaults exactly like the
  composer does, rather than hardcoded catalog defaults.
- Draft store: `collaboration.store.ts` draft becomes
  `{ agentTwo: { backend, model, effort, fastMode, profile }, negotiationRounds,
  autonomousResolutionThreshold }`, still in-memory per conversation key; the
  default derives from the originating backend at first open (the current
  hardcoded `secondAgent: "codex"` is wrong for codex-originated conversations
  and only papered over by the client coercion).
- `collab-pending.ts` and `CollabPassage`/`CollabAgentModelMeta` read the
  per-agent settings; the meta line becomes
  `backend · model · effort [· fast] [· profile-name]`.
- Project scope: `/collab` remains unsupported
  (`ProjectCollaborationUnsupportedError`); `UnifiedComposer`'s hardcoded
  opposite-backend stub follows the new draft shape with no behavior change.

## Testing plan (red-green order)

1. **Schemas:** `agentTwo` union — model/backend mismatch fails parse; fastMode
   rejected on the claude branch; profile ref parse; absent `agentTwo` ⇒ valid.
2. **Manager resolution:** explicit → config default → catalog ladder per
   agent; effort clamping; fastMode capability gating; concrete model
   guaranteed for both lanes; profile resolution fail-closed (unknown ref ⇒
   typed error, no envelope row); extend
   `manager.test.ts` "threads both lanes' effective model settings".
3. **Lane identity:** same-backend start seeds two distinct lane rows with
   isolated continuity refs; request kind per lane backend
   (`agent-caller-production` unit); `backend-pair.test.ts` rewritten.
4. **Migration 0014:** persistence fixture (`createPersistenceFixture`) with
   legacy backend-keyed lane rows + envelope → re-keyed rows, orphans dropped,
   reload through the repository.
5. **Envelope round-trip:** maximal snapshot fixture gains `agents` incl. full
   profile snapshot; sessions-repo contract; blob-bounds declaration;
   `feature-snapshot.test.ts` user-shape preservation.
6. **Profile delivery:** `callPrimitive` appends agent_two's block as one
   instruction entry on both request kinds; standard-agent appends nothing;
   restart replays the stored block byte-for-byte (persistence fixture).
7. **UI:** CollabConfigRow stories + RTL tests (backend switch resets model;
   speed toggle only for codex; picker defaults; read-only Agent 1 mirrors
   composer); envelope-adapter legacy decode; CollabPassage per-agent meta.
8. **Live proof** (`cc-live-feature-test`): (a) Claude+Claude with a global
   profile on Agent 2 — verify two lanes, isolated continuity, profile block in
   the lane transcript; (b) Agent 2 = Codex with fast mode — verify
   `service_tier: "fast"` reaches the Codex config.

## Non-goals

- N > 2 agents; changes to negotiation protocol, rounds, thresholds, or
  artifacts.
- Making Agent 1 configurable beyond the conversation's settings.
- Graph-workflow collab config UI for fastMode/profile (follow-up).
- Persisting the config-row draft across reloads (stays in-memory, as today).
- Project-scope `/collab`.

## Decisions for Alex

1. **Lane-key migration** (D3) vs accepting continuity loss for in-flight
   collabs at upgrade — recommend the migration; no ongoing shim.
2. **Agent 1 inherits the conversation's profile snapshot** (D6) — recommend
   yes.
3. **Full profile snapshot in the envelope** (client-visible, like
   `sessionContext`) vs adding a redaction projection — recommend full snapshot,
   adapter exposes identity fields only.
4. **Legacy `agentModelSettings` display decode** in envelope-adapter — needs
   explicit shim approval; recommend yes (display-only, single site).
5. **Same-tone cards for same-backend pairs** (backend tones + labels) vs
   role-keyed recoloring — recommend keeping backend tones.

## Suggested sequencing

1. **Stage 1 — behavior-preserving core:** flow-agent lane re-key + migration +
   per-agent plumbing (`agents` map through manager → buildCallAgent →
   resolveLaneDefaults → envelope) + adapter decode. Opposite-pairing behavior
   identical before/after.
2. **Stage 2 — config surface:** `agentTwo` in all three payload schemas +
   server resolution/validation + CollabConfigRow controls + defaults threading
   + pending card/meta display. Same-backend pairs become reachable.
3. **Stage 3 — profiles:** profile field + fail-closed resolution + snapshot
   persistence + lane instruction delivery + picker + provenance display +
   (if approved) Agent 1 snapshot carriage.

Each stage lands green through `cctl validate run typecheck|lint|test`.
