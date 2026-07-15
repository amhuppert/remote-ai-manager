# Design Spec: Conversation Reading & Compaction

- **Status:** Implemented. This document is the ratified design record; implementation paths named below are current unless a section explicitly describes an audit-time baseline.
- **Date:** 2026-07-05
- **Source:** Collaboration run `296d4991` (two-agent negotiated design; final agreement, audit in `memory-bank/collaboration/296d4991-2bc8-4821-967d-061269faa43e/round-1/agent_one/final_answer/`)
- **Scope:** Efficient cross-conversation reading for agents + lazy message/conversation compaction, shared with users (UI) and agents (`cctl`).

---

## 1. Overview

### 1.1 Problem

The `#` mention inserts a `<conversation-ref … transcript-path="…" />` XML block that is sent raw to the agent. The agent's only way to consume a referenced conversation is to `Read` the entire JSONL transcript (~700 KB / ~1500 entries for a real conversation, dominated by tool calls, tool results, and thinking). There is no efficient, well-considered way to read a conversation, part of one, or a distilled version of one.

### 1.2 Goals

1. Give agents a **deterministic, windowable, noise-stripped** way to read any conversation (no LLM required).
2. Add **lazy, user- or agent-triggered compaction** of individual messages and whole conversations, producing a durable artifact optimized for agent consumption.
3. Make compactions **viewable in the UI, referenceable via `#`, and pullable/triggerable via `cctl`**.
4. Every extracted claim in a compaction is **anchored to entry-exact transcript coordinates** (raw JSONL entry spans plus an optional verbatim quote — verifiable, drill-through).

### 1.3 Non-goals (v1)

- Automatic/background compaction of all conversations (explicitly lazy-only).
- A separate human-readable summary format (one agent-first artifact; UI renders the same payload).
- Persisted segment compactions as a first-class artifact kind (schema stays segment-*ready*; see §7.4).
- Message-level or decision-level `#` autocomplete refs (`<conversation-message-ref/>`, "copy decision ref") — deferred.
- Back-filling `conversations.summary` from compaction output.
- Cross-instance sharing; multi-user access control beyond the single-user-local baseline (§11).

### 1.4 The three-tier read contract

Agents escalate cheapest-first; a full-transcript `Read` should effectively never happen again:

| Tier | What | Cost |
|---|---|---|
| 0 — Pointer | `<conversation-ref/>` (enriched with compact-artifact availability) | free |
| 1 — Compaction | `cctl conversation compaction get` → structured envelope | one small pull |
| 2 — Windowed raw | `cctl conversation read --message-range / --seq-range …` | bounded slices |

---

## 2. Grounding: existing code this composes

| Piece | Location | Relevance |
|---|---|---|
| Transcript entries + reader | `src/lib/prompt/transcript.ts` (`TranscriptEntry` :38, `readConversationMessagesWithSeq()` :645, parsed cache :609, `getNextAppendSeq()` :178) | Source of truth for messages + coordinates |
| Content blocks | `src/lib/conversations/message-content-schemas.ts:54` (`text/thinking/tool_use/tool_result/command/image*/debug_structured/document_feedback`) | Normalizer input |
| `#` mention → XML | `src/lib/prompt-editor/conversation-mention-node.ts:6` (attrs), `serializer.ts:117` (`renderConversationRefXml` :142), `conversation-ref-parser.ts` | Ref enrichment |
| One-shot structured LLM call | `src/lib/workflows/conversation/execute-workflow-task-run.ts:127` (`ExecuteWorkflowTaskRunInput`: `kind:"task_run"`, `prompt`, `outputFormat`, `timeoutMs`, `modelId`, `effort`; returns `TaskRunResult` with `structuredOutput`) ; `src/lib/agent-backends/claude/task-runner.ts:40` | Generation call |
| Structured-output template | `src/lib/conversation-commands/` (commit-message generation: Zod schema + JSON schema + `safeParse`) | Prompt/validation pattern |
| Background jobs | `src/lib/jobs/` (`backgroundJobSchema` schemas.ts:24 requires `sessionName`/`branchName`) | Session-shaped — explicitly **not** reused; see §7.2 |
| SSE | `src/lib/events/publication.ts` (`publishEvent`/`PublishFn`), `src/lib/api/sse-events.ts` (`SSEEvent` union) | Typed event through the canonical publication seam |
| Agent auth | `src/lib/agent-gateway/token.ts:89` (`createAgentAuth().requireToken(request)`) | Endpoint gating |
| Token-gated route template | `src/lib/sessions/reference-documents-route-handlers.ts` | Route handler shape |
| Schema floor + migrations | `src/lib/state-store/state-db.ts`, `src/lib/state-store/migrations/README.md` | New table |
| Durability backstop | `@/lib/shared/testing/round-trip-durability.ts` (`assertRoundTripDurability`), `@/lib/shared/testing/persistence-fixture.ts` | Contract test |
| Config | `src/lib/config/schemas.ts:59` (`globalConfigSchema`), `cascade.ts` (`mergeConfigWithDefaults`) | Compaction model config |
| React Query template | `src/lib/notifications/{query-keys,queries,mutations}.ts` | Client data layer |
| Message actions UI | `src/components/MessageActions.tsx:29` (rendered via `use-message-row-renderer.tsx`) | Per-message button |
| Conversation menu UI | `src/features/session/conversation/SessionActionsMenu.tsx:37` | Conversation-level action |
| `cctl` | `src/cli/` (`core.ts`, `shared.ts` `cliRequest` :545, `commands/`) | New command group |

---

## 3. Coordinate system (foundational — read first)

`readConversationMessagesWithSeq()` **merges consecutive same-role JSONL entries into logical messages** and returns `seq` = the raw JSONL line index of the **last** contributing entry. Raw line coordinates and logical message coordinates are therefore **two distinct systems**; conflating them breaks anchors, ranges, staleness, and delta refresh.

Every rendered unit and every source ref carries both:

```ts
// src/lib/conversations/schemas.ts (or transcript-render.ts) — new
export const sourceRefSchema = z.object({
  messageIndex: z.number().int(),          // index in the merged visible-message array (UI navigation)
  messageId: z.string().nullable(),        // stable visible-message id when present (TranscriptEntry.id)
  seqStart: z.number().int(),              // first raw JSONL entry (line) supporting the claim
  seqEnd: z.number().int(),                // last raw JSONL entry (line) supporting the claim
  quote: z.string().optional(),            // short verbatim excerpt from the cited span (grounding aid)
});
```

Refs are **entry-exact**: `seqStart`/`seqEnd` cite the specific entries that support the claim — not the whole merged message they belong to. The generation prompt instructs the model to cite the narrowest span (a single entry where possible) and to copy `quote` verbatim from the rendered input; the §7.3 guards check that cited spans fall inside coverage.

Artifact-level coverage uses raw line coordinates: `coveredStartSeq` / `coveredEndSeq`.

**Rules:**
- Staleness = `currentMaxSeq > coveredEndSeq` (raw coordinates). `currentMaxSeq` comes from the parsed transcript itself — the entry reader below returns `maxSeq` alongside the entries. **Never** derive it from `getNextAppendSeq()`: that helper is append-side state whose cached path *advances* the cache (`transcript.ts:178-183`); calling it from a read path would corrupt the seq of subsequently appended entries and their SSE cursor events.
- Drill-through/UI navigation uses `messageIndex`/`messageId`.
- Delta refresh renders raw entries with `seq > coveredEndSeq` only.
- CLI/API expose **distinct** flags: `--message N`, `--message-range A:B`, `--seq-range A:B`. No generic `--range`.

**Required reader change (additive):** add an **entry-level** reader, `readTranscriptEntriesWithSeq(path)`, returning one record per visible JSONL entry — `{ seq, entryId, role, timestamp, content }` — plus the file's `maxSeq`, **without** same-role merging. Merging is lossy for coordinates (`transcript.ts:744` merges consecutive same-role entries and keeps only the last contributing line index), which makes `--seq-range` windows and delta boundaries that fall *inside* a merged message unimplementable at message granularity. The normalizer consumes entry records and applies the *same* merge rule itself for display grouping (so `messageIndex` matches the UI), while tracking each entry's exact seq. `readConversationMessagesWithSeq()` and its existing `seq` semantics stay untouched (cursor-based reconnection compatibility); the entry reader shares the same `(mtime,size)` parsed-line cache infrastructure.

---

## 4. Component: deterministic normalizer (`renderCompactTranscript`)

**One pure function, shared by the read endpoint and the compaction pre-strip.** Never two normalizers.

- **Module:** `src/lib/conversations/transcript-render.ts` (+ colocated `transcript-render.test.ts`). Pure: `(entries: TranscriptEntryWithSeq[], opts: RenderOptions) => RenderedTranscript`. No I/O — callers read via the entry-level cached reader (§3). The renderer groups entries into logical messages using the same merge rule as the UI (stable `messageIndex`), but keeps per-entry seqs on every unit, so seq windows and delta boundaries slice exactly even when they fall inside a merged message.

```ts
export const renderOptionsSchema = z.object({
  outline: z.boolean().default(false),                 // TOC mode: user prompts + assistant headlines only
  message: z.number().int().optional(),                // single logical message
  messageRange: z.tuple([z.number().int(), z.number().int()]).optional(),
  seqRange: z.tuple([z.number().int(), z.number().int()]).optional(),
  includeTools: z.enum(["none", "summary", "full"]).default("summary"),
  includeThinking: z.boolean().default(false),
  search: z.string().optional(),                       // regex over text blocks; returns matching units + context
  maxBytes: z.number().int().default(262_144),         // hard output bound; sets truncated=true when hit
  format: z.enum(["json", "markdown"]).default("json"),
});
```

Per-block behavior (defaults):

| Block | Behavior |
|---|---|
| user/assistant `text` | Kept in full (this is the signal). Outline mode: first line / bounded headline. |
| `thinking` | Omitted (`includeThinking=false`). When included: bounded excerpt, flagged. |
| `tool_use` | One line: `⚙ <name>(<primary arg>) — <short input gist>`. `includeTools=none` drops; `full` includes full input JSON (still `maxBytes`-bounded). |
| `tool_result` | Status (`ok`/`error`) + metrics (from `ToolResultMetrics`) + bounded head/tail excerpt + elided-byte count. |
| `command` | Kept as `/name args` one-liner. |
| `image*` | Placeholder `[image <mediaType>]` (never inline base64). |
| `debug_structured` | **Collapsed, not dropped**: one concise structured line/section per phase (these carry hypotheses/evidence/fix results). Excludable via option. |
| `document_feedback` | One-line summary per item. |
| `raw` (entry field) | Never rendered. |

Output shape (json format):

```ts
export const renderedUnitSchema = z.object({
  ref: sourceRefSchema,                // whole-unit span (seqStart..seqEnd of the merged group)
  entrySeqs: z.array(z.number().int()),// exact seq of each entry folded into this unit
  role: z.enum(["user", "assistant", "notice"]),
  timestamp: z.string(),
  lines: z.array(z.string()),          // rendered content lines; block lines carry their entry's seq prefix
});
export const renderedTranscriptSchema = z.object({
  conversationId: z.string(),
  totalMessages: z.number().int(),
  maxSeq: z.number().int(),
  units: z.array(renderedUnitSchema),
  truncated: z.boolean(),
  omissions: z.object({
    thinkingOmitted: z.number().int(),
    toolResultBytesElided: z.number().int(),
    unitsOutsideWindow: z.number().int(),
  }),
});
```

`format=markdown` renders the same data as a compact fenced document with `#<messageIndex> [seq A–B] <role>` headers — for agents that want to read prose directly instead of JSON.

**Performance:** callers use `readConversationMessagesWithSeq()` (existing `(mtime,size)` parsed cache). Rendering is O(window), not O(transcript). No new caches in v1; if profiling shows repeated large renders, add a keyed render cache and record it in `PERFORMANCE.md`.

---

## 5. Component: read API + `cctl conversation read`

### 5.1 Endpoint

```
GET /api/projects/[name]/sessions/[session]/conversations/[conversationId]/read
```

- **Route handler:** `src/lib/conversations/read-route-handlers.ts`; thin re-export from `src/app/api/.../read/route.ts` per structure.md.
- Query params mirror `renderOptionsSchema` (validated with `safeParse`; 400 on violation).
- **Auth:** per the §11 matrix — GET is browser-facing/un-gated at the same trust boundary as the existing conversation messages endpoint (which already serves full transcripts to the UI un-gated); bearer tokens are validated when present and feed the audit log. Project-scope conversations use the analogous project-scoped path (see §16 open item 2).
- Response: `renderedTranscriptSchema` JSON (or `text/markdown` when `format=markdown`).

### 5.2 CLI

New command group `src/cli/commands/conversation.ts`, registered in `core.ts`:

```
cctl conversation read <conversation-id> [--outline] [--message N] [--message-range A:B]
                       [--seq-range A:B] [--include-tools none|summary|full]
                       [--include-thinking] [--search <regex>] [--max-bytes N]
                       [--format json|markdown] [--json]
```

- Identity via existing flag/env resolution (`--project/--session` / `CC_PROJECT/CC_SESSION`); `<conversation-id>` positional (defaults to `CC_CONVERSATION_ID` when omitted — reading *your own* conversation history is valid).
- CLI **never parses transcript files locally**; it calls the endpoint via `cliRequest()` with the standard headers/envelope.
- `--json` wraps in the `{ ok, …, hint }` envelope; the `hint` line suggests the next escalation. After `--outline` the hint teaches the window syntax (`--message-range A:B / --seq-range A:B`) and is compaction-aware: it points at `compaction get` when a complete artifact exists, notes an in-flight generation when one is pending, and otherwise says to create one with `cctl conversation compact <id>` (the CLI consults the artifact listing; on a listing failure it falls back to the fetch wording).
- Range values accept `A-B`, `A,B`, and bare `N` as lenient aliases of the canonical `A:B`; a malformed value gets a teaching 400 issue that also disambiguates `[sN]` seq markers from message indexes, and an empty window reports the conversation's real coordinate bounds.
- Exit codes: standard 0/1/2/3.

---

## 6. Component: `context-artifacts` domain (compaction storage)

New domain `src/lib/context-artifacts/` owning schemas, service, generation, route handlers, and client data layer.

### 6.1 Envelope schema (v1 core)

```ts
// src/lib/context-artifacts/schemas.ts
export const artifactKindSchema = z.enum(["message_compaction", "conversation_compaction"]);

export const decisionSchema = z.object({
  statement: z.string(),
  rationale: z.string().optional(),
  status: z.enum(["proposed", "accepted", "rejected", "superseded"]).default("accepted"),
  sourceRefs: z.array(sourceRefSchema).min(1),
});
export const fileEntrySchema = z.object({
  path: z.string(),
  role: z.enum(["created", "modified", "deleted", "read", "discussed"]),
  details: z.string().optional(),
  sourceRefs: z.array(sourceRefSchema).min(1),
});
export const commandEntrySchema = z.object({
  command: z.string(),
  outcome: z.enum(["succeeded", "failed", "mixed", "unknown"]),
  summary: z.string().optional(),
  sourceRefs: z.array(sourceRefSchema).min(1),
});
export const anchoredNoteSchema = z.object({
  text: z.string(),
  sourceRefs: z.array(sourceRefSchema).min(1),
});

export const compactionEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  kind: artifactKindSchema,
  source: z.object({
    projectName: z.string(),
    sessionName: z.string().nullable(),
    conversationId: z.string(),
    coveredStartSeq: z.number().int(),
    coveredEndSeq: z.number().int(),
    messageCount: z.number().int(),
    sourceHash: z.string(),               // sha256 of the rendered (post-redaction) input
  }),
  agentBrief: z.string(),                  // dense prose handoff — the only prose-heavy field
  currentState: z.object({
    status: z.string(),                    // free-form short state, e.g. "implementation_in_progress"
    latestUserGoal: z.string(),
    nextBestActions: z.array(z.string()),
  }),
  decisions: z.array(decisionSchema).default([]),
  files: z.array(fileEntrySchema).default([]),
  commands: z.array(commandEntrySchema).default([]),
  openQuestions: z.array(anchoredNoteSchema).default([]),
  blockers: z.array(anchoredNoteSchema).default([]),
  omissions: z.object({
    reasoningOmitted: z.boolean(),
    largeToolOutputsElided: z.number().int(),
  }),
  extras: z.record(z.string(), z.unknown()).default({}),
});
export type CompactionEnvelope = z.infer<typeof compactionEnvelopeSchema>;
```

**Field-graduation rule:** new top-level fields (`timeline`, `assumptions`, `userInstructions`, …) live in `extras` until a concrete UI/agent feature or an eval proves them load-bearing; graduating a field bumps `schemaVersion`.

Message-granularity artifacts use the same schema; `source.coveredStartSeq/EndSeq` span that message's contributing lines, and arrays are typically sparse.

### 6.2 Table (schema floor)

New table in `state-db.ts` (structural shape at open time → synchronous floor, `CREATE TABLE IF NOT EXISTS`, idempotent):

```sql
CREATE TABLE IF NOT EXISTS context_artifacts (
  id                         TEXT PRIMARY KEY,
  kind                       TEXT NOT NULL,             -- message_compaction | conversation_compaction
  scope                      TEXT NOT NULL,             -- session | project (mirrors conversation scope)
  project_path               TEXT NOT NULL,
  session_name               TEXT,                      -- NULL for project-scope conversations
  conversation_id            TEXT NOT NULL,
  message_id                 TEXT,
  message_index              INTEGER,
  covered_start_seq          INTEGER NOT NULL,
  covered_end_seq            INTEGER NOT NULL,
  source_hash                TEXT NOT NULL,
  status                     TEXT NOT NULL,             -- pending | complete | failed
  error                      TEXT,
  model_provider             TEXT NOT NULL,             -- claude | codex
  model                      TEXT NOT NULL,
  effort                     TEXT,
  schema_version             INTEGER NOT NULL,
  prompt_version             TEXT NOT NULL,
  normalizer_version         TEXT NOT NULL,
  created_by                 TEXT NOT NULL,             -- user | agent
  created_by_conversation_id TEXT,                      -- set when created_by = agent
  payload_json               TEXT,                      -- CompactionEnvelope; NULL while pending/failed
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_artifacts_conversation
  ON context_artifacts (conversation_id, kind);
CREATE INDEX IF NOT EXISTS idx_context_artifacts_scope
  ON context_artifacts (project_path, session_name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_context_artifacts_conversation_kind
  ON context_artifacts (conversation_id) WHERE kind = 'conversation_compaction';
CREATE UNIQUE INDEX IF NOT EXISTS uq_context_artifacts_message
  ON context_artifacts (conversation_id, message_index) WHERE kind = 'message_compaction';
```

Decisions baked in:
- **One live conversation compaction per conversation** (rolling envelope, §7.4); one per message index.
- **`conversation_id` is a sound global uniqueness key.** Transcripts are already stored globally by id (`transcripts/{conversationId}.jsonl`), so conversation ids must be unique across sessions *and* projects or transcript files would collide — the single-column unique indexes inherit that existing invariant (document it in the repo). The scope columns are still **load-bearing**, not decorative: `idx_context_artifacts_scope` supports cleanup and listing, route handlers verify a fetched row's `scope`/`project_path`/`session_name` match the path params before serving it (no cross-scope id confusion), and repo finders accept scope filters.
- **No FK to `conversations`** — conversations live in two tables (`conversations`, `project_conversations`); cleanup is handled in the conversation-delete service path instead (delete artifacts by `conversation_id`). Note this explicitly in the repo doc comment.
- **Freshness is derived, not stored** — two orthogonal read-time flags: `stale = currentMaxSeq > covered_end_seq` (content advanced; `currentMaxSeq` from the entry reader, §3 — never `getNextAppendSeq()`) and `outdated = prompt_version | normalizer_version | schema_version ≠ current build values` (the generator improved since this artifact was made). `status` covers lifecycle only.
- Payload stays in SQLite (envelopes are a few KB). Revisit file-payload split only if artifacts routinely exceed ~50–100 KB (measured).
- Forward-compatible/additive: no `KNOWN_SCHEMA_VERSION` bump.

### 6.3 Repo + durability contract

- **Repo:** `src/lib/state-store/context-artifacts-repo.ts` — `findByConversation(conversationId)`, `findById(id)`, `findMessageArtifact(conversationId, messageIndex)`, `findByScope(projectPath, sessionName?)`, `upsert()`, `updateChangedColumns()` (per-column writes, per PERFORMANCE.md), `deleteByConversation(conversationId)`, `deleteByScope(projectPath, sessionName?)` (session/project cleanup).
- **Contract test:** `context-artifacts-repo.contract.test.ts` round-trips a maximal fixture through `assertRoundTripDurability`, including the JSON payload (parse → deep-equal). Declare any derived-on-write fields in the policy map.
- Tests needing mutate-then-read-back use `createPersistenceFixture()` (real repos over `:memory:`), never JS-object fakes.

---

## 7. Component: compaction generation pipeline

### 7.1 Flow

```
trigger (UI button | cctl conversation compact | future workflow hook)
  → POST /context-artifacts  (upserts artifact row status=pending, broadcasts SSE, starts the service run)
  → service run: read transcript (entry-level cached reader)
       → renderCompactTranscript(fullOrDeltaWindow, compactionRenderOpts)
       → redact(renderedText)                       (§7.5)
       → build prompt (previous envelope for delta; §7.3)
       → executeWorkflowTaskRun({ kind:"task_run", prompt, outputFormat:{type:"json_schema",schema}, modelId, effort, timeoutMs })
       → compactionEnvelopeSchema.safeParse(result.structuredOutput)   (retry once on schema failure)
       → deterministic guards (§7.3)
       → redact(envelope)                           (defense in depth)
       → repo.upsert(status=complete, payload, coverage, versions)
       → broadcast SSE (complete) 
  on any failure: status=failed + error, SSE
```

### 7.2 Execution host (self-contained — NOT the jobs table)

The merge/commit jobs substrate is session-shaped: `backgroundJobSchema` requires `sessionName` and `branchName` (`src/lib/jobs/schemas.ts:29-31`) and `job_records` declares both NOT NULL (`state-db.ts:285`), while project-scope conversations have neither. Rather than loosen that contract or duplicate lifecycle state, compaction runs as a **self-contained background execution inside the context-artifacts service** — the artifact row *is* the job record (it already carries `status`/`error`/timestamps), and `context_artifact_status` SSE (§9.1) is the progress channel:

- `runCompaction()` in `src/lib/context-artifacts/service.ts`: fire-and-forget async execution started by the POST handler. No `jobTypeSchema` change, no `job_records` row, no `dispatch*` addition.
- Single-flight: in-service in-flight map keyed on `conversationId::kind::messageIndex?` so double-clicks/agent races coalesce onto the running generation (return the existing artifactId).
- Orchestrator owns retries/timeouts (one schema-validation retry, then fail). The model only produces the envelope — no agent bookkeeping.
- If a unified job-history UI later wants compactions listed, introduce a scope-aware job record then — don't force the session shape now.

### 7.3 Prompt + guards

- **Prompt module:** `src/lib/context-artifacts/generation.ts`, mirroring `conversation-commands/generation.ts`. Layout for prompt caching: stable instructions + JSON schema first, dynamic transcript render last.
- Instructions (essentials): extract only what is supported by the rendered transcript; every item in `decisions/files/commands/openQuestions/blockers` MUST cite `sourceRefs` copied from the rendered unit headers; `agentBrief` is a dense handoff for another coding agent (not a polished article); do not invent file paths or command outcomes; unknown → omit.
- **Full run:** input = render of the whole transcript (compaction render opts: `includeTools=summary`, `includeThinking=false`, generous `maxBytes`).
- **Delta run** (existing artifact + transcript advanced): input = previous envelope JSON + render of lines `> coveredEndSeq`; instruction = merge (append/supersede, refresh `agentBrief`/`currentState`, extend coverage).
- **Deterministic guards after parse** (code, not model): coverage extends monotonically; on delta, every previous `decisions[].statement` still present unless its status became `superseded`; all `sourceRefs` fall inside covered range. Guard failure → one retry with the violation named; second failure → fall back to a full (non-delta) run; then `failed`.
- **Oversize input (sequential delta-fold):** when the whole render exceeds the model budget even stripped, the orchestrator splits the transcript into `SEGMENT_WINDOW_BUDGET_BYTES` windows on merged-unit boundaries (`segmentTranscript`) and folds them through the existing delta-merge contract: the first window is a full compaction, each later window a delta whose previous envelope is the prior step's result. Coverage stays anchored at the conversation start and extends monotonically to the last window, so the final envelope covers the whole transcript with the same guards, redaction, and rolling-artifact persistence as a single pass. This composes the delta primitive (§7.4's "segment-ready seam") rather than adding a parallel path — the only new code is the pure segmenter plus the fold loop. A delta refresh whose new-lines window is itself oversize folds only those new lines onto the existing envelope. A **lone message larger than the budget** cannot be split, so it still **fails** with `transcript_too_large_for_single_pass`.

### 7.4 Rolling envelope (segment-ready, not segment-heavy)

v1 persists exactly **one** rolling `conversation_compaction` per conversation, updated in place by delta runs. No persisted segment artifacts. The envelope's `source` block + `sourceHash` + the delta-merge contract are the segment-ready seams; promoting a `conversation_segment_compaction` kind later requires only a new `kind` value and a parent/child column — no redesign.

### 7.5 Redaction

- **Module:** `src/lib/context-artifacts/redaction.ts` — pure, deterministic, pattern-based (AWS keys, bearer/API tokens, PEM blocks, `password=`/`token=` assignments, `ghp_`/`sk-`-style prefixes). Replaces with `[REDACTED:<class>]`.
- Applied to the rendered transcript **before model input** and to the envelope **before persistence**.
- Unit-tested with a fixture corpus; false-positive tolerance is acceptable (a redacted token in a summary is fine; a leaked one is not).

### 7.6 Logging

Per `.kiro/steering/logs.md`: `createLogger("context-artifacts")` (+ `context-artifacts.generation`, `context-artifacts.read`). Key events: `artifact.requested` (kind, trigger, createdBy, conversationId), `artifact.generation.started/completed/failed` (model, durationMs, inputBytes, outputBytes, coverage), `artifact.delta.guard_failed` (violation), `read.served` (window, bytes, truncated), plus the audit events in §11.

---

## 8. Model policy & config

### 8.1 Config surface

Extend `globalConfigSchema` (`src/lib/config/schemas.ts`):

```ts
compaction: z.object({
  backend: agentBackendSchema.default("claude"),
  conversationModel: z.string().default("sonnet"),   // canonical conversation compaction
  messageModel: z.string().default("sonnet"),        // may drop to haiku after evals (§13)
  effort: z.string().default("medium"),
  timeoutMs: z.number().int().default(180_000),
}).default({ …defaults })
```

Merged via `mergeConfigWithDefaults()`; per-project override via the existing cascade. (Per-conversation override is YAGNI for v1.)

### 8.2 Policy (agreed)

- **Default:** Claude with the configured high-recall model remains the product default. Generation nevertheless uses the neutral task-runner boundary and supports any registered backend selected by `compaction.backend`.
- **Schema safety:** the authoritative schema is shared. Claude projects unsupported JSON Schema keywords inside its adapter immediately before SDK handoff; Codex receives the unmodified schema; Zod validates the returned artifact for both.
- **Not provider-locked:** `backend` is config; `model_provider/model/effort/prompt_version/normalizer_version` are stamped on every artifact so eval comparisons are attributable. A default backend/model change still requires the §13 recall evaluation.
- **Never** default canonical artifacts to a cheap model before the eval exists; a cheaper `messageModel` (e.g. Haiku) is adopted only after evals show it preserves decisions/files/commands/blockers + source refs.
- **Never** use a provider's opaque native compaction as the user-facing artifact.

---

## 9. API surface (artifacts)

```
GET    /api/projects/[name]/sessions/[session]/conversations/[id]/context-artifacts          # list (metadata + derived staleness)
POST   /api/projects/[name]/sessions/[session]/conversations/[id]/context-artifacts          # create_or_refresh
GET    /api/projects/[name]/sessions/[session]/conversations/[id]/context-artifacts/[aid]    # full artifact incl. payload
DELETE /api/projects/[name]/sessions/[session]/conversations/[id]/context-artifacts/[aid]
```

- **Route handlers:** `src/lib/context-artifacts/route-handlers.ts`; thin `src/app/api/...` re-exports.
- **POST body:** `{ kind, messageIndex?, mode: "create_or_refresh", wait?: boolean }` → `202 { artifactId, status: "pending" }` (or `200` with the artifact when `wait=true`, bounded by `timeoutMs`). `create_or_refresh` on a fresh artifact is a no-op returning the existing artifact (`hint: "already fresh"`); `--force` / `{ force: true }` regenerates from scratch.
- **List response items:** row metadata + derived `stale: boolean`, `staleBehindMessages: number`, and `outdated: boolean` (generation-version drift, §6.2). `compaction get` responses carry the same flags; the `hint` suggests a refresh for either.
- Zod `safeParse` on all inputs; 400 on violation. Auth per §11.

### 9.1 SSE

The event is part of the `SSEEvent` union (`src/lib/api/sse-events.ts`) and is published through `publishEvent` or an injected `PublishFn` from `src/lib/events/publication.ts`:

```ts
interface ContextArtifactStatusEvent {
  type: "context_artifact_status";
  conversationId: string;
  artifactId: string;
  kind: ArtifactKind;
  status: "pending" | "complete" | "failed";
  messageIndex?: number;
}
```

Client invalidates/patches the artifact queries on receipt (see §12.3; follow `.kiro/steering/data-fetching-and-sse.md`).

---

## 10. `cctl conversation` command group (full surface)

```
cctl conversation read            <id> [read flags — §5.2]
cctl conversation compact         <id> [--message N] [--force] [--wait] [--json]
cctl conversation compaction get  <id> [--message N] [--format json|markdown] [--json]
cctl conversation compaction list <id> [--json]
```

- `compact` → POST create_or_refresh. Without `--wait`: returns `{ ok, artifactId, status:"pending", hint }`. With `--wait`: polls until terminal, returns the artifact.
- `compaction get` → the full envelope (agent Tier-1 pull). `--format markdown` renders the envelope as prose via the pure `compactionEnvelopeToMarkdown` (`src/lib/context-artifacts/render-markdown.ts`); the JSON envelope stays the lossless view (ref quotes). When stale: `ok:true` with `stale:true, staleBehindMessages:N` and `hint: "refresh with: cctl conversation compact <id>"`. When absent: exit 1 with `hint: "create with: cctl conversation compact <id>"`.
- All commands resolve identity from flags/env like existing groups; cross-conversation targets are explicit by id (+ `--project/--session` when outside the caller's scope).
- Update the `command-center:cc-cli` skill docs with the new group and the three-tier escalation guidance (read the compaction first; window the transcript second; full read never).

---

## 11. Access, audit, provenance (single-user-local baseline, explicit)

Server-backed cross-conversation read/compact APIs are a stronger capability than today's path-in-a-prompt, so the posture is explicit even though CC is single-user-local:

1. **AuthN — explicit matrix.** (Corrected precedent: reference-documents is *split* — its GET handlers are browser-facing and un-gated (`reference-documents-route-handlers.ts:32`), only its mutations call `requireToken()` (`:223`).)
   - `GET …/read`, `GET …/context-artifacts`, `GET …/context-artifacts/[aid]` — **browser-facing, un-gated**: the same trust boundary as the existing conversation messages endpoint, which already serves full transcripts to the UI un-gated; gating these would break UI consumption while protecting nothing new. When a bearer token *is* present (cctl always sends one), it is validated — invalid → 401 — and the caller identity feeds the audit log.
   - `POST …/context-artifacts`, `DELETE …/context-artifacts/[aid]` — same shape as the existing UI-facing job-dispatch routes: un-gated for the UI; agent calls arrive with the bearer token plus caller-conversation fields, which are validated and stamped into provenance (`created_by=agent`, `created_by_conversation_id`).
   - If a hard agent/UI split is ever needed (e.g. multi-user), add dedicated token-gated agent routes then; v1 stays consistent with the codebase's actual boundary.
2. **Provenance:** every artifact stamps `created_by` (`user`|`agent`), `created_by_conversation_id`, `model_provider/model/effort`, `prompt_version`, `normalizer_version`.
3. **Audit log:** structured events for cross-conversation access — `audit.conversation_read` and `audit.compaction_triggered` with `{ callerConversationId, targetConversationId, window, trigger }` via `createLogger("context-artifacts.audit")`.
4. **Archived conversations:** readable and compactable (archived ≠ secret); the UI viewer shows the archived badge.
5. **Cross-project references:** allowed (parity with the `#` mention, which already spans projects); audit-logged with both project names.
6. **Redaction** (§7.5) runs before model input and persistence.
7. **Thinking content** never enters artifacts; `includeThinking=true` on reads is available but defaults off and is logged.

---

## 12. UX specification

### 12.1 Per-message compaction

- **Where:** `MessageActions` (`src/components/MessageActions.tsx`), next to Copy/Fork.
- **Gating:** render the action only on assistant messages whose content includes ≥1 `tool_use` block or whose rendered size exceeds ~2 KB (compacting a short message is noise). Threshold is a constant, tuned later.
- **States:** none → `Compact message` (fires mutation; **optimistic pending state on the row immediately** — spinner glyph on the action, per the perceived-responsiveness contract); pending → disabled + spinner; complete+fresh → `View compacted message`; complete+stale (message artifacts go stale only if the message's own lines change — effectively never, given append-only; treat as always-fresh) — n/a; failed → `Compaction failed — retry`.
- **Viewer:** collapsible inline panel (or side sheet on desktop) rendering the envelope: `agentBrief`, then chips/sections for decisions/files/commands, source refs as clickable `#<messageIndex>` links, raw-JSON toggle for debugging. Follows `cc-design-system`; no new global CSS.

### 12.2 Per-conversation compaction

- **Where:** `SessionActionsMenu` (`src/features/session/conversation/SessionActionsMenu.tsx`): `Compact conversation` / `View context artifact` / `Refresh context artifact` (when stale) / `Copy reference`.
- **Status chip** near the message count: `No compact · Compacting… · Fresh · Stale (behind N) · Outdated · Failed`. SSE-driven (freshness flags recomputed on fetch).
- **Viewer:** a dense artifact browser (new feature component, e.g. `src/features/session/conversation/ContextArtifactPanel.tsx`) — sections: Overview (`agentBrief`), Current state + next actions, Decisions, Files, Commands, Open questions, Blockers, Coverage/staleness/omissions footer, provenance line (model, versions, created-by). Every anchored item drills through to the transcript at `messageIndex`. It is intentionally *not* a prose article — it renders the canonical JSON.

### 12.3 Client data layer

`src/lib/context-artifacts/{query-keys,queries,mutations}.ts` on the notifications-domain template. Mutations follow the responsiveness contract: optimistic `pending` artifact row in cache on trigger, reconciled by SSE `context_artifact_status`; `invalidateQueries` alone is never the feedback.

### 12.4 `#` reference enrichment

- `ConversationMentionAttrs` (`conversation-mention-node.ts`) gains: `compactArtifactId`, `compactStatus` (`fresh|stale|none`), `compactCoveredSeq` (`"0..421"`), `compactCreatedAt`.
- `renderConversationRefXml()` (`serializer.ts:142`) emits them as `compact-artifact-id`, `compact-status`, `compact-covered-seq`, `compact-created-at` — **self-closing format preserved; no nested tags**. `conversation-ref-parser.ts` extended additively.
- Autocomplete popup rows show a small badge when a fresh compaction exists.
- **Never inline compacted content into the prompt.** The ref advertises; the agent pulls via `cctl`. Pull-command guidance lives in the cc-cli skill + `hint` fields, not in the XML.

---

## 13. Evaluation plan (gates model/format decisions)

- **Harness:** `evals/context-artifacts/` (script-run, not vitest-gated) over **real CC transcripts** snapshotted as fixtures: short-decision chat; tool-heavy debug; long implementation w/ changed files + tests; user-corrections; stale/failed attempts; huge command output; nested conversation-ref.
- **Metrics:** decision recall; file/path recall; open-question/blocker recall; next-action correctness; source-ref correctness (refs point at lines that actually support the claim); compression ratio; cost; latency.
- **Pass bar:** source-grounded preservation — not summary fluency.
- **Matrix:** Sonnet vs Opus vs Haiku (Claude task-runner) and **GPT-5.5 via Codex backend (required benchmark)**; per prompt_version.
- Defaults in §8 may only change with eval evidence.

---

## 14. Testing strategy

- **TDD throughout** (red-green): failing test first for the normalizer, guards, redaction, repo, route handlers, CLI parsing.
- **Pure-function-first:** `renderCompactTranscript`, delta guards, redaction, staleness derivation, prompt building are pure — table-driven unit tests, zero mocks.
- **DI, never `vi.mock()` for internal modules:** generation service takes `{ executeWorkflowTaskRun, readEntries, now }`-style deps via factory `createCompactionService(deps)` (method-syntax interface). The self-contained run (§7.2) is tested through the service factory with a fake task-run dep — no jobs-queue involvement.
- **Persistence:** repo contract test via `assertRoundTripDurability` (maximal fixture, JSON payload deep-equal); service tests that mutate-then-read use `createPersistenceFixture()`.
- **Route handlers:** request-level tests with real Zod validation + token gate (following reference-documents handler tests).
- **CLI:** `core.ts`-level tests (pure parse → request assembly), matching existing cctl command tests.
- **Live verification** before merge: `cc-live-feature-test` pass — trigger a real compaction on a real conversation, verify DB row + SSE + UI chip + `cctl conversation compaction get` from a second conversation.

---

## 15. Rollout phases

| Phase | Delivers | Depends on |
|---|---|---|
| **1. Deterministic reader** | `transcript-render.ts` (+ entry-level reader `readTranscriptEntriesWithSeq`), read endpoint, `cctl conversation read`, cc-cli skill update | — |
| **2. Artifact substrate** | schemas, `context_artifacts` table + repo + contract test, config block, redaction, generation service + guards + self-contained run (§7.2), SSE event, POST/GET/DELETE endpoints | 1 |
| **3. Message compaction UX** | `MessageActions` button + gating + inline viewer, queries/mutations | 2 |
| **4. Conversation compaction UX** | `SessionActionsMenu` actions, status chip, `ContextArtifactPanel` w/ drill-through, delta refresh path | 2 |
| **5. Sharing surfaces** | `#`-ref enrichment (attrs/serializer/parser/badge), `cctl conversation compact / compaction get / list` | 2 |
| **6. Evals** | harness + fixture corpus + model matrix incl. GPT-5.5/Codex; revisit §8 defaults | 2 |
| **7. (Conditional)** | persisted segment kind; message/decision-level refs; cross-conversation Decisions log | evals/demand |

Sequential delta-fold for oversize transcripts (§7.3) is implemented — a whole-conversation render past the model budget is split into unit-aligned windows and folded through the delta-merge contract; a lone over-budget message still fails with `transcript_too_large_for_single_pass`.

**First milestone (end of Phase 1):** an agent receiving a `#` ref can pull an outline and bounded windows of any conversation with exact coordinates — zero full-transcript reads, zero model cost.

---

## 16. Open items

1. **Message-artifact refresh semantics:** append-only transcripts mean a message's own lines never change; treat message artifacts as always-fresh and expose only `--force` regeneration. Confirm no edit/fork path rewrites historical lines (fork creates a new conversation, so believed safe).
2. **Project-scope conversations:** the read/artifact endpoints above are session-pathed; project-scope conversations need the analogous `/api/projects/[name]/conversations/[id]/…` routes (same handlers, scope-aware context resolution). Decide during Phase 1 route wiring.
3. ~~UI ↔ token-gated routes~~ — **resolved** by the §11 auth matrix: GETs are un-gated at the existing UI trust boundary (the actual reference-documents precedent — un-gated GETs, token-gated mutations); tokens are validated when present.
4. **`--wait` transport:** simple polling of `GET …/context-artifacts/[aid]` vs long-poll — pick the cheaper; no job-status endpoint is involved (§7.2).
5. **Final model default** intentionally deferred to Phase-6 eval results (agreed).
