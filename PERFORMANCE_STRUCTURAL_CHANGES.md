> I want to address the root cause of these issues (not paper over the root cause with superficial fixes). What schema changes and other design changes do you recommend to fix these issues and make it less likely for us to hit similar performance pitfalls when implementing new features?

This is the right question to ask. The fixes we've been shipping are correct, but they're all reactions to the same root design choice. Here's my read on the actual root cause and the structural changes I'd make.

## The root cause

There is **one** root cause expressed three ways: **`ManagerState` is modeled as a single nested document, but it's persisted in (and accessed through) a relational store.** Everything else follows from that impedance mismatch:

1. **The document framing makes "whole-state" the default unit of work.** `readState()` / `mutateState` / `mutateSession` hydrate, clone, Zod-validate, and diff the *entire* tree because the mental model is "the state is one object." Focused accessors/setters are the exception you have to remember to reach for — so every new feature defaults to the expensive path until someone notices in the logs. We've been adding focused escape hatches one at a time (`getSession`, `setConversationPendingPromptText`, the lane/envelope setters, `createSessionConversation`), but each is a patch on a default that's wrong for a relational store.

2. **Co-location of hot small fields with cold large blobs on the same row.** The conversation row carries `machine_snapshot` (big) + `pending_queue` (unbounded) + 20 scalars; the session row carries `graph_workflow_execution` (huge) + lanes + envelopes. Because the codec re-serializes *every column* on any write, a one-scalar update pays for the whole row. This is what makes write amplification structural rather than incidental.

3. **Unbounded collections live inline in those blobs** (`history[]`, artifacts, `pending_queue`, `failureHistory`, `collaborationContinuations`). Append-only data in a full-rewrite column is O(n²) over the entity's life.

## What I'd change structurally (in priority order)

**1. Make the column the unit of persistence, not the row.** The single highest-leverage change: split the per-row codec so each JSON column is written independently and a focused setter for column X never touches column Y. Concretely, `encodeSharedConversationColumns` and the session equivalent should support per-column UPDATEs as the *normal* path, and `mutate*` should diff per-column and only re-serialize columns that actually changed. This kills the "single scalar rewrites `machine_snapshot`" class of bug everywhere at once, instead of one focused setter at a time.

**2. Invert the default: focused-first, whole-state by exception.** `readState()`/`mutateState` should be reserved for the genuinely whole-state callers (startup, discovery, cross-project routes) and ideally renamed/guarded to signal cost. New code should fall into a focused accessor/setter by default. The regression-guard test you already have (`createStateStore-focused-read.test.ts` with the throwing spy aggregate) is the right enforcement mechanism — extend that philosophy so the aggregate is hard to reach accidentally.

**3. Stop inlining unbounded collections — make it a schema rule.** Any field that is append-only or grows with usage (events, transcripts, queues, artifacts, history, failure logs, continuations) belongs in its own child table (`graph_workflow_events`, `conversation_queued_messages`) or an external file (transcripts, collab artifacts) — never an array inside a blob column. This is a *typing/review* rule: a Zod array/record inside a persisted blob should trigger the question "can this grow unbounded?" The `graph_workflow_events` table is the canonical template to copy.

**4. Normalize the two remaining mega-blobs into real columns/tables where they're queried.** `graph_workflow_execution` is the worst offender: it mixes run-immutable definition (`workingDefinition`, `charter` — write once) with hot runtime state (`contextStates`, counters) and unbounded logs (`failureHistory`). Split it: immutable definition written once; runtime control-state in focused-writable columns or a child table; logs in `graph_workflow_events`. Then the 1s poll loops can `json_extract` a status instead of hydrating the whole session.

**5. Separate "durable record" from "hot operational state."** Transcripts and collab artifacts already proved the pattern: large append-only content goes to files keyed by id, the DB keeps a pointer + bounded metadata, and the read boundary re-hydrates. Make that an explicit architectural tier rather than a per-feature decision.

## How this prevents *future* pitfalls

The durable win isn't the individual table splits — it's changing the **defaults and the review gates** so the cheap path is the path of least resistance:

- **Default-focused persistence** means a new feature has to *opt into* whole-state cost, not opt out of it.
- **Per-column writes** mean adding a new blob column to an existing row no longer taxes every other write to that row.
- **The "no unbounded array in a blob" rule**, enforced at schema-design/review time (and ideally by a lint/test that flags `z.array`/`z.record` inside a persisted-blob schema), catches the next `pending_queue` before it ships.
- **The PERFORMANCE.md patterns + the throwing-spy regression test** already encode the rules; the missing piece is making the *aggregate path itself* the thing you have to justify reaching for.

One honest caveat: items 1 and 4 are larger refactors than the focused fixes we've been landing, and they touch the diff/commit and atomicity machinery (e.g. the graph-workflow events+execution single-transaction guarantee). They're worth doing, but they should be sequenced and tested carefully — not bundled into a single sweep. If I had to pick the one change with the best effort-to-payoff ratio, it's **#1 (per-column writes)**, because it neutralizes the entire write-amplification class without requiring every feature to remember a focused setter.
