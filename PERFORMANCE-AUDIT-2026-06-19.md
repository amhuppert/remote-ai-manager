# Performance Audit — 2026-06-19

Systematic audit for the two performance-issue classes we have been fixing:

1. **Unbounded JSON blobs** stored as TEXT columns in `command-center.db` that should be normalized into their own tables or externalized to files.
2. **Read/write amplification** — serializing/deserializing a large amount of data when only a small piece is needed.

**Method:** three parallel read-only audit agents (DB blob inventory, write amplification, read amplification), each grounded in the schema (`state-db.ts` + repo row codecs) and told which items were already fixed so they would not re-report them. Findings below are de-duplicated and ranked, with the headline CRITICAL verified directly against source.

**Already fixed (excluded from findings):**
- `graph_workflow_execution.history[]` → `graph_workflow_events` table; past runs → `graph_workflow_archived_executions` table.
- `workflow_envelopes` collaboration `featureSnapshot.artifacts` → per-workflow JSONL sidecar file.
- `workflow_lanes` / `workflow_envelopes` writes → focused `mutateSessionWorkflowLanes/Envelopes` + `setSessionWorkflowLanes/Envelopes`.
- `graph_workflow_execution` active write → `mutateActiveGraphWorkflowExecution` / `setActiveGraphWorkflowExecution`.
- `createConversation` → `createSessionConversation` focused insert.
- Existing focused setters: `setConversationPendingPromptText`, `setProjectArchived/Pinned`, `setSessionArchived/TddEnabled/Finished`, `setSpawnedFrom`.

---

## Headline insight: convergence

The two hottest data structures in the system each suffer **all three** problems (unbounded blob + write amplification + read amplification) simultaneously. One structural fix per structure pays off multiple ways:

- **The conversation row** — `machine_snapshot` (large) + `pending_queue` (unbounded) + ~20 scalars on one physical row; every per-turn write re-serializes all of it.
- **The `graph_workflow_execution` blob** — still carries unbounded `failureHistory` / `collaborationContinuations`, is whole-rewritten on every workflow step, and is read via full `getSession` in 1-second poll loops.

---

## 🔴 The conversation row — #1 target

`conversations` / `project_conversations` rows co-locate `machine_snapshot` (the full XState persisted snapshot), `pending_queue`, `pending_questions`, the four MCP/capability blobs, and ~14 scalars. Every write routes through `repos.conversations.upsertWithSessionTouch` → `encodeSharedConversationColumns` (`src/lib/state-store/conversation-row-codec.ts:352-389`), which `JSON.stringify`s **every** JSON column regardless of which field changed.

### Finding 1 — `conversations.pending_queue` is an unbounded append-only array — CRITICAL
- **Class:** unbounded blob + write amplification.
- **Schema:** `ConversationState.pendingQueue: z.array(pendingQueuedMessageSchema)` — `conversations-repo.ts:160`; entry schema `message-queue-schemas.ts:27`.
- **Mechanism (verified):** terminal entries (`delivered` / `failed` / `cancelled`) are **never pruned**. All transforms are `queue.map(...)` (status flip in place); append is `appendPendingEntry = [...queue, entry]` (`message-queue-service.ts:57-63`). The only `.filter()`s in the module select active entries *for reading* (`listActiveEntries`, `:66-72`) or extract text — neither prunes the persisted array. Each entry's `content` is `z.array(messageContentBlockSchema)` with **no size bound** and retains **inline base64 image data** (externalized to an `image_ref` only when delivered into the *transcript*, never in the queue row). The whole array is re-serialized on **every** transition (≥2 full-blob writes per message).
- **Mutation sites (8):** `enqueue` `:428`, `claimLiveDelivery` `:509`, `claimNextTurnBatch` `:553`, `markDelivered` `:602`, `markPending` `:649`, `markFailed` `:699`, `cancel` `:738`, `recoverAbandonedDeliveries` `:781` (all `src/lib/conversations/message-queue-service.ts`).
- **Growth:** O(total-messages-ever-queued); multi-MB images retained on delivered entries; O(n)-per-write.
- **Remedy:** normalize into a `conversation_queued_messages` table (one row per entry; status/timestamps as columns; `content` the only blob), and/or prune terminal entries after delivery + externalize image content to `image_ref` at enqueue time. This also removes `pending_queue` as write-amplification collateral for findings 2–4.

### Finding 2 — `syncDerivedFields` per-turn status/totals bundle — HIGH
- **Class:** write amplification. **Call site:** `src/lib/workflows/conversation/manager.ts:725-743` → `mutateConversation(…, "conversation-manager.syncDerived", c => applySyncDerivedFields(context, c))`; pure body `manager.ts:549-583`.
- **Narrow (changes):** ~14 scalars — `status`, `activeTurnSource`, `totalCostUsd`, `totalDurationMs`, `totalTurns`, `contextTokens`, `contextWindowMax`, `promptCount`, `pendingQuestionId` + `pending_questions`/`debug_mode` JSON.
- **Broad (collateral):** `machine_snapshot` (largest), `pending_queue`, `backend_ref`, all four MCP/capability blobs — none touched by the mutator.
- **Frequency:** multiple times per turn (~20 machine transitions). PERFORMANCE.md's historical #1 hotspot (`conversation-manager.syncDerived`, n=217, 782s cumulative before the focused-read work).
- **Remedy:** add a focused setter writing only the ~14 scalars + `pending_questions`/`debug_mode`, skipping `machine_snapshot` / `pending_queue` / MCP blobs. Single biggest write-amplification win.

### Finding 3 — message-queue mutations rewrite the whole row — HIGH
- **Class:** write amplification. **Sites:** the 8 listed in Finding 1, each `mutateConversation(…, c => { c.pendingQueue = … })`.
- **Narrow:** `pending_queue` only. **Broad:** `machine_snapshot` + `pending_questions` + `debug_mode` + MCP/capability blobs + all scalars.
- **Frequency:** ≥2 full-row rewrites per queued turn (`claimNextTurnBatch` on every `idle` entry, then `markDelivered`/`markPending`; `enqueue` per submit).
- **Remedy:** one `mutateConversationPendingQueue` (mirroring `mutateSessionWorkflowLanes`, `setters.ts:517-547`) covering all 8 sites — or made moot by the Finding 1 table normalization.

### Finding 4 — `unread` toggle rewrites the whole row — MEDIUM-HIGH
- **Class:** write amplification. **Sites:** `src/lib/conversations/mark-unread.ts:47-55` (`unread=true`), `:79-87` (`unread=false`); wired `manager.ts:869/896`.
- **Narrow:** single `unread` integer. **Broad:** whole row incl. `machine_snapshot` + `pending_queue`.
- **Frequency:** 2× per turn. PERFORMANCE.md names `conversation.mark-read` as a 3–8s starvation victim.
- **Remedy:** trivial focused setter `UPDATE conversations SET unread = ?`.

### Note — `machine_snapshot` itself is BOUNDED (no action)
The XState `ConversationContext` (`workflows/conversation/types.ts:107`) has no append-only arrays: identity strings, scalar `totals`, single nullable `activeTurn` / `pendingQuestion`, and `lastResult` which is **overwritten each turn**. It does not duplicate the growing transcript (only `transcriptPath`). The one caveat is that each snapshot redundantly carries the *last* turn's full backend transcript (`lastResult.transcript`, tens–hundreds of KB for a heavy `task_run`) — a fixed per-conversation overhead, not unbounded growth. The snapshot write itself (`workflows/conversation/persistence.ts:143-151`, `"conversation-persistence.save"`, debounced 500ms) legitimately must write the big column; a `setConversationMachineSnapshot` would still save re-stringifying the *other* blobs as collateral (lower priority than 1–4).

---

## 🔴 The `graph_workflow_execution` blob — unbounded fields remain + whole-rewrite + full-read

### Finding 5 — `taskStates[*].failureHistory` append-only, never pruned — HIGH
- **Class:** unbounded blob. **Schema:** `graphWorkflowTaskStateSchema.failureHistory: z.array(graphWorkflowTaskValidationFailureSchema).default([])` — `workflows/schemas.ts:796`.
- **Mechanism:** one entry per reopened task per failed validation round (`iteration-orchestrator.ts:754-760`, `:863`); never pruned, no cap. Grows with iteration count × reopened tasks. Lives inside the whole-execution blob re-serialized on every step.
- **Remedy:** cap `failureHistory` (keep last N), or normalize into the existing `graph_workflow_events` table.

### Finding 6 — `collaborationContinuations` append-only, never removed after delivery — HIGH
- **Class:** unbounded blob. **Schema:** `collaborationContinuations: z.record(z.string(), z.array(graphWorkflowCollaborationContinuationSchema))` — `workflows/schemas.ts:1244`.
- **Mechanism:** appended per converged collaboration (`workflow-collaboration-coordinator.ts:119-129`); delivery only flips `deliveredAt` via `.map()` (`iteration-orchestrator.ts:1619`) — entries are never removed. Each carries unbounded `brief` / `finalAnswer` agent prose.
- **Remedy:** remove a continuation once `deliveredAt` is set (it has been consumed), or externalize.

### Finding 7 — whole-execution-blob rewrite on every step (incl. byte-identical events-only writes) — HIGH
- **Class:** write amplification. **Mechanism:** `mutateActiveGraphWorkflowExecution` is focused only w.r.t. the *rest of the sessions row*; it still re-serializes the **entire** `graph_workflow_execution` JSON via `setActiveGraphWorkflowExecution` (`sessions-repo.ts:716-719`, `jsonOrNull(graphWorkflowExecutionSchema.parse(execution))`). That blob (`workflows/schemas.ts:1206-1248`) carries the near-static `workingDefinition` (every context's full `acceptanceCriteria` + every task's full `instructions` prose; changed only at seed and on accepted live edits — see doc 06) + `charter` + `lanePlan` + `sharedDocuments[]` + the growing `failureHistory[]`. Each `mutateActive` also `structuredClone`s the whole execution in memory first (`execution-repository.ts:286`).
- **Narrow (typical change):** one context's `status`/`iterationCount`, one task's `status`+summary, or a counter. Several call sites (e.g. `iteration-orchestrator.ts:1081`, `:1335`) are **events-only** — they rewrite the entire execution column even though `execution === current` (byte-identical).
- **Frequency:** ~3–6 whole-blob rewrites per context iteration + per batch-tick + per status-transition; call sites across `iteration-orchestrator.ts` (`:1556,666,723,821,1081,1189,1254,1335,1610`) and `execution-loop.ts` (`:575,622,720,753,797,890,918,1327,1369,1478,1515,1567`). Hundreds–thousands of whole-blob `UPDATE`s per autonomous run; cost grows superlinearly as `failureHistory`/`taskStates` grow.
- **Remedy:** separate the near-static `workingDefinition`/`charter` from hot runtime state; at minimum, short-circuit the execution `UPDATE` when `execution === current` while still appending events.
- **Caveat (atomicity):** the events-append and execution write share one transaction (`setters.ts:394-409`) so the prev→next diff that generates events stays consistent with the persisted blob. Any split/short-circuit MUST preserve that atomicity.

### Finding 8 — 1-second poll loops hydrate the whole session to read one scalar — CRITICAL
- **Class:** read amplification. **Mechanism:** `getActive()` (`execution-repository.ts:161-167`) calls `getSession()` — which parses the full session blob (already embedding the entire `graph_workflow_execution`) **plus every conversation** (incl. `pendingQueue`) **plus every reference doc** — then discards all but `.graphWorkflowExecution`.
- **Hot callers — `while` loops in `execution-loop.ts`, each `setTimeout(resolve, 1000)` between refreshes:** approval-gate wait (loop `:439`, refresh `:476-482`; uses only `execution.status` and one context's `pendingApproval.decision`), conversation-lock wait (loop `:494`, refresh `:550-556`; uses only `execution.status`), collaboration-progress (`:408`), merge-retry (`:745-768`; reads one context's `mergeStatus`). Fires once per second per parked context. 9 `getActive` sites total.
- **Remedy:** focused accessor reading only the execution blob, or `json_extract(graph_workflow_execution, '$.status')` — the slim list query at `sessions-repo.ts:654` already uses `json_extract`. Also consumed by `execution-route-handlers.ts:469`, `planner-tools.ts`, `mcp-gateway/session-server.ts:99`, so the focused accessor helps per-request paths too.

---

## 🟠 Independent read amplification (per-request)

### Finding 9 — debug-log ingest `readState()` on every probe POST (dead fast-path) — HIGH
- `scanForConversation` (`src/lib/debug-log/ingest-route-handlers.ts:113`) does `readState()` then nested-loops to find one conversation by id. A focused fast-path (`lookupByHints` → `getSession`, `:89-108`) exists but is unreachable because `getDebugLogUrl` (`src/lib/debug-log/service.ts:26-34`) appends only `?conversationId=...`, never the `projectName`/`sessionName` hints. So every accepted probe POST falls through to `readState()` (the agent template fires one `void fetch(...)` per probe hit). Even dropped entries pay the parse.
- **Remedy:** append `&projectName=&sessionName=` in `getDebugLogUrl` to activate the existing path; replace the scan fallback with focused `getConversationById`.

### Finding 10 — per-turn backend-runtime build: 3× `getSession` + 1× `readState` for the same session — HIGH
- `createManagedBackendRuntime()` (`src/lib/workflows/conversation/actor-implementations.ts:1444`), per conversation-runtime start + every model/effort/output-format change: `:1445` `getSession` (objective/tdd); `:1502` MCP compose → `compose-for-conversation.ts:144-149` runs `readSessionOverrides` (`:492` → `getSession`) **and** `readConversationOverrides` (`:500` → `getSession`); `:1529/:1544` capability compose → `agent-capabilities/default-deps.ts:157` → `readOverrideChain` → `readState()`.
- **Remedy:** load session+conversation once at the top and thread through the (DI'd) composers; replace `default-deps.ts:157` `readState()` with a focused project/session read.

### Finding 11 — archived workflow history re-parses every full execution blob to summarize — HIGH
- `listArchivedGraphWorkflowExecutions` (`src/lib/state-store/accessors.ts:456-475`) fetches the lightweight summary list, then re-fetches the **full blob** (`findByExecution`) for each only to feed `summarizeExecution(e, true)` (`execution-route-handlers.ts:603-604`, `:930-939`, per-request GETs). The summary row (`graph-workflow-archived-executions-repo.ts:33-39`) already carries most of what a terminal summary needs.
- **Remedy:** add `definitionId`/`haltReason` to `listSummariesBySession` and build summaries from it; drop the N× full-blob parse.

### Finding 12 — duplicate reads / whole-collection-for-one-item — MEDIUM
- **M1:** duplicate `getConversation` on every conversation-scoped prompt — `prompt/route-handlers.ts:313` then `prompt/sdk-driver.ts:548` re-fetch the same conversation. Thread the parsed conversation through `executePromptStream`.
- **M2:** duplicate `getSession` on cold-conversation first turn — `prompt/route-handlers.ts:305/151` then `manager.ts:463` `defaultLoadActorInput`. Thread via the `actorInput` override hook.
- **M3:** `#`-mention autocomplete `readState()` — `listAllConversations` (`conversations/cross-project-list.ts:80`) whole-state parse per `/api/conversations/all` GET; compose `conversations.findAll()` + `sessions.findAll()` + `getArchivedProjects()` instead.
- **M4:** merge actor loads + sorts all session conversations to read `conversations[0].id` (`workflows/merge/actors.ts:40-48`); add `findLatestActiveConversationId` (`ORDER BY last_activity_at DESC LIMIT 1`).
- **M5:** fork validation parses the entire transcript to range-check an index (`conversations/service.ts:349-357`); add `readConversationMessagesUpTo(path, index)`.

### Finding 13 — PLC sequence number loads all project conversations to count — LOW
- `project-conversations/service.ts:103-104` does `getProjectConversations(projectPath).length + 1`. This is the exact issue just fixed for sessions (`countBySession`). Add `project_conversations.countByProject` (`SELECT COUNT(*)`).
- Note: `getOpenProjectConversationCount` (`service.ts:181-188`) also full-loads for a count but **has no callers** (dead code — wire to a count or remove).

### Startup-only (cold-cache, not per-request)
- **S1:** `rehydrateConversationActors` (`workflows/conversation/manager.ts:1454`, wired `instrumentation.node.ts:62`) `readState()` but uses only project/session/worktree + conversations.
- **S2:** `recover-workflow-envelopes.ts:69` (wired `instrumentation.node.ts:82`) `readState()` but reads only `session.workflowEnvelopes` presence (already in the slim row).
- Both could share a new focused `getAllSessions()` over the already-cached `repos.sessions.findAll()`.

---

## ✅ Checked and clean (do not pursue)

- **`jobs` (`job_records`) / `notifications`** — already per-row tables, not blobs. `job_records` is touched exactly twice per job (insert + one terminal narrow `UPDATE WHERE job_id = ?`); per-tick progress is SSE-only. `notifications` has 7-day retention (`notifications/repo.ts:563`). Their only JSON column (`conflict_files`) is a small bounded string array per row.
- **`workflow_lanes` / `workflow_envelopes`** — `record` keyed by `workflowId` with explicit `delete`; one bounded entry per workflow (the unbounded artifacts stream already moved to the JSONL sidecar).
- **`graph_workflow_execution` other fields** — `contextStates` (fixed at definition time), `laneStates` (≤ 2 × #contexts, shrinks on reset), `executionLanes` (≤ #contexts + 1), `joins` (≈ fan-in points), `pendingMergeRetry` (transient drain queue), `secondaryHaltReasons` (hard cap of 10, `workflow-manager.ts:1484`), `sharedDocuments` (dedup-keyed by `relativePath`). `executionLanes[*].commitSnapshots` is monotonic but commit-bounded with tiny entries (MEDIUM at most).
- **`sessions/service.ts` whole-state mutates** (`createSession`, `rollbackSession`, `retargetOrphanedChildren`, `deleteSession`, `deleteProject`) — genuine structural create/delete/bulk; PERFORMANCE.md lists these as legitimate whole-state callers.
- **MCP config-mutation / scope-stores** — user-initiated config PATCH paths, low frequency; the whole-state `mutateState` in `config-mutation-service.ts` is justified by multi-scope conflict-hash resolution.
- **Genuine whole-state reads** — `instrumentation.node.ts` startup, `projects/discovery.ts:45` discovery, `active-conversations/route-handlers.ts:430` (already uses a 256KB tail-read + LRU, not a full transcript parse).

---

## Recommended order (impact × effort)

1. **Normalize `pending_queue` → `conversation_queued_messages` table** (Finding 1) — the one genuine CRITICAL blob; simultaneously de-amplifies the conversation row.
2. **Focused execution-status accessor for the 1s poll loops** (Finding 8) — `json_extract` precedent exists (`sessions-repo.ts:654`); biggest read win, tightest loop.
3. **`setConversationDerivedFields` + `setConversationUnread`** (Findings 2, 4) — kills per-turn conversation write amplification.
4. **Cap `failureHistory` / prune delivered `collaborationContinuations` + events-only short-circuit** (Findings 5–7), preserving the events+execution transaction atomicity.
5. **Debug-log hints fix (9), per-turn read dedup (10), archived summary (11)**, then the MED/LOW cleanups (12, 13, S1/S2).

All are extend-an-existing-pattern fixes (focused setters, `json_extract` slim reads, normalized child tables, `countBy*`) — the same playbook as the three fixes already landed (graph-workflow history split, focused lane/envelope setters + collab sidecar, focused `createConversation`).
