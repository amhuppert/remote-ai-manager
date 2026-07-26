# Counter-proposal: complete the shared-snapshot architecture

Alex, Agent One's revision makes substantial progress. It verifies and adopts the load-bearing architecture from my draft: one kickoff snapshot, canonical sources, semantic transport, a required slice input, centralized request composition, source-specific failure policy, truthful seen-version recording, and specification updates. I accept four of its proposed changes and reject four as written.

The revised proposal is **8/10** on the software-complexity rubric. It reaches 10/10 when the design also makes standalone eligibility explicit, rejects unsnapshotted resume by default, treats Codex attachment retrieval as required rather than optional follow-up, removes one-sided inherited context, and freezes the full large-charter content behind digest pointers.

## Decisions on Agent One's proposed changes

| ID | Decision | Rationale |
| --- | --- | --- |
| PC1 | **Reject** | Passing `autonomous: false` to the generic turn predicate still encodes the product exception by contradicting the internal calls' actual execution mode. The policy should be represented explicitly, not hidden in a literal. Replace with AC1. |
| PC2 | **Reject** | Missing context does not prove that an old run's premises were empty: Agent One may have inherited context through `priorBackendRef`. Missing-to-empty is also backward-compatibility behavior, which requires Alex's explicit approval. Replace with AC2. |
| PC3 | **Reject as written** | Separate staging and an approval checkpoint are correct, but the proposed fallback permits declaring the feature delivered while the canonical ticket block knowingly contains unusable commands in the Codex lane. Accept the staging discipline, not the index-only completion escape hatch; use AC3. |
| PC4 | **Accept** | Keep Alignment version/hash in the durable snapshot for audit and seen-version state, but do not add request/runtime plumbing that has no recreate behavior in per-call collaboration runtimes. |
| PC5 | **Reject as sufficient** | Byte-identical digest delivery is worth testing, but it does not freeze the mutable file to which the digest points. Replace with AC5; retain the proposed byte-identity assertion as a supplemental test. |
| PC6 | **Accept** | Add the explicit optional field at the generic persisted-schema boundary and extend the maximal round-trip fixture. Optional decoding of historical blobs does not imply that resume execution may proceed without a valid context; AC2 owns that invariant. |
| PC7 | **Accept** | Reuse `recordSeenAlignmentVersion`; there should be one mutation shape for `lastSeenAlignmentVersion`, invoked only after both initial drafts succeed. |
| PC8 | **Accept** | Add `eligible` alongside the already proposed `alignmentPresent`, version/hash, ticket-present, lengths, and duration metadata. Log no context bodies or credentials. |

Accepted change IDs: **PC4, PC6, PC7, PC8**.

Rejected change IDs: **PC1, PC2, PC3, PC5**.

## Alternative changes

### AC1 — Represent standalone eligibility as a first-class governance case

Replace PC1 with an Alignment-owned tagged eligibility API:

```ts
type AlignmentGovernanceContext =
  | {
      kind: "conversation_turn";
      creationMode: SessionState["creationMode"] | undefined;
      isProjectConversation: boolean;
      autonomous: boolean | undefined;
    }
  | {
      kind: "standalone_collaboration";
      creationMode: SessionState["creationMode"] | undefined;
      userInitiated: true;
    };
```

`isAlignmentEligibleContext()` remains the single policy owner. The existing conversation case preserves R12 behavior. The standalone case returns eligible only for a user-initiated normal session. Update the Alignment requirements first to define that collaboration run as one attended logical originating turn, while its internal backend calls remain autonomous. Ticket lookup stays ungated.

This is clearer than passing a deliberately false execution flag and prevents a future maintainer from applying the exception to graph workflows.

Addresses: D6 / PC1.

### AC2 — Separate permissive storage parsing from strict resume execution

Keep `sessionContext` optional on the generic user-origin feature-snapshot schema so historical envelopes can still be displayed and round-tripped. Make it required at both executable boundaries:

- Every new `AsymmetricCollaborationSliceInput` carries a valid context.
- `initializeEnvelope()` always writes that context.
- Manager resume parses the persisted field with `collaborationSessionContextSchema`.
- Both an absent field and a present-but-malformed field produce a typed, actionable restart error before state is marked running or either lane is dispatched.
- Ask-user resume and process-restart recovery use the same parser.

Do not re-read current context and do not silently manufacture an empty projection. If Alex later approves legacy best-effort resume, add it as an explicit, tested compatibility policy; it is not the default design.

Addresses: D4 / RD1 / PC2, while retaining PC6's storage contract.

### AC3 — Stage the task session scope, but keep it in the completion gate

The task-environment work should be a separate commit and an explicit security checkpoint, because the server-side contract supplies an instance token to a task subprocess. It nevertheless remains required for backend-independent ticket context:

- Add a narrow semantic `CcTaskSessionScope` containing project, session, and the real originating conversation ID—not an arbitrary environment map.
- Only trusted standalone-collaboration orchestration may supply it.
- The task-runner adapter resolves server URL, token, config directory, and binary path server-side through `buildSessionEnvContract()`.
- Ambient `CC_*` values are neutralized first; workflow IDs are not supplied.
- Secrets are never persisted, returned, or logged.
- Generic task runs and graph-workflow task runs remain neutralized by default.

Alex's sign-off is required before implementing this stage. If that approval is declined, the release must be described as index-only and the original ticket-retrieval requirement remains unresolved; it must not be called complete parity.

Addresses: D2 / RD2 / PC3.

### AC4 — Remove one-sided backend-history seeding

For user-origin standalone Collaboration Mode, stop seeding Agent One's lane from `priorBackendRef`; both lanes start fresh from the same brief, charter instruction, and ticket snapshot. This is the only backend-independent guarantee available today:

- A resumed Claude session may carry a prior system prompt.
- A resumed Codex task thread carries prior prompt history, where its so-called system instructions are rendered into prompt text.
- `AgentSessionRef` is intentionally opaque, so neutral collaboration code cannot inspect which charter version it contains.

If preserving conversation history becomes a requirement, solve it later with one backend-neutral originating-context projection delivered to both peers. Do not preserve provider history for only one role.

Addresses: D3.

### AC5 — Make large-charter dereferencing immutable

PC5 should be expanded from a text-identity test into a durable content guarantee:

1. Resolve the active Alignment version, content hash, full content, and canonical rendered instruction from one active-version read.
2. For digest mode, have the Alignment-owned file boundary materialize the full content at a no-overwrite, hash-addressed worktree path such as `.cc/session-alignment/snapshots/<contentHash>.md`.
3. Render the governing digest with the existing canonical renderer, supplying that immutable path.
4. Persist the resulting instruction, version, hash, and snapshot path in `CollaborationSessionContext`.
5. Never overwrite an existing hash-addressed file with different bytes.

Test that activating a later charter during the collaboration changes the mutable active mirror but does not change the bytes either peer reads from the persisted digest pointer. Also retain PC5's byte-identical transport test.

This keeps file/version knowledge inside Session Alignment rather than teaching collaboration code how a charter is formatted.

Addresses: D7 / PC5.

## Restated agreements

1. **One logical turn, one projection.** Resolve once after validating the session and originating conversation, before `persistStart`, and reuse the projection for all substantive calls and all resume paths.
2. **Canonical source ownership.** Session Alignment supplies the active charter; `LiveTicketContextProvider` supplies the `<active-ticket>` block. No duplicate renderers and no `/align` nudge.
3. **Semantic channels.** Alignment travels as governing system/session instructions; ticket context prefixes only substantive work prompts.
4. **One standalone composition seam.** `callPrimitive()` decorates every request; the seven prompt builders and the graph collaborator remain session-context-free.
5. **Neutral request vocabulary.** Move `systemInstructions` to the common `AgentCallRequest` base. The production caller maps semantic intent to conversation or task transport and preserves it through the formatting turn.
6. **Required new-run state.** The manager supplies the context, `initializeEnvelope()` persists it, and resume reuses it without live re-resolution.
7. **Failure policy.** Alignment read failure aborts before conversation claim or dispatch; ticket read failure logs a warning and yields `null`, matching the ordinary-turn policy.
8. **Truthful audit.** Record the active Alignment version through the existing mutation only after both initial drafts succeed.
9. **Scope.** Standalone user collaboration in a normal session is included; graph-workflow collaboration remains unchanged.
10. **Security and observability.** Context bodies and credentials never enter logs; the optional task scope is server-resolved, narrowly opted in, and tested negatively for every other task run.

## Remaining disagreements

### RD1 — Missing persisted context cannot be assumed empty

- **Category:** implementation
- **Severity:** major
- **Claim:** A pre-change paused envelope may resume with an empty context projection.
- **Reason:** The envelope has no canonical record of what either peer saw, and `priorBackendRef` means the premises were not necessarily empty or symmetric. The fallback is unapproved backward compatibility.
- **Proposed resolution:** AC2: require a valid persisted context for execution and return a typed restart error otherwise.

### RD2 — Ticket index without working retrieval is not complete parity

- **Category:** implementation
- **Severity:** major
- **Claim:** Context injection may be considered complete before the separately approved task-environment stage.
- **Reason:** Ticket Requirement 5.6 defines full attachment retrieval as part of linked-session context. The canonical block's commands remain unusable in the Codex task lane without trusted CC scope.
- **Proposed resolution:** AC3: stage and approve the security change separately, but retain it in the feature's completion criteria.

### RD3 — One-sided inherited backend context breaks the shared premise

- **Category:** objective
- **Severity:** blocking
- **Claim:** The snapshot architecture guarantees parity while Agent One may still resume `priorBackendRef`.
- **Reason:** The opaque prior session/thread may contain a different charter at equal or higher effective precedence, and Agent Two never receives that history.
- **Proposed resolution:** AC4: start both lanes fresh for standalone collaboration.

### RD4 — Literal `autonomous: false` obscures the policy exception

- **Category:** objective
- **Severity:** major
- **Claim:** Reusing the generic eligibility predicate with a false execution flag is an explicit enough product rule.
- **Reason:** It conflates the attended logical origin turn with autonomous internal calls and makes the graph-workflow exclusion depend on call-site folklore.
- **Proposed resolution:** AC1: encode standalone collaboration as a tagged governance context after updating the requirements.

### RD5 — Stable digest text does not freeze full governing content

- **Category:** objective
- **Severity:** major
- **Claim:** Persisting `getActiveInjection().text` gives both peers one immutable large-charter snapshot.
- **Reason:** Its full-content pointer targets the mutable active mirror, which a later charter activation overwrites.
- **Proposed resolution:** AC5: point digest mode at a no-overwrite hash-addressed charter snapshot and test dereferenced bytes.

## Resulting end-to-end design

```text
CollaborationManager.start
  ├─ validate user-origin normal session + conversation
  ├─ resolve tagged Alignment eligibility
  ├─ atomically capture active charter
  │    └─ digest mode materializes immutable hash-addressed full content
  ├─ capture canonical current ticket block
  ├─ persistStart claims originating conversation
  └─ start slice with required CollaborationSessionContext
        ├─ initializeEnvelope persists the exact context
        ├─ initialize both lanes fresh
        └─ callPrimitive decorates every substantive request
              ├─ Alignment → common systemInstructions
              ├─ ticket → prompt prefix
              └─ opted-in task scope → server-built session environment

resume / restart
  └─ require and parse the persisted context; never re-resolve it

after both initial drafts succeed
  └─ recordSeenAlignmentVersion(existing canonical mutation)
```

The resulting modules stay deep:

- Session Alignment owns eligibility, charter rendering, and immutable full-content materialization.
- The collaboration manager owns one-time capture and kickoff failure semantics.
- The envelope owns durable workflow state.
- `callPrimitive()` owns standalone request composition.
- AgentCall and backend adapters own semantic-to-provider transport.
- The task runner owns environment construction and secret handling.

## Verification additions

In addition to Agent One's accepted test plan:

- Seed `priorBackendRef` with charter N, capture charter N+1, and prove neither lane resumes the prior context.
- Activate N+1 after a digest-mode run captures N; prove both persisted pointers still return N's exact bytes.
- Prove missing and malformed context both fail before resume dispatch, while the generic feature-snapshot reader still parses historical envelopes.
- Execute `cctl ticket get` and attachment retrieval from an opted-in Codex collaboration task; prove unrelated task runs still receive neutralized `CC_*`.
- Cover both primary-backend assignments, stale-ref recovery, the formatting turn, ask-user resume, and process-restart recovery.

With AC1–AC5, the design fulfills “both agents, whichever backends” without weakening the charter, hiding a policy exception, or advertising ticket capabilities that one lane cannot use.
