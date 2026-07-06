## Mission

Design (not yet implement) functionality for Command Center that improves information sharing between conversations, on two fronts:

1. **Efficient conversation reading** — give agents a well-considered way to read another conversation (or just the parts they need) instead of `Read`-ing the whole raw JSONL transcript, which is large and full of tool calls and reasoning.
2. **Lazy message & conversation compaction** — produce durable, agent-optimized distillations of individual messages and whole conversations that agents can read to understand a conversation and decide whether to read the full transcript, and that users can view and reference.

The current deliverable is a detailed design specification at `docs/design/conversation-compaction/README.md`, produced via a two-agent collaboration run and refined against a design review. Status: **Draft for review — not ratified, no implementation yet.**

## Decisions (locked unless Alex reopens)

- **Three-tier read contract**, cheapest-first: pointer (`<conversation-ref/>`) → compaction envelope → windowed raw transcript. Goal: a full-transcript read effectively never happens again.
- **Ship deterministic reading first**, with zero model cost: one pure `renderCompactTranscript` normalizer (drop raw payloads, summarize thinking, one-line tool calls, truncate tool results, **collapse — not drop — `debug_structured`**), shared by BOTH the read endpoint and the compaction pre-strip. Never two normalizers.
- **Entry-level reader** `readTranscriptEntriesWithSeq` (no same-role merging) is required — a merged-message `seqStart` is NOT enough to slice `--seq-range` windows or delta boundaries that fall inside a merged message. The normalizer applies the display-merge itself while keeping per-entry seqs.
- **Dual coordinate system**, carried everywhere: `messageIndex`/`messageId` (logical merged messages, for UI navigation) vs raw JSONL `seqStart`/`seqEnd` + artifact `coveredStartSeq`/`coveredEndSeq` (for slicing, staleness, delta). Distinct CLI/API flags `--message` / `--message-range` / `--seq-range`; no generic `--range`.
- **Compaction format = one agent-first hybrid envelope** (Zod-validated): a prose `agentBrief` + `currentState{status,latestUserGoal,nextBestActions}` + source-anchored `decisions`/`files`/`commands`/`openQuestions`/`blockers` + `omissions` + versioned `extras`. Stable v1 core; fields graduate out of `extras` only when a feature or eval proves them load-bearing (graduation bumps `schemaVersion`). One artifact, agent-optimized; the UI renders the same payload (no separate human format). Source refs are entry-exact with an optional verbatim `quote`.
- **Storage:** dedicated `context_artifacts` table (schema floor), envelope as a JSON column, off the hot conversation row; one rolling conversation artifact per conversation + one per message index; `conversation_id` is globally unique (inherited from the `transcripts/{id}.jsonl` invariant) so single-column uniqueness stands, but handlers verify scope columns; mandatory `assertRoundTripDurability` contract test incl. the JSON payload.
- **Execution:** lazy, user- or agent-triggered, never automatic. Runs as a **self-contained background execution in the context-artifacts service — NOT the jobs table** (the jobs substrate requires `sessionName`/`branchName`, which project-scope conversations lack). The artifact row IS the job record; `context_artifact_status` SSE is the progress channel. Delta refresh over entries `> coveredEndSeq` with deterministic guards; one schema-validation retry then fail.
- **Freshness is derived, not stored**, two orthogonal flags: `stale` (`currentMaxSeq > coveredEndSeq`) and `outdated` (prompt/normalizer/schema version drift). `currentMaxSeq` comes from the entry reader — **never** `getNextAppendSeq()` (it advances the append cache and would corrupt SSE seqs).
- **Model policy:** config-cascade `compaction` block; v1 default = the proven Claude task-runner + `outputFormat: json_schema` path (Sonnet default, recall-first). **GPT-5.5/Codex is a required eval benchmark**, not the v1 wired default. The final default is deferred to eval results. Never default canonical artifacts to a cheap model before evals exist; never use a provider's opaque native compaction as the user-facing artifact.
- **Auth:** GET read/artifact endpoints are un-gated at the existing UI trust boundary (the real reference-documents precedent: un-gated GETs, token-gated mutations; the conversation-messages endpoint already serves full transcripts un-gated). Bearer tokens are validated when present and feed audit/provenance.
- **`cctl conversation` command group** (`read`, `compact`, `compaction get`, `compaction list`) is the load-bearing agent integration; the CLI calls the server API and never parses transcripts locally.
- **`#` reference** stays self-closing `<conversation-ref/>`, enriched with `compact-*` attributes; it advertises the compaction, never inlines its content — agents pull on demand.
- **Structured fields must map to a capability** to earn their place (decisions → Decisions panel/log; files → which-conversation-touched-X; source refs → drill-through + verifiability). Otherwise the info stays in prose.

## Constraints

- Worktree isolation: all work stays in this session's worktree; never touch the main or sibling worktrees.
- Project engineering rules apply to any eventual implementation: red-green TDD; no `any`/`as unknown as`/`@ts-ignore`; Zod-first with `z.infer`; DI over `vi.mock()` for internal modules; method-syntax deps interfaces; persistence tests use the real-store fixture; every state-store repo gets a durability contract test; structured logging via `createLogger`; comments only where code can't convey intent; YAGNI over cleverness.
- Database changes obey the floor-vs-Umzug split and stay additive/forward-compatible (no `KNOWN_SCHEMA_VERSION` bump for this feature).
- Design claims must be verified against the actual code, not assumed — the design review surfaced several precedent/API mismatches (auth precedent, `getNextAppendSeq` mutation, merged-message coordinates) that only checking the source caught.

## Non-goals (v1)

- Automatic/background compaction of all conversations (explicitly lazy-only).
- A separate human-readable format — one agent-first artifact; the UI renders it.
- Persisted segment compactions as a first-class kind (schema stays segment-ready; map-reduce for oversize transcripts is Phase-4/conditional).
- Message- or decision-level `#` autocomplete refs; back-filling `conversations.summary`; cross-instance sharing; multi-user access control beyond the single-user-local baseline.
- Implementation itself — this session's scope is the specification.

## Known ambiguities / open items

- Project-scope conversation routes (session-pathed endpoints need project-scoped analogues) — decide during Phase-1 route wiring.
- Message-artifact refresh semantics (append-only implies message artifacts are effectively always-fresh; confirm no edit/fork path rewrites historical lines).
- `--wait` transport: simple polling of the artifact GET vs long-poll.
- The final compaction model/provider default — intentionally deferred to Phase-6 eval results.

## Relevant sources

- `docs/design/conversation-compaction/README.md` — the design spec (source of truth; registered as a CC reference document).
- `memory-bank/collaboration/296d4991-2bc8-4821-967d-061269faa43e/` — the two-agent collaboration artifact stream (drafts, cross-reviews, resolution, final answer + audit).
- Key existing code the design composes: `src/lib/prompt/transcript.ts` (reader, `getNextAppendSeq`), `src/lib/conversations/message-content-schemas.ts` (content blocks), `src/lib/prompt-editor/` (`#` mention → XML), `src/lib/workflows/conversation/execute-workflow-task-run.ts` (structured one-shot call), `src/lib/jobs/` (session-shaped — deliberately not reused), `src/lib/events/broadcaster.ts` + `src/lib/api/sse-events.ts` (SSE), `src/lib/sessions/reference-documents-route-handlers.ts` (auth precedent), `src/lib/state-store/state-db.ts` (schema floor), `src/lib/config/schemas.ts` (config cascade), `src/lib/notifications/` (React Query template).