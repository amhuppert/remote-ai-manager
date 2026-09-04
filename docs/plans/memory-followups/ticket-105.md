<!-- Materialized 2026-09-03 from ticket command-center#105 for the memory-followups graph workflow. Read the live ticket with: cctl ticket get 'command-center#105' -->

Follow-up work on the Command Center memory system after the live evaluation of spec `memory` (revision 5), delivered under ticket command-center#74.

## Context

- Evaluation report: `docs/reports/2026-09-02-memory-delivery-evaluation.md` (§3 corpus evaluation, §6 comparative evaluation, §6.3 eviction finding, §6.4 stale-status probe).
- Design assessment and the decisions below were made in conversation `a85a85c6-fb11-4bf8-a3c7-7eac3d7e026d` in the "Ticket: Memory System Spike" session (attached).
- Working notes: the "Memory system" notepad `e40b72aa-3729-4b1e-8034-6d172103d496`.
- The memory feature is on the ticket-74 session branch only. Migrations 0040–0042 (renumbered by the 2026-09-03 rebase onto main, which brought its own 0038 and 0039) and the `memory_*` tables in the schema floor have not shipped to main, so schema changes below are in-place edits, not compatibility migrations.

## Decisions already made (do not relitigate)

1. Keep the `statusNote` field and its 14-day lease. It exists for perishable caveats that no live artifact answers ("never live-tested", "evals not done", "awaiting a decision"), attached to a durable lesson.
2. Remove watch links entirely. A watch can only fire on a Command Center artifact transition, and any claim such a transition falsifies is a claim about that artifact's state, which agents read live and must not record. As a review trigger for lessons, an artifact transition is a weak proxy; leases are the honest mechanism.
3. Do not change the auto section's ordering to a different static order, and keep the no-telemetry-ranking invariant (spec D5) for now. An over-budget library is handled by a larger budget (item 2), the actionable omission line (item 3), and operator pruning in review (index mode `search-only`, archive, or delete), not by ranking. A per-turn trickle of not-yet-delivered hooks was considered and rejected: keep delivery simple and predictable until evidence shows more is needed.
4. Ticket, merge, and spec status must not be recorded in memory at all; the live artifact answers it. The guidance rewrite (item 4) states this.

## Work items, in priority order

### 1. Remove watch links

Remove the `watch` link kind and everything that exists only for it:

- `--kind watch` and `--watch <note|statusNote>` on `cctl memory link` / `unlink`; the watch target discriminator and observed token on the link row; the watch resolver registry (`src/lib/memory/watch-resolvers.ts`); token comparison in the freshness engine (`src/lib/memory/freshness.ts`); token re-recording in `mark-reviewed`; the ticket-status SSE reaction that exists to re-evaluate watches (`src/lib/memory/sse-reactions.ts`); watch state in the Library artifact chips; watch fields in `memory export`; the help text and the cc-cli skill reference; the eval corpus fixture's watch entries.
- Edit the `memory_links` definition in the schema floor (`src/lib/state-store/state-db.ts`) and migration 0040 in place: drop the `watch` value from the kind check and the watch-only columns. Update the repository contract test's field policy.
- Keep: `about` (relevance cue) and `source` (provenance) links; note-level `reviewAfter` / `expiresAt`; the statusNote lease; the review queue built from leases, expiry, and session promotion. Session-end promotion does not read watch links (verified in `src/lib/memory/session-end.ts`).
- Leave the durable-note review lease default at "never". The 2026-08-30 sweep showed lessons stayed true while status lines rotted; a forced lease on every lesson would refill the review queue with notes that need no attention.
- Spec: amend R2 (drop "optionally one watched artifact"), D2, D6, the links requirement, and the review-queue text (currently "notes whose watched artifact moved").

Evidence: no `watch` symbol remains in `src/lib/memory`, `src/lib/state-store`, `src/cli/commands/memory*.ts`, or the Library components; `cctl memory link --kind watch` is refused as an unknown value; the repo contract test still round-trips every remaining link field.

### 2. Deliver the index once per conversation, then deltas; raise the first-turn budget

Today `buildEffectivePrompt` prepends a freshly composed `<memory-index>` block (default budget 12 KiB / 80 hooks) to every user prompt. Every earlier copy stays in the backend's history until compaction, so a 42-turn conversation carries 42 copies. Claude's native system loads its index once at session start. The comparative evaluation never measured this because every run was a single fresh turn, so its 30% cost premium is a floor.

Live data (managing-server database, conversations since 2026-08-01): 308 conversations, mean 2.4 prompts, 6 with 10+ prompts, 3 with 20+, longest 42; the memory planning conversation reached 25 prompts and ~706k context tokens. The median case is cheap; the long design conversations are where the repetition dominates.

Design:

- **Full block** on the conversation's first turn and after any context loss: a runtime created without a resume handle, CC-driven compaction, or a Claude turn that reports `compacted`. Codex and Cursor runtimes hardcode `compacted: false`, so for them only CC-driven compaction can trigger a re-send; decide whether a turn-count fallback is needed or accept the gap and say so.
- **Delta block** on every other turn: hooks new or revised since the conversation's index-channel watermark; status lines withheld or restored since last delivery (extend `memory_delivery_watermarks` with a status-delivered flag so this transition is detectable); the withheld and omitted counts with their commands. Nothing changed means one line or nothing, following the notepad change-notice precedent (`src/lib/notepads/change-notices.ts`, prepare-then-settle).
- A delta carries only what changed. It never carries hooks that were omitted over budget on an earlier turn; those remain reachable through the omission line's recall instruction (item 3), and the operator shrinks the competing set by pruning.
- Watermarks must be **read before composition** (today they are only written after the turn) and **reset** on the context-loss events above.
- **Budget**: raise the default first-turn budget to roughly 20 KiB / 120 hooks. The operator's existing library is 255 notes with a 21.5 KB, 113-line index; at the current default about 45% of it is omitted from turn one. Spec D4 cites attention loss in the tail at 106 lines, so measure with the crowded corpus before going higher. Together with item 3 and operator pruning, the larger budget is the response to the §6.3 eviction finding.
- `cctl memory index` and the Library Index Preview must distinguish "what the next turn will carry" (possibly a delta) from the full block (`--full` or equivalent), and the byte-identity criteria (R12.2, R13.1) must be restated for both.
- Spec: amend R5, R5.1, R5.2, R10.3, R12.2, R13.1, R15 (watermark schema), and D4.

Evidence: a multi-turn live conversation on Claude and one on Codex where turn 1 carries the full block, turn 2 carries only the delta after a note is created elsewhere, a turn with no library change carries nothing or one line, a CC compaction is followed by a full block, and the watermark rows advance accordingly; the crowded corpus block (§6.3) re-rendered at the new default budget, stating how many of the 15 corpus notes now fit.

### 3. Make the omission line an instruction

Replace the informational closing line (`omitted N over budget: cctl memory list`) with an instruction that names recall first and list second, e.g. "N hooks omitted over budget. If this turn touches something not listed above, search first: `cctl memory recall '<topic>'` (full list: `cctl memory list`)". State the same rule in the advisory contract (item 4): a line at the bottom of a 12 KB block competes with 67 hooks for attention.

This is unproven. The evaluation shows agents ignored the informational line in both crowded runs; it does not show they follow an instruction.

Evidence: re-run the crowded-mode T2 and T3 prompts from evaluation §6.1 as fresh project conversations with the new line and no other change; record whether the agent issues a recall and whether the score moves from 1/3.

### 4. Rewrite the advisory contract; add a memory section to the cc-cli skill

The static contract (`src/lib/memory/advisory-contract.ts`) already covers what arrives, the three verbs, advisory framing, verification, and the capture bar. Add, keeping the whole contract under 300 words:

- the unknown-unknowns rule: omitted hooks exist; if the task touches something not in the block, recall before concluding;
- hook authorship: the hook is the whole index entry, so state the fact, not the topic, and write it to stand alone;
- the body-reading rule: open the body only for the mechanism or an exact command;
- the three index modes and when to use them: `auto` by default, `always` for a trap that bites regardless of task, `search-only` for reference material that should never compete for the block;
- linking: a note about a ticket, spec, or workflow should be `about`-linked so it leads that artifact's index (`cctl memory link <slug> --artifact ticket:<number>`); this is the Command Center-native multiplier and no always-injected text mentions it today;
- the status rule: if a live artifact answers the question, do not record it; if nothing does, put the caveat in the status line, never in the hook; session-lifetime working state is a session-scoped `state` note.

The cc-cli skill (`plugins/command-center/command-center/skills/cc-cli/SKILL.md`) has a hand-written prose section for every command group except memory, which has only the generated command reference. Add a `## cctl memory` section with worked examples for capture, linking, index modes, recall, and status-line maintenance. Update `cctl memory --help` domain context to match.

Evidence: contract word count under 300; the skill section exists and the generated reference still regenerates cleanly (`scripts/cc-cli-skill-reference.ts`); help-registry tests green.

### 5. Body-size marker on index lines

Render a compact marker on an index line only when the note has a non-empty body (for example `+1.2k`), so a line with no marker is visibly hook-only and a marker prices the read. A boolean "has body" marker carries almost no information (all 15 corpus notes have bodies) and an author-declared "hook is complete" flag drifts on every body edit. Account for the marker in the budget fill.

Evidence: composer tests for both shapes; the block stays within budget with markers on every line.

### 6. Status re-lease shows the claim it re-asserts

In the S1 probe (§6.4) a human `mark-reviewed --status` put a false status line back into every conversation's block. With watches removed there is no artifact token to show, so instead: `cctl memory mark-reviewed <slug> --status` prints the status line being re-leased, its age, and the new lease date, so the operator sees exactly the claim they are re-asserting. Same in the Library.

### 7. Log recall misses

Add a structured log event for each recall query with the query, mode, hit count, and pack size (no hooks or bodies), so a replayable corpus of lexical misses accumulates. Spec D5 gates any semantic retrieval on exactly this evidence.

## Out of scope

- Semantic search or embeddings.
- Any ranking signal from telemetry (retrieval counts, expansion counts). Revisit only after the R15 counters hold real data, and only by amending spec D5.
- Re-ordering the auto section by kind, author, or age.

## Notes

- The spec `memory` needs a new revision covering the amendments listed under items 1 and 2 before implementation; the remaining items are implementation-level.
- The two gaps the evaluation recorded (ticket display-number handle, successor pointer on `get`) already appear fixed on the branch; verify rather than re-implement.
