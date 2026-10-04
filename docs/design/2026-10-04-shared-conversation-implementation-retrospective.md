# Shared Conversation implementation retrospective

Review for Alex, 2026-10-04. This is an assessment and a proposed consolidation sequence; it changes neither revision 2 nor the implementation.

**Keep Conversation, Context, Run and Workspace. Tighten their contracts and do a focused consolidation before adding more workflow control flow.** The partial implementation supports the main architecture. The remaining complexity is concentrated where an interface exposes storage, where an operation is split across several owners, and where a descriptive state is mistaken for an execution fact.

The operating envelope remains one operator, one active server and SQLite database per independent installation, with concurrent agents and restarts during work. Local durable identities, serialization and explicit settlement are justified. No additional service, bus, generic supervisor framework or distributed coordination is indicated.

## What the implementation has taught us

The shared Context constructor, pure progress derivation, candidate-bound certification, intent reconciliation and Workspace conflict relation are useful abstractions. They already eliminate separate algorithms for standalone and workflow execution. Preserve them.

The implementation also shows that naming a decision owner in the design is insufficient. Its callers must be able to use it without interpreting its storage or completing its operation. The observations below are concrete examples of that remaining work. They are not an argument for another rewrite.

## 1. Finish Conversation's durable settlement boundary

**Implementation refactor with narrow design clarifications; highest priority for restart correctness.**

The shared executor is a useful lifetime owner, but its `settleAttempt` commits only the attempt and mailbox (`conversation-core/executor.ts:419`). Before it runs, `runRecordedTurn` independently closes the runtime and settles the existing conversation row (`conversation-core/recorded-turn.ts:38`). That row changes lifecycle, usage, continuity and debug state. Its settlement error is logged and swallowed, after which the executor can still acknowledge a successful attempt. A crash between the two commits gives recovery two accounts of what happened.

This is more than a cosmetic split into functions: adding a terminal field or interruption reason requires understanding both writers and a third recovery path. Both durable records live in SQLite, so their disagreement is not an unavoidable transcript/filesystem transaction gap.

Make one Conversation settlement operation commit the normalized attempt outcome, mailbox disposition and authoritative conversation-row facts together. Treat transcript publication as an idempotent projection keyed by attempt. Clarify r2 §§4.7/10 that the existing row is included in this ownership during coexistence. Keep provider cleanup and evidence gathering before the commit; a failed required persistence step must remain visible and must not be swallowed into acknowledged success.

Required input receipts have a related gap. The interactive path retries receipt closures and retains failures in an in-memory map (`conversation-core/interactive-turns.ts:198,250,571`). Checkpoints have durable repair, but generic contributions such as prepared notepad references do not inherit it. A restart can discard the only remaining retry owner even though the provider accepted the input.

Record enough durable delivery evidence and contribution identity on the attempt for each contribution owner to replay its idempotent receipt. Reuse their existing durable rows; do not persist closures or create a recovery scanner per contribution. The shared settlement coordinator must own archive → required receipts → optional receipts → mailbox/queue release. Clarify §4.4 that every required receipt's ownership survives restart. Extra retries or another process-local map would preserve the underlying defect.

These two findings are source-traced; this review did not simulate a process crash. The [Conversation companion report](../../memory-bank/agent-runs/2026-10-04-design-retrospective-conversation.md) traces the exact write, recovery and receipt paths.

## 2. Separate contribution scope from review evidence

**Design clarification and implementation correction; high priority for existing scoped workflows.**

`WorkspaceScope` describes what a Context may write (`src/lib/workspace/schemas.ts:68`). For an owned scope, evidence compares only those paths (`workspace/evidence.ts:82`). Freeze, verify and acceptance all use that same binding scope (`workspace/executor.ts:146`). Reviewers and acceptance checks, however, obtain whole-workspace stable-read grants.

A Context that owns `src/api` can be reviewed using `src/ui`, package configuration and shared types. An interactive owner can change those inputs during review because cooperative interactive writing is intentional. If `src/api` stays unchanged, the current evidence comparison can retain the verdict despite changed inputs. Final evidence is the safety net for cooperative writing; it must cover what the judgment actually depended on.

Revision 2 §6.3 already distinguishes reviewed inputs in prose, but `capture(binding)` leaves the representation and comparison boundary too implicit. Make the distinction explicit:

- Contribution scope controls supervised write ownership and eventual landing.
- Review-input scope controls evidence for certification and approval. Until a narrower input contract is justified, a whole-tree reviewer/check has whole-tree evidence.
- Workspace owns both capture and comparison. Context stores opaque evidence and binds proof to it.

Keep owned-path contribution evidence; do not replace it indiscriminately with whole-tree ownership. That would erase useful concurrency. Conversely, do not solve this by making interactive turns exclusive: Alex's responsiveness decision still stands. The cost of honest whole-tree review evidence is recertification after relevant owner edits, already accepted by r2.

## 3. Make actual resource admission the executor boundary

**Implementation correction; r2 §3.3 is already right.**

Workspace's `tryStart` checks the permit and records `running` before `perform` waits for a grant (`workspace/executor.ts:234`). `withGrant` then waits without a signal and does not recheck the permit when the grant arrives (`:90`). A freeze, verification or acceptance can therefore perform its effect after a pause closed the permit while it was waiting.

An isolated diagnostic using the real Workspace executor, admission module and SQLite repositories reproduced this sequence: a full-write grant blocked a freeze; the permit closed; releasing the blocker still caused one evidence capture and a settled frozen result. No provider, live database or application worktree was used.

Put abortable waiting, the last permit check, grant acquisition and the admitted record behind one Workspace operation-admission helper. Until that boundary, the operation remains unadmitted and resumable. Pause stops new effects; genuinely admitted effects drain. Cancellation must settle an unadmitted wait without falsely reporting a failed acceptance check.

The smaller alternative—an extra permit check inside each operation—is insufficient ownership: every future landing/publication operation would have to remember the same ordering. A new scheduler or resource-management framework would be excessive. Fix this executor's complete operation before copying its shape into Git publication.

## 4. Make control, activity and observation agree

**Design clarification plus implementation correction; high priority before routes, loops and amendments.**

Two bounded reproductions exposed a shared issue:

| Action | Actual executor/control fact | Reported state |
| --- | --- | --- |
| Pause a Run while its child turn is admitted | Child executor remains running; its permit no longer admits new work | Run says `{ kind: "paused", draining: false }` |
| Record a Run reconciliation failure | Run permit remains open and control has no halt fact | A boundary says halted, but Run progress remains running |

Run pause closes the parent permit (`runs/host.ts:459`); it does not set every Context's local pause flag. Run's projection nevertheless infers draining only from children reporting `paused && draining` (`runs/schedule.ts:94`). Context's local lifecycle is not a reliable measure of its currently admitted effects. The Run failure path records only a boundary (`runs/host.ts:431`), leaving that boundary as a competing account of state.

Clarify in r2 that a Context observation reports its next obligation, admitted activity and effective control separately. Parent pause and local Context pause are distinct facts. A Run derives settled pause from actual child/effect activity, without manufacturing local child pause commands. Changes that matter for that observation must notify its consumer even when the obligation's name stays unchanged.

Run-level faults must be Run control facts that block new scheduling/admission, with owner boundaries projected from those facts and explicit resume semantics. Existing admitted work can still settle. This implements the existing §3.2 guarantee rather than adding automatic retry policy.

Patching the CLI label would hide the first symptom while leaving amendments and later publication vulnerable to the same wrong inference. Copying parent pause into every child would create another synchronized state set and confuse independently paused Contexts. A semantic activity/control projection is the smaller coherent remedy.

## 5. Hide Context storage from Run and its clients

**Implementation refactor; strengthens the existing r2 contract.**

`ContextObservation` exposes the complete `ContextRecord` (`execution-context/host.ts:103`). Run extracts accepted output by searching `record.facts.candidates.items` (`runs/host.ts:160`); the Run view independently repeats that lookup and understands ledger, seat and request layout (`runs/observation.ts:17`). Resume inspects the child's private control flags. Notice rendering imports the disposition table from Context's transition implementation (`runs/notices.ts:1`).

Context already has a progress/outcome report with accepted output (`execution-context/host.ts:314`). Run's reconcile checks that outcome only to close an intent, then reconstructs the answer through the raw-record path. Changing candidate representation or control policy therefore requires changes in Context, Run scheduling/control, observation and notice rendering.

Have Context expose one semantic observation: progress/occurrence, admitted activity, accepted result, relevant control/recovery choices, and task/seat/question summaries. Reuse that projection for `outcome` and owner-facing reads. Run keeps topology, its own control and boundary selection; it does not interpret candidate storage. Keep diagnostic raw-record access private to the domain or explicitly separate from its consumer API.

Start at this cross-domain seam. Do not create getters for every field or a new observation service. A readonly annotation alone does not hide representation. Afterward, narrow private owners where a real change still scatters knowledge: for example, work settlement currently resets candidate internals in `advance.ts:228`, while disposition handling resets them separately at `:572`. Candidates should own those semantic transitions. Pure functions and one Context transaction remain sufficient.

## 6. Complete configuration ownership at runtime creation

**Implementation correction; reinforce the existing §4.6 contract.**

Runtime creation composes configuration A, awaits the backend factory, and only afterward records its seed (`conversation-core/runtime-host.ts:125`). The MCP seed can replace a newer pending hash with A (`mcp/runtime-apply.ts:528`), and the capability seed replaces runtime application state with the older composed baseline (`conversation-core/runtime-application-state.ts:82`). Acceptance receipts identify the conversation but do not carry a runtime incarnation.

If Alex saves B during that await, A's late seed can overwrite B's pending state. The existing test covers a save after seeding, which is a different ordering. Each configuration domain should merge the seed against its current desired revision at commit time and retain B as pending; acceptance must identify and validate the incarnation. Avoid a conversation-wide lock around backend creation and configuration saves. R2 already specifies the right owner and identity, so this needs a clearer handoff contract and its implementation, not another module.

This finding is source-traced rather than newly reproduced. Preserve the semantic distinction between desired configuration, the configuration seeded into a particular runtime, and that runtime's application receipt.

## Smaller cleanup and useful design adjustments

**Remove backend input relays before adding more turn controls.** The core's `TurnRequest`, AgentCall facade/runtime-resolution shape, dispatcher dependency shape and backend input still repeat per-turn fields (`conversation-core/turn-engine.ts:54,255`; `workflows/primitives/agent-call-facade.ts:500`; `agent-call-conversation.ts:44,123`). For example, the backend's `backgroundTaskWaitTimeoutMs` has no corresponding path through these relays. R2 already calls for preparing the port input once and carrying it whole; implement that cleanup while retaining AgentCall's real work/format/repair transformation. Current signal forwarding is present; the historical dropped-signal bug is not being reported again.

**Own operation schemas at the executor.** Context's effect schema restates Conversation seat/access/turn fields and Workspace operation fields (`execution-context/effects.ts:43,82`; `conversation-core/schemas.ts:19`; `workspace/schemas.ts:99`). The executor reads a permissive projection of the request while Context also uses it as continuation metadata. This hides compatibility obligations from TypeScript because the ledger payload is unknown. Compose Context effects from executor-owned request schemas, keeping round/allowance/question correlation with Context. A separate requester-metadata member is worth adding only if schema composition alone cannot preserve that separation. Do not introduce an effect language. The W1/W2 reviewer-authority failure, now fixed, is useful historical evidence that these boundaries need composed tests.

**Keep the shared internal definition for standalone runs.** The implementation represents an agent launch as one definition entry without dependencies (`runs/launch.ts:163`) and reuses the same scheduler. This is simpler than maintaining two internal paths. Amend r2's literal “no graph” language to mean that standalone callers need no authored topology and inherit no workflow-only approval, defaults, route or loop obligations. An internal one-entry collection is acceptable. Interactive conversations still are not workflows. Preserve the whole-contract standalone/one-context equivalence test.

**Complete the planned placement preflight before expanding scoped launch.** Currently Run persists before native seat dispatch first resolves write-policy feasibility (`conversation-core/native-seat-turns.ts:51`). r2 already assigns canonical placement and backend feasibility to Workspace plus backend launch policy. Finish that owner before lanes add more callers. The compiler should consume resolved placement; it should not gain provider branches. Dispatch must recompute the effective policy when mutable environment/configuration requires it, as r2 specifies. This is unfinished planned work, not evidence for a new architecture.

## Proposed consolidation sequence

1. Complete Conversation terminal/receipt ownership and the configuration handoff. Protect the between-commit crash window, required-receipt recovery, and save-B-while-creating-A ordering. Retain backend and retained-task protocol distinctions where they represent real differences.
2. Correct Workspace admission and separate reviewed-input evidence from contribution scope. Protect blocked-grant pause/cancel and changed-outside-owned-scope review scenarios.
3. Introduce Context's semantic observation; use it for Run reconciliation, control and display. Correct settled pause and durable Run fault handling through that seam. Protect drain, independent child pause, lost-hint reconciliation and explicit recovery.
4. Resume workflow feature work. Finish placement preflight before broader scoped/lane launch, remove backend relays before adding turn controls, compose executor-owned request schemas as those operations change, and keep client projections on the same observations.

Each increment should remove the duplicated decision it replaces. Do not add a generic supervisor, pipeline registry, event bus, universal backend wrapper or class per fact owner. Existing pure derivation, one transaction per domain and durable intent/outcome lookup are the right foundations. Keep the named legacy routing fences until the planned cutover; their temporary duplication is different from duplicated decisions inside the new core. The current direct-prompt busy refusal also remains incomplete delivery of the intended durable mailbox contract, not a reason to change that contract.

## Evidence and limits

Reviewed revision 2, the implementation logs, current source at `0cbb16bc3` plus the pre-existing W1/W2 working-tree changes, and selected historical reviews. Historical findings were used as change scenarios, not assumed still open. The current scope is Conversation/core integration, Context/Run contracts and Workspace; lanes/publication, routes/loops, Artifacts, client-owner completion and final cutover remain future work. Their absence is not a finding.

The three executed diagnostics are in `.cc/temp/design-retrospective-control-probe.ts`, with output in `.cc/temp/design-retrospective-control-probe-output.json`. They use production hosts, repositories and in-memory SQLite, with inert external executors/evidence. They demonstrate state and admission behavior, not live provider or Git integration. No registered validation suite or live backend was rerun. No implementation or governing design was changed.

Supporting reviews: [Conversation](../../memory-bank/agent-runs/2026-10-04-design-retrospective-conversation.md) and [Workspace and launch](../../memory-bank/agent-runs/2026-10-04-design-retrospective-workspace.md). Both were read and integrated. Their source-only findings are distinguished above from the three executed diagnostics.
