# Memory follow-ups — live evaluation

**Date:** 2026-09-04
**Ticket:** `command-center#105` (memory spec revision 10, under `command-center#74`)
**Execution context:** `final-verification`
**Instance under test:** the worktree dev server at `http://localhost:3001`, config dir
`<worktree>/.config` — a second CC instance with its own database, transcripts, logs and
api-token, started 2026-09-04T16:41:45Z and restarted once (build
`6bc41991-2026-09-04T16:53:31.425Z`) after the remediation in §1.2. CLI: that server's own
`.config/bin/cctl`, run through a wrapper that strips the ambient workflow identity. The
managing instance on `:3000` was never used for state.
**Scratch project:** `plc-test-lab`. **Sessions:** `mnemo-alpha` (Claude), `mnemo-beta`
(Codex), `mnemo-seed` (Claude; the identity every `cctl memory` seeding and maintenance call
ran under, conversation `bb46e693-9433-470e-bc25-c0afd0216caf`).

Everything below was produced by driving the running application — real routes, real LLM
turns, real SQLite — and verified against durable rows, transcripts and the instance's own
logs rather than the screen. The earlier report this one follows is
`docs/reports/2026-09-02-memory-delivery-evaluation.md`; it is not modified.

---

## 0. Criteria at a glance

| # | criterion id | result | section |
|---|---|---|---|
| 1 | `live-claude-first-turn-full` | PASS | §2.1 |
| 2 | `live-claude-delta-after-remote-create` | PASS | §2.2 |
| 3 | `live-claude-quiet-turn` | PASS | §2.3 |
| 4 | `live-rows-advance` | PASS | §2.4 |
| 5 | `live-cross-session-cross-backend-delta` | PASS | §3 |
| 6 | `live-cc-compaction-leaves-delta` | PASS (criterion as repaired 2026-09-04: a Command Center compaction is not a context-loss event — delta on the next turn, runtime identity and resume handle unchanged, reset seam and full-block tests hold for a backend-reported compaction, divergence recorded as an amendment item) | §4, §4.1–§4.3 |
| 7 | `crowded-corpus-fit-at-default` | PASS (rendered and reported) | §5 |
| 8 | `crowded-t2-t3-rerun` | PASS (re-run and reported; 1 of 2 crowded prompts recalled) | §6 |
| 9 | `live-re-lease-shows-claim` | PASS | §7 |
| 10 | `live-index-parity-with-preview` | PASS | §8 |
| 11 | `live-watch-refusal-disclosure-and-recall-log` | PASS | §9 |
| 12 | `report-written` | this document; full-scope run: exactly the four #107 baseline failures | §10, §11 |

No criterion of this context failed, so no remediation task was added against a criterion.
One remediation task was added before any live proof could run (§1.2); it cites no criterion
because it blocked all of them.

---

## 1. Setup

### 1.1 Seed

The committed corpus `docs/fixtures/memory-eval-corpus.json` (15 notes) was seeded through
ordinary `cctl memory create` calls (`--hook-file`, `--body-file`, `--alias`,
`--status-note-file`) between 16:45:21.269Z and 16:45:30.398Z, from the `mnemo-seed`
conversation. Nothing was written to the database directly.

- Ticket `plc-test-lab#1` (id `6b5e30ae-a27b-40c3-b21a-77d602530ab0`) created 16:44:50Z.
- The stale-status specimen `ticket88-cursor-darwin-status` was about-linked to `ticket:1`
  (16:45:44Z) and set `--index-mode always --if-revision 1` (revision 2), as in the first
  evaluation, so it holds a slot in an over-budget block.
- 100 procedural filler notes `filler-000..099` (16:45:47.198Z–16:46:52.421Z) to reproduce
  the first evaluation's crowded library, then a second 100 `filler-100..199`
  (17:04:40.482Z–17:05:55.066Z) for the over-budget render in §5.
- Two probe notes were created during the proofs and archived afterwards
  (`delta-probe-7c31`, `xbackend-prop-5590`). Library at the end: 215 active notes
  (1 `always`, 214 `auto`), 2 archived.

Row counts after the corpus seed: `project/lesson/always/active 1`,
`project/lesson/auto/active 114`, 1 alias, 1 link (`about` → ticket `6b5e30ae…`).

### 1.2 Remediation before any proof: Turbopack cut the SDK's managed-settings loader

Every Claude launch on the dev instance was refused with
`Cannot destructure property 'mdm'` from the branch's native-memory launch guard
(`src/lib/agent-backends/claude/native-memory.ts`). Cause: inside the Next dev server
Turbopack dead-code-eliminates the tail of the Claude Agent SDK's managed-settings loader
(the compiled chunk carries a `//TURBOPACK unreachable` marker), so `resolveSettings`
returned `undefined`. The same call works under plain Node 24 and Bun, and main never calls
`resolveSettings`, which is why nothing had caught it. Fix, landed with this context:
`next.config.ts` lists `@anthropic-ai/claude-agent-sdk` in `serverExternalPackages` with a
comment stating the constraint, pinned by `scripts/next-config-server-externals.test.ts`
(green via the registered `test` command with `--require-match`). Verified live: Claude turns
ran after the restart. A temporary probe route used for the diagnosis was deleted.

### 1.3 Conventions used below

- Identifiers: user transcript rows are quoted by their message id prefix; Codex assistant
  rows carry no message id in the transcript and are quoted by row index and timestamp.
- Rows are read from `<worktree>/.config/command-center.db` opened read-only, transcripts
  from `.config/transcripts/<conversation>.jsonl`, log events from
  `.config/logs/sessions/plc-test-lab__<session>/conversations/<conversation>.log` and
  `.config/logs/global.log`.
- The shipped default budget, as the index route reports it: **20480 bytes / 120 hooks**.

---

## 2. Once, then deltas: a live Claude conversation (criteria 1–4)

Session conversation `7ba7ffc3-f611-4616-9c45-0fcef7aeb6fe` (`mnemo-alpha`, Claude). One
`prompt.runtime_create` event for the whole conversation (16:54:20.197Z).

### 2.1 Turn 1 carries the full block — `live-claude-first-turn-full`

User row `cad0ccc7…` (16:54:20.120Z) asked, with tools forbidden, for the opening tag, the
first three lines, the last three lines and the count of dash lines. Assistant row
`2ec16504…` (16:54:31.081Z):

> (1) Opening tag line: `<memory-index>`
> (2) The first three lines after the opening tag:
> ```
> visibility: global + project + session mnemo-alpha
> ## always (1 of 1)
> - ticket88-cursor-darwin-status [project, 8 minutes ago, +308b] Cursor darwin support derives the SDK package from runtime platform+arch; the evidenced-host matrix was removed the day after merge
> ```
> (3) The final three lines before the closing tag:
> ```
> - notepad-feature-roadmap [project, 8 minutes ago, +259b] The feature is named Notepad, never Notebook; slices 1-2 merged, slice 3 capture spec revision 8 signed off
> showing 115 of 115 hooks
> read: cctl memory get <slug> --scope <scope>; search: cctl memory recall '<query>'
> ```

Log: `prompt.memory_delivery_settled {mode: full, entryCount: 115, omittedCount: 0,
bytes: 16556}` at 16:54:24.537Z. The `cctl memory index --full` preview captured for the same
conversation before the turn is 16556 bytes. The body-size marker (`+308b`, `+259b`) is on
every hook line. (The assistant reported 116 dash lines; the block has 115 hook lines — the
model's count, not the block's, is off by one.)

### 2.2 Turn 2 carries a delta naming a note created elsewhere — `live-claude-delta-after-remote-create`

From the `mnemo-seed` conversation: `cctl memory create --slug delta-probe-7c31 …` → note id
`34e57133…`, created 16:55:52.316Z. Alpha's next turn, user row `03fe6258…` (16:55:53.820Z),
assistant row `7fe5349b…` (16:55:56.540Z):

> Yes — this turn carries a `<memory-index-delta>` block:
> ```
> <memory-index-delta>
> since: 2026-09-04T16:54:20.214Z
> ## new or revised (1)
> - delta-probe-7c31 [project, just now] DELTA-PROBE-7C31: the delta probe fixture resolves to the number 4127
> index: showing 116 of 116 hooks
> read: cctl memory get <slug> --scope <scope>; search: cctl memory recall '<query>'; full index: cctl memory index --full
> </memory-index-delta>
> ```

The closing hint names `cctl memory index --full`. Log: `mode: delta, entryCount: 1,
bytes: 358` (16:55:53.897Z); the `cctl memory index` preview captured before the turn is
358 bytes.

### 2.3 A turn with no library change carries one line — `live-claude-quiet-turn`

User row `d38c4041…` (16:56:24.177Z), assistant row `bad9a9a5…` (16:56:26.702Z):

> ```
> <memory-index-delta>no memory changes since your last turn — full index: cctl memory index --full</memory-index-delta>
> ```

Log: `mode: delta, entryCount: 0, bytes: 120`. One line, 120 bytes.

### 2.4 The rows advance as the spec states — `live-rows-advance`

`memory_index_delivery_state` for `7ba7ffc3…`, read after each turn:

| after | last_full_at | last_delivery_at | index watermarks |
|---|---|---|---|
| turn 1 (full) | 2026-09-04T16:54:20.214Z | 2026-09-04T16:54:20.214Z | 115 rows; specimen `a8dea50d…` revision 2 `status_delivered = 1` |
| turn 2 (delta) | 16:54:20.214Z (unchanged) | 2026-09-04T16:55:53.827Z | 116 rows (+ `delta-probe-7c31` revision 1) |
| turn 3 (quiet) | 16:54:20.214Z (unchanged) | 2026-09-04T16:56:24.183Z | 116 rows, `max(updated_at)` unchanged |

Full, then delta, then a quiet turn that advances `last_delivery_at` without writing a
watermark. The row as it stands at the end of the run (after the compaction turn in §4):
`last_full_at 16:54:20.214Z`, `last_delivery_at 17:01:42.434Z`, 117 index watermarks with
`max(updated_at) 17:01:42.505Z`.

---

## 3. Cross-session, cross-backend delta — `live-cross-session-cross-backend-delta`

| | Session A | Session B |
|---|---|---|
| Session | `plc-test-lab/mnemo-alpha` | `plc-test-lab/mnemo-beta` |
| Conversation | `7ba7ffc3-f611-4616-9c45-0fcef7aeb6fe` | `7efb998a-a919-463f-acb8-a4567b113f22` |
| Backend | **Claude** | **Codex** (thread `01a06d5b-25a7-7671-a887-e09822061e67`) |

**B1 — B's runtime is established by a tool-free turn.** User row `8a1c8a1d…`
(16:58:01.603Z). Log: `prompt.runtime_create {backend: codex}` at 16:58:01.860Z — the only
runtime creation in B's log — then `memory_delivery_settled {mode: full, entryCount: 116,
bytes: 16785}`. B's assistant row 3 (16:58:20.310Z) reproduced its block from
`<memory-index>` / `visibility: global + project + session mnemo-beta` down to
`showing 116 of 116 hooks`; the 16785 bytes match the preview captured before the turn.

**A — a Claude turn creates the note while B's runtime is alive.** User row `7b69a90d…`
(16:58:54.691Z) instructed A to run one command and then write a long essay with no further
tools. Assistant row `438ac6c8…` is the real `tool_use`:

```
Bash: cctl memory create --slug xbackend-prop-5590 --hook 'XBACKEND-PROP-5590: the cross-backend propagation fixture resolves to the number 9274' …
```

`memory_notes` shows `xbackend-prop-5590` at revision 1, `created_at 16:58:58.028Z`,
authored by conversation A. A's status was `running` at 16:58:59Z and again at 16:59:11Z,
on both sides of B's next turn; its essay row `34e47ee9…` landed at 16:59:47Z.

**B2 — B's next turn answers from the delta with no tool call.** User row `725e5e6a…`
(16:59:00.373Z) asked what number `XBACKEND-PROP-5590` resolves to. Log:
`memory_delivery_settled {mode: delta, entryCount: 1, bytes: 376}` at 16:59:02.931Z. B's
assistant row 8 (16:59:10.212Z):

> 9274
> ```text
> <memory-index-delta>
> since: 2026-09-04T16:58:01.871Z
> ## new or revised (1)
> - xbackend-prop-5590 [project, just now] XBACKEND-PROP-5590: the cross-backend propagation fixture resolves to the number 9274
> index: showing 117 of 117 hooks
> read: cctl memory get <slug> --scope <scope>; search: cctl memory recall '<query>'; full index: cctl memory index --full
> </memory-index-delta>
> ```

**Structural proof of zero tool use.** B's transcript held 10 rows at that point (15 at the
end of the run, after §4) and contains **no `tool_use` block anywhere**. The number 9274
exists nowhere but the hook. Neither runtime restarted: one `prompt.runtime_create` per
conversation in each log, B's Codex thread id unchanged across all three of its turns.

**Watermark rows for B** after B2: 117 `index`-channel rows in `memory_delivery_watermarks`
for `7efb998a…`, `max(updated_at) 16:59:02.930Z`, the specimen's row with
`status_delivered = 1`; `memory_index_delivery_state` `last_full_at 16:58:01.871Z`,
`last_delivery_at 16:59:00.379Z`.

---

## 4. A Command Center compaction is not a context-loss event: the next turn carries a delta — `live-cc-compaction-leaves-delta`

Criterion as repaired by plan repair on 2026-09-04 (charter known ambiguity): compacting a live
conversation through the compact-conversation action is followed by a delta, not a full block,
and the claim is evidenced rather than assumed. The table below is the evidence captured before
that repair (16:59Z–17:02Z); it is unchanged by it and already covers the delta half. §4.1 adds
the no-loss proof from the instance's durable rows and logs, §4.2 the complementary contract for
a backend-reported compaction, and §4.3 the divergence from the governing sources.

Both live conversations were compacted through the compact-conversation action
(`trigger: agent_api` in the audit event) and prompted once more.

| | Session B (Codex) | Session A (Claude) |
|---|---|---|
| Artifact (`context_artifacts`, kind `conversation_compaction`) | `ef253c88-3c7d-4492-bd60-02dfa295e78d`, status `complete`, covered seq 0–8, created 16:59:56.300Z, generation completed 17:00:10.014Z | `4fb6616a-4a49-4081-9f21-8a8c2b619daa`, status `complete`, covered seq 0–37, created 17:01:24.185Z, completed 17:01:41.092Z |
| State row **before** | `last_full_at 16:58:01.871Z`, `last_delivery_at 16:59:00.379Z` | `last_full_at 16:54:20.214Z`, `last_delivery_at 16:58:54.698Z` |
| Next-turn user row | `eedc87b2…` 17:00:11.315Z | `909beb57…` 17:01:42.429Z |
| Delivery event | `mode: delta, entryCount: 0, bytes: 120` (17:00:13.886Z) | `mode: delta, entryCount: 1, bytes: 381` (17:01:42.507Z) |
| Transcript tag | row 13 (17:00:19.808Z): `<memory-index-delta>no memory changes since your last turn — full index: cctl memory index --full</memory-index-delta>` | row `ce1ba515…` (17:01:45.318Z): `<memory-index-delta>` / `since: 2026-09-04T16:58:54.698Z` / `## new or revised (1)` / `- xbackend-prop-5590 [project, 2 minutes ago] …` / `index: showing 117 of 117 hooks` / … `</memory-index-delta>` |
| State row **after** | `last_full_at 16:58:01.871Z` (unchanged), `last_delivery_at 17:00:11.320Z` | `last_full_at 16:54:20.214Z` (unchanged), `last_delivery_at 17:01:42.434Z` |
| Watermarks | 117 rows, `max(updated_at)` still 16:59:02.930Z | 116 → 117 rows (the note A itself created in its previous turn, after that turn's block had been composed) |

No `prompt.memory_delivery_reset` event was written for either conversation; compaction
changed neither `last_full_at`, and each next turn was the ordinary delta. A's delta is a
useful detail: the note it created in its own previous turn was delivered to it one turn
later, because the block is composed before the turn runs.

### 4.1 No loss across the compaction: runtime identity and resume handle unchanged

Read after the fact from the instance's durable rows and logs, through production paths and
not from the screen: `.config/command-center.db` opened read-only, the per-conversation logs
under `.config/logs/sessions/plc-test-lab__<session>/conversations/`, and the transcripts under
`.config/transcripts/`. Every datum below was still held by the instance; nothing had to be
re-established with a fresh compaction.

| | Session B (Codex, `7efb998a…`) | Session A (Claude, `7ba7ffc3…`) |
|---|---|---|
| Compaction window | artifact `ef253c88…` requested 16:59:56.296Z (`artifact.requested`), generation completed 17:00:10.014Z | artifact `4fb6616a…` requested 17:01:24.182Z, completed 17:01:41.092Z |
| `prompt.runtime_create` events in the conversation log | **1**, at 16:58:01.860Z (`backend: codex, hasResumeRef: false, promptCount: 0`); none after the compaction | **1**, at 16:54:20.197Z (`backend: claude, hasResumeRef: false, promptCount: 0`); none after the compaction |
| Backend runtime identity **before** | `codex-runtime.turn_start` 16:58:03.112Z `isResume: false, threadId: null`; `turn_end` 16:58:20.804Z `threadId 01a06d5b-25a7-7671-a887-e09822061e67`; `turn_start` 16:59:01.506Z `isResume: true, threadId 01a06d5b…`; transcript rows 2 and 7 (`system/init`, `thread_id 01a06d5b…`) | transcript row 2 (16:54:24.522Z) `system/init session_id 2a6a015b-ccb7-4abf-9c9c-ea2bce3177bf`; `result` rows 5 (16:54:31.099Z) and 39 (16:59:47.443Z) carry the same `session_id` |
| Backend runtime identity **after** | `turn_start` 17:00:12.452Z `isResume: true, threadId 01a06d5b…`; `turn_end` 17:00:20.462Z `threadId 01a06d5b…`; transcript row 12 (17:00:13.886Z) `system/init thread_id 01a06d5b…`; row 15 (17:00:20.462Z) `result backendRef {backend: codex, ref: 01a06d5b…}` | transcript row 41 (17:01:42.505Z) `system/init session_id 2a6a015b…`; `result` row 44 (17:01:45.343Z) `session_id 2a6a015b…` |
| Stored resume handle, `conversations.backend_ref` (read after the run) | `{"backend":"codex","ref":"01a06d5b-25a7-7671-a887-e09822061e67"}` — `prompt_count 3`, `total_turns 3` | `{"backend":"claude","ref":"2a6a015b-ccb7-4abf-9c9c-ea2bce3177bf"}` — `prompt_count 5`, `total_turns 6` |
| Long-lived backend session | n/a: the Codex runtime object persists and re-attaches to the same thread each turn (`isResume = this.threadId != null` → `codex.resumeThread(…)`, `src/lib/agent-backends/codex/conversation-runtime.ts:347–350`) | one `query-session.created` (16:54:20.205Z, `resume: false`) for the whole conversation; that SDK query session served all five turns, including the post-compaction one, and was closed only by `query-session.idle_timeout` at 17:06:45.351Z (`idleTtlMs 300000`), five minutes after the last turn |
| `prompt.memory_delivery_reset` / `query-session.compact_boundary` events | 0 / 0 | 0 / 0 (and 0 of either in `global.log`) |
| Where the compaction actually ran | `conversation.execute_workflow_task_run.dispatch` 16:59:56.306Z with `conversationId: compaction-ef253c88-3c7d-4492-bd60-02dfa295e78d`; `claude-task-runner.start` `hasResume: false, executionProfile: standard`; `claude-task-runner.complete` `sessionId 2716e0ef-5190-4f77-967d-fbefdaae686c`; lane transcript `.config/transcripts/compaction-ef253c88….jsonl`, 1 row (the structured envelope) | dispatch 17:01:24.189Z with `conversationId: compaction-4fb6616a-4a49-4081-9f21-8a8c2b619daa`; task-runner `sessionId a204cbc4-b0ff-44b9-bdd1-c93e4678c16a`; lane transcript `compaction-4fb6616a….jsonl`, 1 row |

The compaction ran as its own Claude task-runner session (`2716e0ef…`, `a204cbc4…`) in a lane
named after the artifact, writing its own one-row transcript. The target conversation's Codex
thread id, or Claude session id and stored resume handle, is identical on both sides of the
window, and the only runtime creation in either log predates the compaction. The
backend-held context that carried the earlier full block was never discarded, so there was
nothing to re-send. (The other task-runner session in each log, `193001d3…` for A and
`aa2b68ae…` for B, is the first-turn conversation-naming one-shot, `executionProfile:
isolated-one-shot`, and is likewise not the conversation's runtime.)

### 4.2 The complementary contract: a backend-reported compaction resets delivery

Where a loss is real — the backend itself compacted the context — the seam resets index
delivery so the next turn carries the full block. Verified by reading each site on
2026-09-04:

- **Seam:** `resetMemoryIndexAfterBackendCompaction`,
  `src/lib/workflows/conversation/actor-implementations.ts:1247–1264` — calls
  `deps.resetMemoryIndexDelivery(conversationId)` and logs `prompt.memory_delivery_reset`
  with `reason: "backend_compaction"` (`prompt.memory_delivery_reset_failed` on error).
- **In-turn call site:** `actor-implementations.ts:2608–2610` —
  `if (callResult.compacted === true) { await resetMemoryIndexAfterBackendCompaction(deps, input.conversationId); }`;
  the actor result carries `compacted: callResult.compacted ?? false` (`:2770`).
- **External-turn call site:** `actor-implementations.ts:1808–1812` wires
  `onBackendCompaction` into `createExternalTurnHandler`;
  `src/lib/workflows/conversation/external-turn-handler.ts:108–111` enqueues it when
  `event.result.compacted` is true.
- **Where `compacted` comes from:** Claude's query session marks the turn on the SDK's
  `system/compact_boundary` message (`src/lib/agent-backends/claude/query-session.ts:1212–1214`,
  `turn.compacted = true`, logged as `query-session.compact_boundary`) and returns it at
  `:1451`; the Claude runtime forwards `compacted: turnResult.compacted`
  (`src/lib/agent-backends/claude/conversation-runtime.ts:431`, `:708`). Codex
  (`codex/conversation-runtime.ts:594`) and Cursor (`cursor/conversation-runtime.ts:935`,
  `:975`, `:1005`) return `compacted: false`.

Behavior-level tests, all in `src/lib/workflows/conversation/actor-implementations.test.ts`
under `describe("memory index injection")` (`:5196`), over the real store via
`createRealMemoryDelivery(db)`:

- `resets after a Claude turn reports compaction so the next turn receives a full block`
  (`:6391`). The turn returns `{ ...defaultTurnResult, compacted: true }`; the test asserts
  the state row is gone — `expect((await telemetry.readIndexDelivery("conv-1")).state).toBeNull()`
  (`:6432`) — and then, for the next turn (`:6442–6448`):

  ```ts
  expect(lastTurnInput().promptText).toContain("<memory-index>");
  expect(lastTurnInput().promptText).not.toContain("<memory-index-delta>");
  expect(lastTurnInput().promptText).toContain("resend-after-claude-compaction");
  ```

- `resets after an external Claude turn reports compaction so the next user turn receives a full block`
  (`:6454`). An `external_turn_completed` event with `compacted: true` is emitted through the
  runtime's `onExternalTurnEvent`; the test waits for the state row to become null (`:6516`)
  and asserts the same full-block shape on the next user turn (`:6527–6533`), naming
  `resend-after-external-compaction`.

- The counterpart that pins this section's live behavior:
  `keeps delta mode when a Command Center conversation-compaction artifact is created between turns`
  (`:6074`). A `conversation_compaction` row is upserted between two turns; the next turn
  asserts `<memory-index-delta>` present, `<memory-index>` absent, `lastFullAt` unchanged and
  `lastDeliveryAt` advanced (`:6148–6152`).

### 4.3 Divergence from the governing sources

**What the sources say.** Ticket #105 item 2 lists "CC-driven compaction" among the
context-loss events that re-send the full block and asks, as evidence, that "a CC compaction
is followed by a full block". Spec R5 enumerates "a Command Center compaction" among "exactly
these context-loss events"; R5.5 requires that "a Command Center compaction is followed by a
full block on both backends"; D4's chosen approach repeats the enumeration. This charter's
original context-loss vocabulary and known-ambiguity note inherited that premise (charter
amendment log entry 1, 2026-09-04).

**What the action does.** The compact-conversation action creates a `conversation_compaction`
*read* artifact. Its generation runs in a synthetic ephemeral lane —
`conversationId: compaction-<artifactId>` (`src/lib/context-artifacts/service.ts:484`) with
`persistence: "ephemeral"` (`:501`) — and completion writes only the artifact row
(`deps.repo.updateChangedColumns`, `:829`) and one `context_artifact_status` SSE event
(`:847`). `docs/design/conversation-compaction/README.md` ratifies it as a lazy, agent-first
artifact behind the three-tier read contract (§1.2, §1.4); its §7.1 flow ends at
`repo.upsert(status=complete, …)` and `broadcast SSE`. Every production reader of a
`conversation_compaction` row is a read surface: the session info strip, status chip and
artifact panel; `cctl conversation compaction get`; ticket capture
(`src/lib/tickets/service-factory.ts`); the plan-review reviewer context; conversation
naming context; the cross-project list; and the `#`-ref enrichment schema. No module under
`src/lib/memory`, `src/lib/prompt` or `src/lib/workflows/conversation` reads context
artifacts (grep, 2026-09-04). §4.1 shows the consequence live: runtime, resume handle and
backend-held context all survive the action.

**Why a reset would be wrong.** Resetting delivery state on the artifact would re-send the
full block (16556 and 16785 bytes for the two live conversations) to a conversation that lost
nothing. That is the per-turn cost item 2 exists to remove, and D4's rejected turn-count
fallback names the same outcome — it "re-sends blocks to conversations that never lost
them". It would recur on every refresh: the status chip's `Stale`/`Outdated` states and the
`Refresh context artifact` action (README §12.2; `SessionActionsMenu.tsx:71–72`;
`ContextArtifactPanel.tsx:81–87`, forcing when outdated; `cctl` prints `refresh with: …` at
`src/cli/commands/conversation.ts:893–894`) invite re-compaction on precisely the long
conversations this change targets.

**What the premise actually describes is covered.** A compaction the backend performs — a
Claude `/compact` turn or SDK auto-compaction — reaches the seam as `compacted: true` and
resets delivery through `resetMemoryIndexAfterBackendCompaction` (§4.2), so the next turn
carries the full block. Codex and Cursor report none, and the delta's closing
`cctl memory index --full` hint is the one-call recovery the spec already provides for a
loss Command Center cannot observe.

**Amendment item (operator-facing).** For spec R5, R5.5 and D4, and for ticket #105 item 2:
strike "a Command Center compaction" / "CC-driven compaction" from the context-loss
enumeration and from the R5.5 evidence sentence, leaving "a runtime created without a resume
handle" and "a backend-reported compaction where the backend exposes one"; optionally state
that a Command Center compaction is followed by a delta, as pinned by the test at `:6074`.
No context in this run amended the spec or the ticket, and no production reset is wired for
the artifact; this report is the record, carrying the evidence in §4, §4.1 and §4.2.

---

## 5. The crowded corpus at the shipped default budget — `crowded-corpus-fit-at-default`

Project conversation `3a9c0968-4d61-49e1-ace6-5a23685817f1`, `cctl memory index --full`,
both renders at the shipped default (20480 bytes / 120 hooks). Stderr in both: the Cursor
native-memory disclosure line (§9.2).

| library | bytes | hooks | omitted | omission line | corpus slugs carried (of 15) |
|---|---|---|---|---|---|
| 115 notes (corpus + `filler-000..099`), 17:03:41Z | 16650 | 115 (`always 1 of 1`, `auto 114 of 114`) | 0 | `showing 115 of 115 hooks` | **15 / 15** |
| 215 notes (+ `filler-100..199`), 17:06:08Z | 16698 | 120 (`always 1 of 1`, `auto 119 of 214`) | 95 | `showing 120 of 215 hooks — 95 omitted over budget. If this turn touches something not listed above, search first: cctl memory recall '<topic>' (full list: cctl memory list)` | **1 / 15** — `ticket88-cursor-darwin-status` only (index mode `always`) |

At 215 notes the 14 `auto` corpus lessons were all evicted: the `auto` section fills by
recency and every `filler-1xx` note is newer than the corpus. The hook cap bound first — the
120-hook render is 16698 bytes against a 20480-byte budget (this corpus averages about 139
bytes per hook line), so raising the byte budget alone would not have changed the outcome.
Both renders were quoted in full in `.cc/temp/crowded-full-115.txt` and
`.cc/temp/crowded-full-215.txt` during the run.

The first evaluation's crowded block, for comparison, was 12280 bytes / 67 hooks with 52
omitted at the old default; the same 115-note library now fits with nothing omitted.

---

## 6. T2 and T3 re-run under the instruction-form omission line — `crowded-t2-t3-rerun`

**Setup.** The evaluation's T2 and T3 prompts, verbatim, each as a fresh project
conversation created by `POST /api/projects/plc-test-lab/prompt` on the dev instance, Claude
backend, tools allowed. Each pair was run twice: once against the 115-note library (the block
carries every corpus lesson, nothing omitted) and once against the 215-note crowded library
(120 of 215 hooks, 95 omitted, none of the 14 `auto` corpus lessons in the block, the
omission line as quoted in §5). Grading as before: a **hit** names the corpus lesson's root
cause *and* its confirming action.

| prompt | text |
|---|---|
| T2 | *A vitest run in the Command Center repo reports 0 test failures but dies with `Timeout calling "onTaskUpdate"`. Is the branch broken? What do you check first? Answer in at most 6 lines.* |
| T3 | *In Command Center, a `min-h-full` Tailwind utility has no effect on an element inside the document editor, and the jsdom test asserting it passes. Why, and how do you confirm it? Answer in at most 6 lines.* |

**Results.**

| library | task | conversation | first-turn block (log) | tool calls from the transcript | `cctl memory recall` present | names root cause + confirming action | verdict |
|---|---|---|---|---|---|---|---|
| 115 notes | T2 | `4270f244-494f-4654-b7a4-d2e5add4b6ae` | full, 115 entries, 16650 bytes | `cctl memory get vitest-ontaskupdate-timeout-swap-thrash …`; `sysctl vm.swapusage` | no (used `get`) | swap thrash, not a branch defect; check `sysctl vm.swapusage`, re-run the file in isolation | **HIT** |
| 115 notes | T3 | `2015bff6-b806-40b8-ab56-07907834e6e8` | full, 115 entries, 16650 bytes | `cctl memory get tailwind-loses-to-legacy-css --scope project …`; `cctl memory recall 'min-h-full document editor prose legacy css jsdom'` | **yes** | layered utility loses to unlayered `.ProseMirror` rule; jsdom cannot see it; measure in a live browser | **HIT** |
| 215 notes (crowded) | T2 | `b7cbd47b-e526-4c28-8c8c-19278f96d21b` | full, 120 entries, 95 omitted, 16710 bytes | `cctl memory recall 'vitest onTaskUpdate timeout reporter'`; `sysctl vm.swapusage; memory_pressure …` | **yes** | memory pressure, not a branch defect; `sysctl vm.swapusage`, re-run in isolation | **HIT** |
| 215 notes (crowded) | T3 | `fa0667df-aed0-4f94-af80-09ead46bacf0` | full, 120 entries, 95 omitted, 16790 bytes | none (0 tool calls) | no | percentage `min-height` against a non-definite parent, or purged class; confirm computed height in a browser | **MISS** |

Per-run measures, from the transcripts' result rows:

| library | task | tool calls | of which memory calls | turns | cost (USD) | output tokens |
|---|---|---|---|---|---|---|
| 115 notes | T2 | 2 | 1 | 3 | 0.285 | 572 |
| 115 notes | T3 | 2 | 2 | 3 | 0.236 | 669 |
| 215 notes | T2 | 2 | 1 | 3 | 0.245 | 663 |
| 215 notes | T3 | 0 | 0 | 1 | 0.205 | 754 |

**Reading.** Against the fitting library both prompts hit, as the first evaluation's
`cc-memory-clean` mode did. Against the crowded library the first evaluation scored 0 / 2 with
zero recall calls; under the instruction-form omission line the T2 run followed the
instruction — its first act was `cctl memory recall`, which found the lesson the block had
evicted — and hit, while the T3 run made no call at all and produced the same textbook wrong
cause the first evaluation recorded. Net: 1 of 2 crowded prompts recalled. The omission line
as an instruction moves behaviour; it does not guarantee it, and the eviction it compensates
for is unchanged by design (this workflow ranks nothing by telemetry and changes no recall
ranking). §11 records this as an observation, not a criterion failure: the criterion asks
that the re-run be recorded.

---

## 7. The status re-lease shows the claim it re-asserts — `live-re-lease-shows-claim`

Specimen row before: revision 2, `status_note_updated_at 2026-09-04T16:45:30.398Z`,
`status_note_review_after 2026-09-18T16:45:30.398Z`. Run at 17:12:25Z from the `mnemo-seed`
conversation; exit 0; stdout, exact (431 bytes):

```
re-asserted: ticket-88 work still unmerged (status as of 26 minutes ago)
status-review-after: 2026-09-18T17:12:28.988Z
ticket88-cursor-darwin-status  project  lesson  active
revision: 3  index-mode: always  updated: just now
hook: Cursor darwin support derives the SDK package from runtime platform+arch; the evidenced-host matrix was removed the day after merge
status: ticket-88 work still unmerged (status as of 26 minutes ago)
```

The status line, its age and the new lease date are printed before anything else. Row after:
revision 3, `status_note_updated_at` unchanged (16:45:30.398Z — the claim's age is preserved,
only its lease moved), `status_note_review_after 2026-09-18T17:12:28.988Z`,
`updated_at 17:12:28.988Z`. The act rides the delta like any revision: alpha's next-turn
preview afterwards opened with `## new or revised (101)` led by the specimen at revision 3
with its `status:` line.

The lease had not lapsed when the act ran. No production surface shortens a status lease
(`create` and `update --status-note` both stamp the 14-day opening lease and the Library
edits the same fields), so withhold-then-restore was not induced live within the run's clock;
it is pinned by the freshness and composer unit tests. The criterion asks for the act's
printed claim, age and lease, which is what is quoted above.

---

## 8. `cctl memory index` matches the Library's Index Preview byte for byte — `live-index-parity-with-preview`

Conversation `7ba7ffc3…` (alpha), whose next turn is due a delta. The Library's Index
Preview reads `GET /api/memory/index?conversation=<id>[&full=true]` and renders
`block.text` into a `<pre>` unchanged, so parity was proven as two byte-exact links: the CLI
against that route, and the Library's rendered text against the response it received.

**CLI vs route, read within the same second** (curl, then CLI, then curl again):

| view | CLI stdout | route `block.text` | identical | sha256 |
|---|---|---|---|---|
| next turn (`<memory-index-delta>`) | 14463 bytes | 14463 bytes | **yes** | `72d31c2d…` |
| full index (`--full`) | 17062 bytes | 17062 bytes | **yes** | `d81fd1b3…` |
| full index, earlier pair (17:11Z) | 17068 bytes | 17068 bytes | **yes** | `468f4e49…` |

**Library rendered text vs the route response it received** (Playwright: split layout →
Memory tab → `index` view; the response captured with `page.waitForResponse` for the same
click; files `.cc/temp/relay-*`):

| view | route `block.text` | rendered `<pre>` | identical | budget label rendered |
|---|---|---|---|---|
| next turn | 14568 bytes | 14568 bytes | **yes** (sha `9a90291b…`) | `delta since 2026-09-04T17:01:42.434Z · 14568 / 20480 bytes · 101 / 120 hooks` |
| full index | 17167 bytes | 17167 bytes | **yes** (sha `9b6025d9…`) | `full index · 17167 / 20480 bytes · 120 / 120 hooks` |

Pairs read across a minute boundary differ by exactly one word per affected line
(`6 minutes ago` vs `7 minutes ago`), as the first evaluation also recorded: the block embeds
relative ages, so byte identity holds within a rendering instant, not across delay. With 200
filler notes created one per second the tick window is dense, which is why the direct
browser-versus-CLI reads (six attempts per view, equal byte counts every time) each differed
by such a word while the two same-instant links above are identical.

---

## 9. Watch refusal, native-memory disclosure, recall log — `live-watch-refusal-disclosure-and-recall-log`

### 9.1 `--kind watch` is refused

```
$ cctl memory link ticket88-cursor-darwin-status --artifact ticket:1 --kind watch
cctl: memory link: --kind "watch" is not one of about, source
hint: run 'cctl --help' or 'cctl <command> --help' for usage
(exit 2)
```

With `--json`:
`{"ok":false,"error":"memory link: --kind \"watch\" is not one of about, source","hint":"run 'cctl --help' or 'cctl <command> --help' for usage"}`.
The `memory_links.kind` column's CHECK constraint on the dev database admits only `about`
and `source`.

### 9.2 The native-memory disclosure renders on both surfaces

Every `cctl memory index` and `cctl memory index --full` run in this report headed **stderr**
with, stdout untouched:

```
native memory still running: Cursor (the Cursor SDK exposes no option that disables its memories; the only memory switch in the package is server-delivered feature config an embedder cannot set)
```

The Memory Library (Playwright snapshot of the Memory tab) renders the paragraph above the
library/index view switch, outside the preview `<pre>`:

> Cursor still runs its own native memory beside this library: the Cursor SDK exposes no
> option that disables its memories; the only memory switch in the package is
> server-delivered feature config an embedder cannot set.

### 9.3 The recall log carries counts and sizes, never content

`cctl memory recall "vitest onTaskUpdate timeout swap thrash"` at 17:13:28Z returned two
notes (`Showing 2 of 2 memory records.`, 847 bytes of stdout). The event in the instance's
`global.log`, exact:

```
{"timestamp":"2026-09-04T17:13:29.159Z","level":"info","module":"memory.recall","message":"memory.recall.query","traceId":"b52eec9f-cf06-43ea-8c88-d536dd199b0b","query":"vitest onTaskUpdate timeout swap thrash","mode":"query","hits":2,"showing":2,"chars":844,"providers":["lexical-fts5"]}
```

Query, mode, hit count (`hits`, `showing`) and pack size (`chars`) — no hook, body or
status-line text. The two hooks and bodies that the CLI printed appear nowhere in the log
line.

---

## 10. Full-scope test suite, run once

`cctl validate run test --scope full --queue-if-busy --json`, run once, after the report's
live sections were settled (run id `vrun-7c329167-2f7d-4e1e-ab49-a61716caf625`). Verdict read
from the JSON envelope, not the exit code: `ok: false`, `validationExitCode: 1`,
`requestedScope: full`, `effectiveScope: full`. Summary lines from the envelope's output:

```
Test Files  4 failed | 1861 passed | 3 skipped (1868)
     Tests  4 failed | 28111 passed | 8 skipped (28123)
  Start at  13:14:16
  Duration  1382.33s (transform 47.44s, setup 146.32s, collect 1146.74s, tests 1565.49s, environment 463.46s, prepare 193.10s)
```

The four failing files, against the charter's baseline convention (ticket `command-center#107`,
measured on branch HEAD `861a8d4c` on 2026-09-03 before the first context ran):

| failing file | assertion in this run | charter baseline entry |
|---|---|---|
| `scripts/validate-cursor-acceptance.test.ts` | `cursor acceptance registered command > is registered in CommandCenter.json with an executable script` — `expected undefined to be defined` | cursor-acceptance command registration |
| `scripts/validation-gate-composition.test.ts` | `registers dedicated typecheck, seams, and build commands` — `expected [ 'format', 'lint', 'typecheck', …(2) ] to deeply equal ArrayContaining{…}` (the diff shows `build` expected and absent) | build command registration |
| `src/lib/shared/tailwind-utility-collisions.test.ts` | `no bare-token className matches a generated utility` — 7 bare classNames | bare utilities in CreateSessionModal |
| `src/lib/workflow-graph/spec-graph-boundary.arch.test.ts` | `allows only the exact launch schema and public admission` — 8 `src/lib/specs/*` imports of graph internals | specs importing graph internals |

Exactly the four inherited failures and no others; none was fixed here, per the charter. No
`Timeout calling "onTaskUpdate"` line and no lone test timeout appear in the output, so the
run is not a swap-thrash artefact (the worktree dev server was stopped part-way through the
run to relieve memory pressure; every live proof had already been captured). No second run
was needed.

---

## 11. Gaps and observations

No criterion of this context failed, so no remediation task was added against a criterion
id. The observations below are recorded with where they sit relative to the charter.

### 11.1 Inside the charter, recorded

- **Crowded T3 did not recall (§6).** The instruction-form omission line was followed on one
  of two crowded prompts. The eviction it compensates for is recency-based by design and this
  workflow's non-goals exclude ranking changes; the observation is data for the evidence-gated
  defaults the spec reserves, not a defect against a criterion.
- **The hook cap binds before the byte budget for this corpus (§5).** 120 hooks of this shape
  cost about 16.7 KB of the 20 KiB budget; a library of longer hooks would hit bytes first.
- **Byte parity is clock-sensitive (§8).** Relative ages in hook lines mean a human comparing
  the preview and the CLI across a minute boundary sees a one-word difference. Both surfaces
  render the same server text; the criterion holds at the rendering instant.
- **A note created during a turn reaches that conversation one turn later (§4).** The block is
  composed before the turn runs, so A's own `cctl memory create` arrived in A's next delta.
- **The governing sources still call a Command Center compaction a context-loss event (§4.3).**
  Recorded as an operator-facing amendment item for spec R5, R5.5 and D4 and for ticket #105
  item 2, carrying the §4.1–§4.2 evidence; no spec or ticket edit and no production reset in
  this run, per the charter.

### 11.2 Outside this charter, out of scope with reason

- **No production path shortens a status lease (§7).** A lease-shortening flag would be a new
  CLI/Library feature; ticket #105 does not ask for one, and the re-lease criterion needs only
  the act's output.
- **`cctl fixture prompt` reports `turn: completed` when the backend refused the launch.**
  Found while diagnosing §1.2 (the refused Claude turns produced no assistant row yet the
  fixture verb reported completion). The fixture CLI is not a memory surface.
- **`cctl dev ensure` without a server name errors** rather than defaulting to the single
  configured server. Dev-server CLI, not memory.
- **Turbopack dead-code-eliminates part of the Claude Agent SDK under `next dev` (§1.2).**
  Fixed here because it blocked every proof, but the mechanism (bundler DCE of a vendored
  SDK's settings loader) is a build-tooling concern beyond the memory spec; the config change
  and its test are the durable record.
