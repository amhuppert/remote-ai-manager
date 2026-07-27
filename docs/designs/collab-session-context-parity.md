# Providing Alignment charter and ticket context to both Collaboration Mode agents

Alex — here is the settled design. Both of your clarifications are folded in: agent_one keeps resuming the conversation's backend session, and the `CcTaskSessionScope` stage is approved.

## The problem, verified in code

A `/collab` run answers a user prompt from an attended session conversation, but neither lane receives the two pieces of governing session context that every ordinary attended turn gets.

**How ordinary turns get them** (`src/lib/workflows/conversation/actor-implementations.ts`):

- The charter is baked into the runtime's session instructions at creation (`resolveAlignmentInstructionForNewRuntime` at `:1210`, composed into `sessionInstructions` at `:1252`), with a version-based recreate gate (R7.3) and post-turn seen-version recording (R8.4).
- The linked ticket's `<active-ticket>` block is prepended to the effective prompt every turn (`buildEffectivePrompt` at `:701`, sourced from `getLiveTicketBlock` → `LiveTicketContextProvider.getForSession`).

**What collaboration does instead:** the production caller passes `sessionInstructions: []` at both runtime creation and dispatch (`agent-caller-production.ts:312`, `:375`), and none of the seven phase prompt builders carries either context. The only charter that ever reaches a lane arrives accidentally, via `priorBackendRef` seeding agent_one's lane from the originating conversation's backend session (`envelope.ts:132-138`). Agent_two — always the opposite backend, always fresh — never sees anything.

Two facts shaped the design and corrected early assumptions:

1. **The Codex lane is not a conversation.** `callPrimitive` (`helpers.ts:211-230`) builds `{kind: "conversation_turn", backend: "claude"}` for the Claude lane and `{kind: "task_run", backend: "codex"}` for the Codex lane. Any mechanism that only understands conversation runtimes covers half the problem.
2. **The Codex task lane has no CC identity.** `codex/task-runner.ts:345-350` deliberately runs `neutralizeAmbientCcEnv` over the child env. The recent `ccScopeConversationId` → `CC_CONVERSATION_ID` fix landed in the *conversation runtimes*, which the standalone Codex lane never uses — so the ticket block's `cctl` retrieval commands cannot execute there today.

## Design

### 1. One snapshot, captured once

New module `src/lib/workflows/collaboration/session-context.ts` owns the concept:

```ts
interface CollaborationSessionContext {
  alignment: {
    version: number;
    contentHash: string;
    text: string;          // canonical getActiveInjection() instruction
    snapshotPath?: string; // digest mode only; see §5
  } | null;
  activeTicketBlock: string | null;
}
```

It owns the Zod schema and derived type, the empty projection, pure composition helpers, and the strict resume parser. The manager gains an injectable `resolveSessionContext(...)` dep whose production impl composes the two canonical sources — `SessionAlignmentService.getActiveInjection()` and `getLiveTicketContextProvider().getForSession()`. No second renderer for either; no `/align` nudge (it asks the agent to suggest a slash command to a user it cannot address mid-run).

**Timing and failure policy.** Resolve after the session and conversation validate, *before* `persistStart` claims the conversation:

- Charter read failure is fatal and fails closed — nothing is claimed, no prompt count moves, neither lane dispatches. The charter is governing context; running without it silently is the failure mode worth preventing.
- No active charter is valid → `alignment: null`.
- Ticket read failure logs a warning and continues with `activeTicketBlock: null`, matching the ordinary-turn policy.
- Unlinked session is valid → `activeTicketBlock: null`.

### 2. Eligibility as a first-class governance case

Rather than calling the ordinary-turn predicate with `autonomous: false` — which asserts something false about the lanes' actual execution mode — the Alignment gate module gains a tagged union:

```ts
type AlignmentGovernanceContext =
  | { kind: "conversation_turn"; creationMode; isProjectConversation; autonomous }
  | { kind: "standalone_collaboration"; creationMode; userInitiated: true };
```

`isAlignmentEligibleContext()` remains the single policy owner. The `conversation_turn` arm delegates to today's R12 predicate, so existing behavior and tests are untouched. The `standalone_collaboration` arm returns eligible only for a user-initiated normal session. The Alignment requirements are updated first to state that a standalone collaboration run is one attended logical originating turn whose internal backend calls remain autonomous — which also keeps graph workflows structurally excluded rather than excluded by call-site folklore. Ticket lookup stays ungated, exactly as in the ordinary path.

### 3. Semantic channels, one injection seam

Each context travels in the channel that matches its authority, mirroring ordinary turns:

- **Charter → governing system/session instructions.** Not prompt text: demoting it to ordinary prompt content weakens its precedence over everything else in the turn.
- **Ticket block → transient prefix on substantive work prompts.** It is task context that changes as attachments change; it must never be baked into a runtime.

To express both uniformly across transports, move `systemInstructions` from the `task_run`-only arm of `AgentCallRequest` (`agent-call-vocabulary.ts:109`) into the shared base fields. Then `callPrimitive()` — the single request-composition seam every standalone phase already routes through — decorates each request: set `systemInstructions` from `alignment.text`, prefix `prompt` with the ticket block, and leave requests byte-identical when both are null. The seven prompt builders and the graph-workflow collaborator stay context-free.

The production caller maps semantic intent to transport: `sessionInstructions: [text]` for the Claude conversation runtime, existing `systemInstructions` mapping for the Codex task run. The two-turn structured-output wrapper needs no new code — the format turn is built by spreading the work request and replacing `prompt`, so it keeps the charter and naturally drops the ticket prefix — but that behavior gets a pinning test.

We deliberately do **not** pass `alignmentVersion` into runtime creation here: collaboration creates and closes a runtime per call, so the recreate gate it feeds can never fire. Version and hash live in the durable snapshot for audit and seen-version state instead.

### 4. Durability and resume

`CollaborationSessionContext` is a **required** field on `AsymmetricCollaborationSliceInput`, so any new caller must make an explicit context decision. `initializeEnvelope()` (`envelope.ts:656`) persists the exact snapshot, and both resume paths — ask-user resume and process-restart recovery — parse the persisted field and reuse it verbatim. Live re-resolution is never performed: a run, including its pause, is one logical turn, and refreshing only for agent_one's post-resume final answer would give the peers different premises.

Storage parsing stays permissive (`sessionContext` as an explicit optional field on the user-origin feature-snapshot variant, so historical envelopes still display and round-trip), while *execution* is strict: an absent or malformed snapshot produces a typed, actionable restart error before the envelope is marked running and before either lane dispatches. Pre-change paused envelopes cannot prove what either peer saw — and because agent_one may have inherited context through `priorBackendRef`, substituting an empty projection would fabricate premises rather than reproduce them. If you later want legacy best-effort resume, that is an explicit, tested compatibility policy for you to approve, not a silent default.

Per the persisted-field rule, this also extends the session-workflow-envelope store's maximal round-trip contract fixture with a populated snapshot.

### 5. Large charters: freeze the content, not just the pointer

Above the inline threshold, `getActiveInjection().text` is a bounded digest that points at `.cc/session-alignment/charter.md` — the **mutable** active mirror (`session-alignment/mirror.ts`), which a later charter activation overwrites. Persisting the digest text alone would freeze the excerpt while leaving the dereferenced full content free to change mid-run, precisely for the largest charters.

So in digest mode the Alignment-owned file boundary also materializes the full content at a no-overwrite, hash-addressed path (`.cc/session-alignment/snapshots/<contentHash>.md`), and the canonical renderer produces the digest against *that* path. The snapshot records instruction, version, hash, and snapshot path. Content-addressed writes are idempotent and bounded by charter activations, so no cleanup is needed in v1. This keeps charter formatting and file knowledge inside Session Alignment; collaboration only stores what it was handed.

### 6. Ticket retrieval in the Codex lane (approved)

The `<active-ticket>` block is an index plus exact retrieval commands — it never inlines attachment bodies. Injecting it therefore closes *content* parity but not *capability* parity, because the Codex task lane's env is neutralized. With your approval, this ships as its own commit and security checkpoint:

- A narrow semantic `CcTaskSessionScope { project, session, conversationId }` — the real originating CC conversation, not an arbitrary env map.
- Only trusted standalone-collaboration orchestration supplies it.
- The task-runner adapter resolves server URL, token, config dir, and binary path **server-side** through `buildSessionEnvContract()`; ambient `CC_*` is neutralized first; no workflow IDs.
- Secrets are never persisted, returned, or logged.
- Every other task run — generic and graph-workflow — stays neutralized, proven by negative tests.

### 7. Conversation continuity (your decision)

`priorBackendRef` seeding stays: agent_one continues to resume the originating conversation's backend session, so a mid-conversation `/collab` keeps knowing what "the bug we discussed above" refers to. The residual risk — that opaque resumed history contains an older charter agent_two never sees — is handled inside this design rather than by removing the feature: the snapshot charter now arrives as governing instructions on *every* call in *both* lanes, and the rendered instruction gains an explicit supersedes clause stating that it overrides any earlier charter text present in prior context. A test seeds charter N into the resumed lane, captures N+1 in the snapshot, and asserts the lane follows N+1.

### 8. Audit and observability

`recordSeenAlignmentVersion` (the existing `lastSeenAlignmentVersion` mutation — one write shape) fires once, after **both** initial drafts succeed. That is the first moment both peers have actually received the charter; recording at capture time would let the Alignment panel claim currency that no agent ever saw.

Structured events carry metadata only — never charter text, ticket fields, attachment content, or credentials: `session_context_resolved` (`alignmentPresent`, `eligible`, version, hash, `activeTicketPresent`, lengths, duration), `session_context_resolution_failed` (failed source + normalized error), `collaboration.manager.start` extended with version and ticket presence, and a version-seen event.

## Change map

| Module | Change |
| --- | --- |
| `workflows/collaboration/session-context.ts` | **New** — schema, empty projection, composition helpers, strict resume parser |
| `session-alignment/` (gate, render, mirror, service) | Tagged `AlignmentGovernanceContext` + `isAlignmentEligibleContext()`; hash-addressed immutable snapshot for digest mode |
| `workflows/collaboration/manager.ts` | Resolve before claim; fail closed on charter; thread into start and resume; metadata logging |
| `workflows/collaboration/envelope.ts` | Required snapshot input; `initializeEnvelope` persists it; seen-version after both drafts |
| `workflows/collaboration/helpers.ts` | `callPrimitive` decorates every substantive request |
| `workflows/collaboration/deps-factory.ts` | Production resolver + seen-version wiring |
| `workflows/collaboration/agent-caller-production.ts` | Semantic→transport mapping; opted-in task scope |
| `workflows/primitives/agent-call-vocabulary.ts` / `agent-call-facade.ts` | `systemInstructions` common to both kinds; preserved through dispatch, repair, and the format turn |
| `agent-backends/task.ts` + task runners | Optional `CcTaskSessionScope`; server-built env only for opted-in runs |
| `workflows/collaboration/feature-snapshot.ts` | Explicit optional `sessionContext` field |
| Kiro specs | Standalone-collab eligibility; one-logical-turn freshness; backend-independent ticket retrieval |
| Prompt builders, graph collaborator | **Unchanged** |

## Verification

Red-green TDD, dependency injection over `vi.mock` for internal modules:

- **Projection**: both present / charter only / ticket only / neither; eligibility matrix across creation modes; no `/align` nudge ever.
- **Kickoff**: resolved exactly once before claim; charter failure claims nothing and dispatches neither lane; ticket failure warns and yields null.
- **Role/backend matrix**: with primary Claude *and* primary Codex, both agents receive identical charter version/text and the identical ticket block.
- **All phases**: every substantive call carries the snapshot; ticket block appears exactly once per work prompt; format turn keeps the charter, drops the ticket.
- **Continuity**: seed charter N into the resumed primary lane, snapshot N+1, assert N+1 governs; stale-ref recovery still carries the snapshot.
- **Immutability**: activate N+1 mid-run after a digest-mode capture; both persisted pointers still return N's exact bytes; plus byte-identical transport of `getActiveInjection().text`.
- **Durability**: envelope round-trip via the maximal contract fixture; missing *and* malformed snapshots fail before dispatch while historical envelopes still parse for display.
- **Ticket tools**: `cctl ticket get` and attachment retrieval succeed from an opted-in Codex collaboration task; unrelated task runs still receive neutralized `CC_*`.
- **Regression**: no-charter/unlinked runs produce today's exact prompt and instruction shape; graph-workflow collaboration tests unchanged.

Then `bun run test src/lib/workflows/collaboration`, the agent-call primitives and both backends, `bun run typecheck`, `bun run lint` (including the seam ratchet).

## Suggested landing order

1. `session-context.ts` + tagged eligibility + spec clarifications.
2. Shared-base `systemInstructions` in the request vocabulary and facade.
3. Manager capture/persist/resume + `callPrimitive` injection + seen-version + logging.
4. Digest-mode immutable charter snapshot.
5. `CcTaskSessionScope` task-env stage (approved; separate commit and security checkpoint).

Stages 1–4 deliver full context parity for both agents on both backends; stage 5 makes the ticket block's retrieval commands executable from the Codex lane, closing Requirement 5.6.
