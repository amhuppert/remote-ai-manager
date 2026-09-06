# Cursor queueing and independent forks — #112

Research date: 2026-09-05. Installed SDK: `@cursor/sdk` 1.0.28. Latest published package checked: 1.0.31.

## Provider support

Neither version exposes a native conversation fork or clone operation in the public Agent/SDKAgent API. The published declarations expose create, resume, messages, run inspection, send, wait and cancellation. Public checkpoint storage supports persistence; it does not promise an independently forked agent anchored at a selected CC message. CC therefore uses a synthetic fork, without copying or resuming the source reference.

Sources: [installed package](https://www.npmjs.com/package/@cursor/sdk/v/1.0.28), [latest inspected package](https://www.npmjs.com/package/@cursor/sdk/v/1.0.31), and their `dist/esm/{index,public-api,agent,platform,options,run}.d.ts` declarations. The 1.0.31 tarball was inspected under `.cc/temp/cursor-sdk-1.0.31/`; no dependency upgrade was needed for synthetic forks.

Version 1.0.31 adds optional `Run.steer(text)` with `complete_delivered` and `revert_to_followup` outcomes. That is native in-turn steering, assigned to #123, and is not a durable CC queue contract.

Both versions declare `SendOptions.idempotencyKey`, but the installed local runtime does not deduplicate sends with that key. The published bundled implementation forwards the key on cloud requests; local run/event-store idempotency fields are not a guarantee about local `SDKAgent.send`.

In the published 1.0.31 local `sendImpl`, each send selects a run with `getRunForSend` and calls the executor with a generated request ID. `getRunForSend` consumes the pending initial run or calls `createFollowUpRun`; it never reads `idempotencyKey`. The executor call likewise does not forward that option. This source evidence rules out interpreting the two live run IDs below as mere aliases for one deduplicated request.

An authenticated probe against the actual installed SDK sent the same text twice with the same key, tools disabled, in an isolated local store:

| Call | Provider run | Result |
| --- | --- | --- |
| First | `run-13a612d8-acd6-40a6-9f06-7cbe29231b74` | finished, `PROBE_OK` |
| Repeated key | `run-e5420e97-eef0-4ce2-aec4-1587e09aceac` | finished, `PROBE_OK` |

The distinct run IDs disprove send deduplication for this local transport. Probe: `.cc/temp/cursor-112/sdk-idempotency.mjs`; result: `.cc/temp/cursor-112/sdk-probe/result.json`. No provider mock was used.

The same authenticated probe against the published 1.0.31 bundle also produced two finished runs: `run-553734e0-5200-4dca-8042-d8bf975cd569` and `run-c7829f57-da25-47d0-a71e-cc12d0ac1112`. Result: `.cc/temp/cursor-112/sdk-probe-latest/result.json`. Upgrading to that version does not provide local send deduplication.

The public local-store API exposes run records and event logs, so CC can reconcile completed runs where their identity is known. It does not promise atomic acknowledgement across the CC queue, a local run and remote execution. `LocalSendOptions.force` expires a crashed active run and starts a follow-up; it is not a resume-at-most-once operation. A recovery design must distinguish proven non-delivery, known acceptance and uncertain execution rather than treating every abandoned claim as safe to replay.

## Abandoned local runs

A process-kill probe exposed a local recovery edge: `Agent.create` persists an initial run before the first acknowledgement, and `Agent.resume` can succeed while that run is still active. A subsequent `send` then throws `UnknownAgentError` with “already has active run,” rather than the exported `AgentBusyError`. Error classification alone cannot reliably select recovery.

The public SDK provides `Agent.listRuns` and `Agent.cancelRun` for this state. CC uses those native APIs before resuming, only when its worker registry establishes exclusive ownership of the conversation. It paginates run records, cancels the abandoned active run, and resumes the same agent once; it does not replace the reference or automatically resubmit an uncertain queue delivery. Read-only continuity probes do not receive recovery permission. Calls carry the exact agent cwd and its conversation-owned `JsonlLocalAgentStore`; supplying the store without the cwd can produce `AgentNotFoundError`.

The native cancellation research probe changed `run-f7837b8f-c433-4c23-aa7a-9bfa951ed066` to `cancelled`. The final application-level recovery probe and its durable evidence are recorded in [validation.md](validation.md). Worker recovery logs are bound to the owning CC configuration directory.

## Implemented fork contract

- The Cursor continuity adapter builds a bounded text seed from the CC transcript without attaching the source agent.
- Assistant forks include the selected message. User-message forks exclude that message; its text remains the editable draft. Index-zero start-over retains its existing semantics.
- The conversation persists the immutable seed in `forkedFrom.syntheticSeed`, separately from `pendingPromptText`. Draft edits cannot remove the inherited context, and first-turn composition does not duplicate the seed.
- The first Cursor turn receives the seed and the current user prompt. Its fresh agent and store are bound to the target conversation ID. Later turns resume that target reference.
- Seed acceptance is persisted separately in `forkedFrom.syntheticSeedAcceptedRef`. Eager agent creation does not consume the seed: a first prompt interrupted before acceptance keeps its inherited context on retry. A receipt applies only to the agent that accepted the seed; replacement agents receive it again. The shared actor records the receipt on `input_accepted`, and Cursor/Codex runtimes consume the explicit seed supplied by that policy.
- Synthetic history is limited to 24,000 characters, retaining the end of the history when truncated. Empty dialogue is refused. Historical images, tool state and hidden provider context are not copied.
- The existing synthetic badge is accurate for this behavior and is also displayed in panes and peek.

The field uses the existing `forked_from` JSON column and existing repository encode/decode path. Both conversation repository maximal round-trip fixtures cover it. No table or column migration is necessary. Native Claude-equivalent fork fidelity remains an explicit provider parity blocker.

## Implemented queue contract

Alex selected **Retain uncertain deliveries for review** in question batch `q_491fb142-dd47-4250-952d-081d5f5daf0b`. This is the recovery contract implemented here. Cursor advertises CC-owned `next_turn` queueing; it does not claim native in-turn input or automatic exactly-once replay.

The shared queue service owns FIFO claims, attempt identity, retained failures, recovery and explicit review:

- Content, images and complete model selections remain in the conversation's durable JSON queue until handoff succeeds. A delivery is removed only after provider input acceptance and a strict, idempotent transcript append both succeed.
- An active claim blocks later claims. Profile admission rechecks actor readiness after its asynchronous work and returns a batch to pending if another turn won that race.
- Missing acknowledgements, disk errors and interrupted claims retain the original payload as `uncertain`. Known rejected deliveries remain `failed`. Both states block subsequent queue delivery and direct prompts.
- Startup discovers ordinary session and project queues even without a resumable actor snapshot. It recovers claims before starting the actor and clears a dead turn's persisted running status so review is usable.
- Cancellation waits for the invoked prompt and Cursor worker teardown before the queue advances or a queued delivery becomes reviewable. Concurrent actor startup is single-flight.
- Retry keeps the message's position, images and model but assigns a fresh message/attempt identity. A delayed acknowledgement from the previous delivery cannot acknowledge the explicit retry. Discard removes the queued copy and does not undo any provider work.
- Session and project review routes share the same operation and validation. The shared composer exposes Retry/Discard and blocks sending while review remains; main, pane and project transcripts distinguish queued, delivering, failed and uncertain messages.

No durable input is silently discarded on an ambiguous result, and restart never automatically re-executes an ambiguous attempt. Explicit Retry may repeat work that already reached Cursor; the UI says so at the decision point. Fully automatic exactly-once execution remains unavailable without a stronger provider transport guarantee. The authenticated repeated-key probes establish why the SDK's option cannot supply that guarantee.

## Design assessment

Score: **10/10 for the implemented queue/fork contract**, with all eight software-design-philosophy diagnostics satisfied. Failed diagnostic rows: **none**; no additional change is required to reach 10 within this scope. This score does not imply native provider parity.

| Diagnostic | Evidence |
| --- | --- |
| Each module has one describable purpose | Queue service owns durable delivery state; accounting owns the transcript handoff; continuity owns provider history derivation. |
| Interfaces are simpler than implementations | Claim, acknowledge, recover and resolve hide transactional transforms, attempt guards and broadcasts. |
| Implementations can change without callers changing | Both route scopes share review operations; UI consumes queue states; fork callers consume normalized continuity outcomes. |
| Interface comments describe abstractions | Handoff, recovery ownership and retry identity guarantees are recorded beside their interfaces. |
| Design is part of review | This assessment checks ownership, information leakage and cancellation/recovery ordering alongside correctness. |
| Each module hides an important decision | SDK limitations stay in Cursor continuity; queue persistence and retry semantics stay in the queue service. |
| Boundaries are understandable without implementation reading | Typed queue states, review actions, continuity outcomes and documented handoff ownership define the contracts. |
| Design improvement accompanies implementation | Shared review handling, strict durable transcript I/O, centralized recovery transitions and single-flight lifecycle handling remove duplicated assumptions. |
