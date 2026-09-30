# Native Codex conversation forks

Status: implemented on branch `csm/codex-native-forks-84c161` (design v2.1 after two adversarial review rounds, see [Review history](#review-history)), plus the Claude anchor refactor in §1. Scope: conversation forks (`forkConversation`), not checkpoint forks.

## Goal

A Codex conversation forked at visible message N continues in a Codex thread whose provider history equals the source thread's history at that fork point. The fork is **native only when the fork's own transcript snapshot proves the fork point sits on a completed source-thread turn boundary**. Otherwise it falls back to today's synthetic seed. Every Codex-specific rule lives in `src/lib/agent-backends/codex/`.

"Equals the source thread's history" is parity with provider state, not with visible text. The source's own provider history can already differ from its visible transcript, for example a user line whose dispatch failed or a steer whose acknowledgement was lost. A native fork carries exactly what the source thread had at that point, no more and no less.

## Verified facts

All checks were run on 2026-09-30 against the pinned CLI (`@openai/codex` 0.159.0, vendored binary).

### Protocol

- **SDK vs app-server.** `@openai/codex-sdk` (0.159.0 and the latest 0.159.2) has no fork API. CC's Codex conversations run on `codex app-server`, not the SDK.
- **`thread/fork` params.** `ThreadForkParams { threadId, lastTurnId?, cwd?, model?, sandbox?, config?, ephemeral?, excludeTurns? }`. `lastTurnId` is inclusive, and the named turn must not be in progress. Both appear in the default (non-`--experimental`) protocol bindings.
- **Exact cut.** Probe with `experimentalApi: false`: turn 1 set ALPHA, turn 2 set BRAVO. The fork at turn 1 answered ALPHA and the source answered BRAVO. The fork is persisted (`thread.path`, `forkedFromId`), and its copied turns keep the source's turn ids.
- **Loud errors.** Unknown `lastTurnId` → `-32600 "turn not found: …"`. Unknown thread → `-32600 "no rollout found for thread id …"`. Neither silently forks the full history.
- **Turn numbers don't correspond.** CC message index ≠ Codex turn index. A single CC exchange can span many Codex turns, and CC-only commands (`/merge`) have none.

### Boundary evidence already in every Codex transcript

The runtime records every incoming app-server JSON-RPC frame as a lossless `codex_app_server` envelope. It does this serially, through `onFrame`, before processing the frame (`codex/conversation-runtime.ts:974-987`). That includes each `turn/completed` notification, which carries `params.threadId`, `params.turn.id` and a terminal `params.turn.status` (`completed`, `interrupted` or `failed`).

In the "Notifications 1" transcript:

- Every main-thread `turn/completed` frame sits immediately after that turn's final assistant line and before the next user line.
- That ordering holds for content the projector emits while consuming frames: tool items, and `agentMessage` items with a `commentary` or `final_answer` phase. The transport drains `onFrame` serially, and the actor awaits each append.
- An `agentMessage` whose phase is absent or unrecognized is buffered (`codex/app-server-events.ts:73-88`). It reaches the transcript at the next item or through `projector.finish()`, which runs after the `turn/completed` envelope is appended (`codex/conversation-runtime.ts:1191-1192`). Such a turn's final text can land *after* its completion envelope.
- Sub-agent (child-thread) `turn/completed` frames are interleaved mid-turn: 13 distinct thread ids appear. **The rule must filter by the source thread id.**
- The CC-only `/merge` user line and its assistant-role commit-message line carry no `origin`, so they are indistinguishable from provider-bearing lines.

### Pre-existing baseline race (not introduced by forks)

- **Ordering.** On `thread/resume`, the `thread/tokenUsage/updated` notification carrying inherited totals arrived *after* the resume response in 2 of 3 resume-only probes.
- **Real overbilling.** In the source transcript, the 44 s turn `01a0f2e7` had no baseline before `turn/start`. It was billed from its first in-turn total, 54,282,089 cumulative tokens, as `turnCostUsd` 72.24. The next turn received its baseline before `turn/start` and cost 3.04.
- A native fork's first turn is an ordinary resume and inherits this race. The race is tracked separately (§6).

### Live-row audit (read-only, `~/Library/Application Support/cc/command-center.db`)

- There are 2 Codex synthetic forks. Both store `syntheticSeed`.
- There are 0 Codex forks without a stored seed in either table, whether or not they record a fork mode.
- So flipping the capability strands no existing row.

## Constraints

From `.kiro/steering/agent-backends.md` and `AGENTS.md`:

- `AgentSessionRef.ref` is opaque outside the owning adapter. Neutral code stores no provider-specific session, thread or turn field.
- Behavior comes from declared capability, never from `backend === "codex"`.
- Adapters own fork behavior and their lossless frames. Neutral code never reads `raw`.
- No backward-compatibility shims without Alex's approval.

## Design

### 1. Neutral change: one immutable snapshot per fork

Today `forkConversation` reads the mutable source transcript up to four times:

1. the visible-message read,
2. `findForkAnchorUuid` (`service.ts:607`),
3. `copyTranscriptUpTo` (`:612`),
4. the adapter's seed builder, run from `continuity.fork` (`:696`).

A source that is still running can grow between these reads, so the anchor, the copied history and the seed can describe different moments.

**Change:** the fork's copied transcript becomes the single snapshot.

- `copyTranscriptUpTo` already writes an exact prefix of the source. It keeps every non-visible line up to the next visible entry, in both modes (`prompt/transcript.ts:456-500`). Nothing writes to the fork's file while it is provisional.
- `ForkInput.sourceTranscriptPath` is renamed `transcriptSnapshotPath` and receives the fork's copied transcript path. Its documented meaning: *an immutable prefix of the source transcript through the fork point; its merged message indexes equal the source's.* All three adapters' seed builders work unchanged on a prefix.
- **Claude anchor selection moves into its adapter** (implemented at Alex's request). `findForkAnchorUuid` and `ForkInput.anchorMessageId` are removed. The neutral `readTranscriptLineClassifications(path)` classifies snapshot lines with the same grouping the copy uses, and `claude/fork-anchor.ts` selects the anchor from those rows:
  - When the snapshot ends in an assistant message, the anchor is that message's last anchored line.
  - When the snapshot ends in a user or notice message, the anchor is the last anchored assistant line before it.
  - One deliberate change from the old lookup: an assistant message with no anchored line (for example checkpoint-capture output) now has no anchor, so the fork falls back to synthetic. Previously the lookup silently cut at an earlier message.
  - Reading from the snapshot also closes the source-growth race for Claude.
- **Native outcomes carry the cut.** `ForkOutcome`'s `native` variant now carries an opaque `locator` (Claude: message uuid; Codex: turn id). The service persists it as `forkedFrom.forkLocator` at finalize, so it is null for synthetic forks and on the provisional row.

There are no other neutral changes: no transcript writer change, no new event field, no new persisted key. The neutral fork path never learns what a Codex turn is.

### 2. Codex adapter: the boundary rule

`codex/fork-boundary.ts` exports one pure function over the snapshot's parsed lines and the source thread id:

> Scan in order. Track the latest `codex_app_server` envelope whose recorded frame is a `turn/completed` notification with `params.threadId === sourceThreadId`. Any later `user` or `assistant` entry with non-empty content clears it, because that is provider-bearing material after the boundary. `notice` entries are CC-authored host material and are skipped. At the end of the snapshot, a tracked turn id is the cut, **unless** that turn recorded an `item/completed` for an `agentMessage` without a `commentary` or `final_answer` phase. In that case there is no cut: the candidate is not replaced by an older one. Otherwise there is none.
>
> The phase guard exists because the projector buffers phase-less messages until after the completion envelope (verified facts). A snapshot copied in that window would contain the completion but not the final text, so without the guard it would pass as native. The guard is deliberately coarser than the projector's flush logic: it also rejects phase-less messages that were flushed earlier by a later item, which costs a synthetic fallback instead of duplicating projector state.

It reads the adapter's own lossless envelopes, as `instruction-state.ts` and `cost-baseline.ts` already do with `readCodexTranscriptRecords`. It parses the recorded frame string with a Zod schema for the `turn/completed` shape; any other or malformed frame is ignored.

Why this is exact:

- **Completed turns are immutable.** The snapshot only contains a `turn/completed` frame for a turn that had already reached a terminal state when the snapshot was taken, so later source activity cannot change what `lastTurnId` selects.
- **Steer is covered.** A steered user line is written at acceptance, before its turn completes, so a cut inside a steered turn finds no boundary after the steer.
- **Nothing hides after the boundary.** Checkpoint-capture output, actor fallback blocks and a failed-dispatch user line are all provider-bearing lines written after their `turn/completed` or without one. Each clears the tracked boundary, which falls back to synthetic rather than cutting early.
- **Stale threads never match.** A thread replaced by stale-ref recovery, or a copied region belonging to another thread, fails the `threadId` equality, which is deterministic and needs no provider error.
- **Late final text is guarded.** A phase-less final message could be appended after the completion envelope, so a turn with one never yields a cut.
- **Existing transcripts qualify without backfill.** They carry these frames, as long as the turn's messages carry phases, which current models observed here do.

### 3. Codex adapter: native fork

`CodexContinuityDeps` gains one port. The existing seed builder keeps its signature and receives the snapshot path:

```ts
/** Forks `threadId` through `lastTurnId` (inclusive); resolves the new thread id. */
forkThread(input: { projectPath: string; threadId: string; lastTurnId: string }): Promise<string>;
```

`fork(ref, input)`:

1. `assertRefOwnedBy("codex", ref)`.
2. Read `input.transcriptSnapshotPath` with `readCodexTranscriptRecords` and compute the boundary for `ref.ref`.
3. If there is no boundary, log `continuity.fork.synthetic_no_boundary` and return the synthetic seed.
4. Otherwise call `forkThread`. On success, log `continuity.fork.native` and return `{ kind: "native", ref: { backend: "codex", ref: newThreadId } }`.
5. If `forkThread` throws, log `continuity.fork.native_failed` with the reason and return the synthetic seed.
6. If the seed is unbuildable when needed, throw `ContinuityForkError`. A snapshot read failure is treated as no boundary.


Production `forkThread` is `codex/thread-fork.ts`, lazy-imported from `createProductionCodexContinuityDeps`. It follows the `skill-discovery.ts` one-shot:

- **Launch.** `createCodexAppServerClient({ cwd: projectPath, env: toStringEnv(buildChildEnv()), config })`. `config` is `CODEX_NATIVE_MEMORY_CONFIG` plus `mcp_servers` from the existing `listNativeCodexMcpServers` + `buildCodexMcpServersConfig({ managedMcpServers: {}, nativeServers })`.
  - That disables every native server the existing listing/parser recognizes. `thread/fork` loads the new thread, and nothing in a metadata-only operation needs MCP. This is the policy the runtime already applies to unselected servers.
  - It inherits the runtime's known limitation: an unrecognized transport entry is skipped by the parser and stays enabled (`native-mcp-suppression.ts:105-115`). The live child-process check covers the installed configuration; if it finds a surviving server, fix that concrete case or use the runtime's stronger descendant-observing cleanup.
  - A listing failure throws into the adapter's synthetic fallback.
- **Requests.** `initialize` (`experimentalApi: false`), then `initialized`, then `thread/fork { threadId, lastTurnId, excludeTurns: true }`. The response is `safeParse`d as `{ thread: { id: string } }`.
- **Cleanup.** `close()` runs in `finally`, using the same close/cleanup mode the conversation runtime uses for its per-turn process. Any recorded `onFailure` error is surfaced. A cleanup failure after a successful fork is logged and still returns the native ref, because the thread exists and is valid.
- **Timeout.** Each RPC has the transport's 30 s timeout, and initialize and fork run sequentially. No extra overall deadline is added.
- **No overrides.** It sends no `model`, `sandbox`, `approvalPolicy`, `config` or `cwd` override. The fork's first `thread/resume` applies them (§6), and `ephemeral` stays default (persisted).

### 4. Outcomes

| Fork point (end of snapshot) | Boundary | Outcome |
|---|---|---|
| After a completed source turn, before the next provider-bearing line (idle source, inclusive fork at a turn's last assistant unit, or exclusive fork at the next user message) | latest source `turn/completed` | native |
| Inside a turn (mid-turn assistant unit, or at/after a steer that joined the turn) | cleared or absent | synthetic |
| Source running, fork at its latest unit | absent (turn not completed in snapshot) | synthetic |
| After an interrupted or failed source turn | that turn's frame | native, pending live confirmation that `thread/fork` accepts a terminal non-`completed` turn |
| Directly after checkpoint-capture output, actor fallback blocks, a failed-dispatch user line, or a CC-only command entry such as `/merge` | cleared | synthetic until the next source turn completes |
| After a turn that recorded a phase-less `agentMessage` | guarded | synthetic |
| Synthetic fork, before it has its own thread (service resolves the ancestor ref, `service.ts:929-934`) | ancestor-thread frames in the copied region match the ancestor ref | native fork of the ancestor |
| Synthetic or native fork, after it has its own thread, at a copied region | frames name another thread | synthetic |
| Source thread archived or deleted, or `thread/fork` fails for any reason | — | synthetic |
| User message 0 | — | unchanged: fresh conversation |

### 5. Descriptor and capability consumers

- **Descriptor.** `codex/descriptor.ts`: `fork: "synthetic"` becomes `"native"`, matching Claude's declaration, which also falls back per fork.
- **Readers.** Every reader was inventoried by the review. The semantic ones are:
  - `fork-admission.ts:13`: refuses only `unsupported`, so it is unchanged.
  - `conversation-policy.ts:97` (`backendRequiresSyntheticForkSeed`): the runtime seed builder is now closed for Codex. It serves only seedless forks, and the live audit found none. Stored seeds are served before the capability check (`fork-seed.ts:75-92`).
  - Conformance vocabulary and fork coherence (`conformance.ts:601`, `:738-753`): the Codex harness injects a fake `forkThread` and a snapshot with a boundary.
- **Tests that change.** `fork-seed.test.ts` (`:97`, `:155`, `:205`) asserts Codex's synthetic gate; switch those cases to a test backend or to Cursor. `cursor/descriptor.test.ts:135` compares capabilities; check it.
- **UI.** Badges key off per-conversation `forkMode`, so native Codex forks lose the badge and fallbacks keep it.

### 6. The fork's first turn

This path needs no runtime change. What is established:

- **Resume and verification.** The persisted `backendRef` selects `thread/resume`, which sends the worktree cwd, model, approval policy, sandbox, reasoning effort and config. `verifyEffectiveThread` checks model, cwd, approval, sandbox and writable roots. It does not check reasoning effort or effective skills, MCP or instruction sources; those follow the ordinary resumed-turn path (managed-skills bridge, skill catalog, MCP translation) exactly as for any resumed thread.
- **Governing instructions.** The snapshot's `codex_instruction_state` records are keyed to the source thread ref, so the fork re-injects the **current complete governing block** once via `thread/inject_items`. The block explicitly supersedes earlier CC blocks, and its content reflects the fork's current context (profile, reference documents, alignment and so on).
- **Cost.** The cumulative ledger has no persisted baseline for the new thread ref, so `cumulativeCostUsd` is `null` for this thread lineage until a fresh replacement resets it. Workflow-graph telemetry tolerates `null`. Per-turn `costUsd` depended on the baseline race (verified facts). **Fixed in the same branch:**
  - `CodexConversationRuntime` treats a `thread/tokenUsage/updated` not scoped to the current turn as the pre-turn baseline, even when it arrives after `turn/start`.
  - A stale pre-turn sample that arrives after in-turn usage is ignored.
  - A resumed thread that never receives a baseline reports the turn's tokens and cost as unknown, and logs `codex-runtime.usage_baseline_missing`, instead of billing the whole thread.

### 7. Docs and comments to correct

- `codex/continuity.ts` header: describe the boundary rule and fallback.
- `ForkInput`/`ForkOutcome` docs (`continuity.ts`): the snapshot contract, the exact-cut obligation, and the native `locator`.
- `TranscriptEntry.uuid` and `transcript-logical-units.ts` comments: say "opaque message anchor stamped by the conversation's adapter". A new **Conversation forks** section in `.kiro/steering/agent-backends.md` states the contract.
- `.kiro/steering/agent-backends.md` managed-skills paragraph: Codex conversations use app-server, not an "exec transport".

## Test plan (red → green per item)

1. **`codex/fork-boundary.test.ts`**: pure function, fixtures built from real frame shapes:
   - completed turn then idle → cut;
   - steer line after content, then `turn/completed` → no cut at the steer, cut after it;
   - interrupted steer with no later output, fork at the steer → no cut;
   - child-thread `turn/completed` after the main one → main cut unaffected;
   - child-thread frame only → no cut;
   - frame for a different (stale or ancestor) thread → no cut;
   - capture output, fallback blocks or a failed-dispatch user line after the boundary → no cut;
   - a notice after the boundary → cut kept;
   - two source turns completing with no visible line between → latest wins;
   - a phase-less `agentMessage` in the candidate turn → no cut, and no fallback to an older turn;
   - malformed or unrelated `codex_app_server` records → ignored.
2. **Production ordering regression** (`codex/app-server-runtime.test.ts` injected transport harness, temp JSONL).
   - Setup: drive the real runtime with a phased visible block, then a phase-less completed `agentMessage`, then `turn/completed`. Make the transcript event sink pause right after persisting the completion envelope.
   - While paused, run the real `copyTranscriptUpTo` and the selector, and assert no cut.
   - Release the sink, then assert the settled transcript is also no cut, the conservative case.
   - Repeat with phased-only messages and assert a native cut. This tests production-generated ordering, not hand-authored fixture order.
3. **Service snapshot** (`conversations/service.test.ts`, real state manager):
   - The adapter receives the fork's copied transcript as `transcriptSnapshotPath`.
   - The Claude anchor is computed from the copy.
   - Race case: append lines to the source after the copy but before `continuity.fork`, with a deferred fake continuity. Assert that the actual anchor and seed selection exclude the appended lines.
   - Migrate the existing tests. The unbuildable-seed rollback test (`:1381-1415`) must delete `input.transcriptSnapshotPath`, not the source path. The path assertions at `:1135` and `:1196` compare against the fork row's transcript path. Deleting the source can stay as a success regression proving snapshot independence.
4. **`codex/continuity.test.ts`**: real snapshot files; injected `forkThread` and seed builder:
   - no boundary → synthetic, `forkThread` not called;
   - boundary → `forkThread({ threadId: ref.ref, lastTurnId })` → native ref;
   - `forkThread` rejects → synthetic;
   - both fail → `ContinuityForkError`;
   - foreign ref throws.
5. **`codex/thread-fork.test.ts`**: injected `createAppServer` and MCP-list ports:
   - request order and exact params;
   - native MCP servers disabled in the launch config;
   - `close()` on success, RPC error and schema failure;
   - cleanup failure after a successful fork still resolves the id.
6. **Persistence** (`createPersistenceFixture()`): through `forkConversation`, a native Codex fork's `backendRef` and `forkMode: "native"` survive reload; a fallback's seed survives reload.
7. **Conformance and gate**: the Codex harness passes fork coherence as `native`, and the `fork-seed.test.ts` cases are migrated (§5).
8. **Live** (`cc-live-feature-test`, session dev server, explicit Codex `modelSelection`):
   1. Set ALPHA, then set BRAVO. Fork at the ALPHA assistant message. Expect native, no badge, and ALPHA recalled on the fork's first turn.
   2. The one-shot used the project-root cwd, so this also shows the first resume applying the worktree cwd.
   3. Fork after an interrupted turn: confirm `thread/fork` accepts it.
   4. Steer into a running turn, then fork at the steered message. Expect synthetic.
   5. Fork after `/merge`. Expect synthetic.
   6. Check that no MCP child processes outlive the one-shot.

## Edge cases left unhandled

- **Forks right after CC-only command entries** (`/merge`, `/commit`, `/rebase`), checkpoint-capture output or actor fallback blocks are synthetic until the next source turn completes. Follow-up option: stamp CC-command entries with a host-only `origin` so the rule can skip them like notices.
- **Fork of a native fork at a copied region** is synthetic even though the fork's thread contains those turns, because the copied frames name the ancestor thread. Accepting ancestor frames would need lineage knowledge or reliance on provider rejection.
- **Hidden provider state.** A steer whose acknowledgement was lost is part of the source thread but has no visible line, so the native fork carries it just as the source does (parity, §Goal).
- **Orphaned threads.** A Codex thread made by `thread/fork` is orphaned if CC's fork finalization fails afterwards, the same as Claude. Deleting a CC conversation does not delete its Codex thread.

## Alternatives considered

- **v1: per-line turn-id anchors on assistant content plus a neutral "anchor repeats after the boundary" invariant.** Rejected by review: the absence of a repeated anchor does not prove a turn ended. An interrupted steer with no later output crossed the boundary, and skipping unanchored lines cut earlier than the copy. It also needed an actor change and a new neutral event field.
- **Mapping CC message N to the Nth Codex turn, or matching turns by text or timestamp via `thread/turns/list`.** Wrong or fragile: the turns don't correspond, and matching would put provider logic on the fork path.
- **A new runtime-written boundary frame.** Unnecessary, because the raw `turn/completed` envelope already records the boundary at the right position, and existing transcripts carry it.
- **`codex exec fork <id>`.** Whole-thread only.
- **Forking lazily inside the first turn.** `continuity.fork()` must return the ref at creation.
- **Passing the worktree `cwd` to `thread/fork`.** This adds `ForkInput` surface for no behavior, since resume sets and verifies cwd.

## Review history

- **v1 → v2.** Codex (gpt-6-astra, xhigh) review, `memory-bank/agent-runs/codex-native-forks-design-review.md`, verdict "rework". Accepted:
  - adapter-owned exact-cut evidence (findings 1 and 3);
  - one immutable snapshot (finding 2);
  - a stronger test matrix (finding 5);
  - MCP launch policy and timeout wording (finding 6);
  - tightened ownership (finding 7);
  - qualified claims, table split and live-row audit (finding 8).

  Finding 4 (baseline ordering) was confirmed as a pre-existing defect in all resumed Codex turns, and is split out as a separate recommended fix (§6).
- **v2 → v2.1.** Re-review, `memory-bank/agent-runs/codex-native-forks-design-review-v2.md`, verdict "rework" on one blocker. It found v1 findings 1, 3, 7 and 8 resolved, and 2, 4, 5 and 6 partially resolved. Accepted:
  - the phase-less `agentMessage` guard, after verifying the projector's deferred `finish()` flush (blocker 1);
  - the service test migration (finding 2);
  - qualified MCP-suppression wording (finding 3).

  The baseline race stays deferred to its own fix; the reviewer concurred. v2.1 applies exactly the smallest changes the re-review recommended and has not had a third review.
