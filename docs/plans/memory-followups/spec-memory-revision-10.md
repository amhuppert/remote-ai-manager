<!-- Materialized 2026-09-03 from `cctl spec show memory --rendered` (revision 10, approved at Design) for the memory-followups graph workflow. The live spec is the source of truth; regenerate rather than edit. -->

# Command Center native memory

- Spec: memory

- Revision: 10

- State: draft

- Authoring stage: design

- Content hash: editable

- Citation contract: 2

- Citation version: 1

- Citation hash: 440955022c9d1a78eb4b713f8a47c4915068ba6da396f8a4b238f65af02c6825

## Problem

<!-- element:memory-sec-problem role:intent_problem -->

Agents working in Command Center rely on disconnected provider-specific memory mechanisms, where enabled: Claude auto-memory (on by default), Codex memories (off by default), and Cursor's memory surface (whose current status is ambiguous). Knowledge captured through one backend is invisible to the others, and invisible to parallel sessions until that mechanism next loads. The 2026-08-30 reconciliation of the live Claude store (247 files) measured the cost of the strongest of those systems: 14 of 16 status-bearing entries falsely claimed work was unmerged, one confidently recorded a design that had been reversed the next day, and 2 files were reachable from no index. It is a write-heavy design with no invalidation mechanism, whose correctness rests entirely on the agent habit of re-verifying before acting. Search-only retrieval additionally suffers unknown unknowns: an agent cannot search for a trap it does not suspect exists. Command Center owns the domain model (tickets, specs, sessions, workflows), the prompt-composition seam, and the shared live state store, and can therefore solve what no per-tool memory can: one current memory, delivered to every backend and every parallel session, kept honest by the artifacts it describes.

## Outcomes

<!-- element:memory-sec-outcomes role:intent_outcomes -->

One Command Center-owned memory system shared by Claude, Codex, and Cursor. Recall costs zero tool calls in the common case (a generated index of dense, fact-bearing hooks, delivered in full once per conversation and kept current by per-turn deltas) and one call otherwise (a bounded recall command). An active project-scope note (or approved global note) captured in one live session reaches every other live conversation whose memory policy is ambient on its next turn, across backends, without a restart. Staleness is handled structurally - perishable status is separated at write time and leased, session-scoped state dies with its session, and maintenance is a pre-computed review queue - rather than by agent discipline; a fact a live artifact answers (ticket, merge, or spec status) is never recorded in memory at all. Alex can inspect and repair exactly what agents are told, down to the exact injected index. Native provider memories are disabled (or their exception disclosed) and replaced by this system; a portable export exists at any time; migrating existing provider memories is a manual, selective agent activity using the ordinary CLI verbs.

## Non-goals

<!-- element:memory-sec-nongoals role:intent_non_goals -->

No knowledge graph, entity extraction, entity tables, or graph traversal as a retrieval path - typed links are progressive disclosure, never the primary mechanism. No embeddings in V1: semantic retrieval stays behind the recall contract and ships only after a replayable corpus of logged lexical misses shows net benefit. No background extraction or consolidation agents in the write path. No per-claim provenance, confidence scoring, or proof pipeline (frictionless capture is the chosen trade). Memory never carries authority: steering, AGENTS instructions, tests, tickets, approved specs, workflow state, and skills own truth, and memory may point at them but not shadow them. No shadow copies of repository facts. No per-memory notifications. No watch links or artifact-state tokens: a claim an artifact transition could falsify is a claim about that artifact's state, which agents read live rather than record. No automatic trickle of previously omitted hooks into later turns and no ranking of the index by telemetry: an over-budget library is handled by the budget, the recall instruction on the omission line, and operator pruning (search-only index mode, archive, or delete), not by delivery heuristics.

## Success measures

<!-- element:memory-sec-success role:intent_success_measures -->

Measured against an evaluation fixture seeded from the real 247-file Claude memory corpus (created through the ordinary CLI verbs) and attachment-derived failure cases: (1) ten named real recall queries resolve in the zero- or one-call path, including an alias query (notebook resolves to the Notepad note) and a symptom query (onTaskUpdate timeout); (2) live cross-session, cross-backend next-turn propagation is demonstrated, not inferred from shared storage; (3) seeded stale status (the reversed ticket-88 design) is withheld from ambient delivery once its lease lapses while its durable lesson remains delivered; (4) the generated index holds each tested budget, with useful-hook and wrong-priming rates logged; (5) comparative runs of representative tasks - no memory, provider-native memory, CC memory - on task success, repeated errors, token cost, recall calls, stale actions taken, and human repair time; (6) in a live multi-turn conversation the full index is injected once and later turns carry only deltas, with the per-conversation token cost recorded beside what per-turn full re-injection would have cost; (7) the crowded-library comparative tasks that missed under the informational omission line are re-run under the instruction form and the outcome recorded.

## Constraints

<!-- element:memory-sec-constraints role:intent_constraints -->

Canonical storage is the CC state store (repositories, migrations, round-trip contract fixtures); SQLite FTS5 is a derived, rebuildable index (ENABLE_FTS5 verified in the current Bun runtime); markdown is the content and interchange format. The dynamic index is composed at the per-turn live-context seam (the renderActiveTicketBlock pattern), never baked into a one-time prompt: a conversation receives the full block on its first turn and on the enumerated context-loss events, and only a delta of what changed on every other turn, so the block is not re-paid on every turn of a long conversation. Context loss is observable only where the backend reports it: Claude reports compaction to Command Center; Codex and Cursor report none today, so a conversation on those backends that compacts internally keeps receiving deltas until a Command Center compaction or a new runtime, and the full-index command every delta names is its one-call recovery. The static advisory contract is the only memory content in the CC-owned governing instruction layer, delivered through each backend's privileged instruction channel as it exists (a true system prompt for Claude; the governing-instructions block for Codex and Cursor), and stays under 300 words. The cctl memory group follows the CLI steering conventions (bounded text defaults, --json envelopes, structured refusals naming the next command). Approvals, sign-off, waivers, and assumption dispositions are human-only Spec Studio acts. Frictionless capture outranks strict provenance (ticket 74 principle). The index budget is attention-bound and applies to the full block, shipping at 20 KiB and 120 hooks (raised from 12 KiB and 80 hooks once the block stopped repeating every turn; the operator's existing 255-note library renders at about 21.5 KB and 113 lines, and the source system's own measurements showed tail attention loss near 106 lines, so the raise is measured against the corpus-seeded fixture rather than sized to the whole library), tuned against that fixture, and configured in global settings only. Slugs are the only agent-facing handle; immutable internal IDs never appear in default text output (decision recorded 2026-08-31).

## Sources and prior work

<!-- element:memory-sec-context role:context -->

Ticket command-center#74 (Memory System Spike) and its four attachments: Claude's self-description of its memory system; the 2026-08-30 measured reflections on that system (mechanics, recall, capture, staleness, index sizing, reconciliation sweep results); a research report on agent memory approaches; and the memoryfields blog post plus HN thread (memory as data, prose over chunked facts, no knowledge graphs). The design was produced by a two-agent collaboration run whose final answer and negotiation audit live at memory-bank/collaboration/e1215313-71c2-48c8-8ada-7501ada21609/round-1/agent_one/final_answer/. The Memory system notepad (e40b72aa-3729-4b1e-8034-6d172103d496) records the staleness, identity, supersession, lease, and ambient-mode clarifications plus the decision to hide IDs from agent-facing output. The live evaluation of the first delivery is docs/reports/2026-09-02-memory-delivery-evaluation.md; ticket command-center#105 records the follow-ups this amendment carries (watch removal, once-per-conversation delivery with deltas, a larger full-block budget, the omission line as an instruction, agent guidance, the body-size marker, status re-lease output, recall-miss logging), decided in the assessment conversation attached to that ticket. Storage, validator-default, statusNote, delivery, and retrieval decisions are recorded as this spec's design-stage decisions.

## R1 — Requirement

<!-- element:memory-req-record-model -->

The system SHALL store memories as Memory Notes: markdown prose records with a one-line fact-bearing hook, a body capped at 8 KiB, a kind (lesson, procedure, or preference at any scope; state at session scope only), flat searchable aliases, an index mode (auto, always, or search-only), a lifecycle (proposed, active, or archived), an optional review lease (reviewAfter) and optional hard expiry (expiresAt), full-snapshot revisions edited by compare-and-swap, and optional supersession lineage where superseding a note atomically archives its predecessor while preserving history and a forward pointer.

- Priority: must

- Risk: medium

### R1.1 — Acceptance criterion

<!-- element:memory-crit-record-roundtrip parent:memory-req-record-model -->

Every persisted Memory Note field round-trips through the state-store repository and its contract fixture; a body over the 8 KiB cap is refused with the limit named.

Validation strategy: test_run

repository round-trip contract test plus size-refusal unit test

### R1.2 — Acceptance criterion

<!-- element:memory-crit-record-cas parent:memory-req-record-model -->

An update stating a stale revision is refused with the current revision named in the refusal; the refused payload is not persisted, the winning revision and all prior snapshots remain readable in history, and restore copies an old snapshot forward as a new head revision.

Validation strategy: test_run

concurrent-edit CAS test over the real store

### R1.3 — Acceptance criterion

<!-- element:memory-crit-record-supersede parent:memory-req-record-model -->

Creating a note with a supersedes reference archives the predecessor in the same transaction; the superseded note is excluded from index and search defaults, remains fetchable, and names its successor.

Validation strategy: test_run

## R2 — Requirement

<!-- element:memory-req-status-note -->

Durable kinds (lesson, procedure, preference) MAY carry one explicitly perishable statusNote line with its own updated-at timestamp and a default 14-day review lease. A statusNote is for a perishable caveat that no live artifact answers (work never live-tested, an evaluation not yet run, a decision awaited); ticket, merge, and spec status are read from the artifact and SHALL NOT be recorded in memory. Freshness SHALL be tracked at two levels with distinct delivery behavior: a review-due statusNote is withheld from ambient delivery while the note's hook and body continue to be delivered; a review-due note (its own reviewAfter passed) is withheld from ambient delivery entirely. Both levels remain searchable and explicitly retrievable and enter the review queue attributed to what went stale; an expired note (expiresAt passed) is excluded from ambient delivery unconditionally. Marking a note reviewed refreshes its review lease; marking its status reviewed refreshes the statusNote's lease and SHALL show the status line being re-asserted, its age, and the new lease date, because a re-lease restores that claim to every conversation's ambient delivery. The session-scoped state kind is wholly perishable and SHALL NOT nest a statusNote.

- Priority: must

- Risk: high

### R2.1 — Acceptance criterion

<!-- element:memory-crit-status-withheld parent:memory-req-status-note -->

A lesson whose statusNote lease has passed renders in the index and in recall with its hook and body but without the stale status line, and the note appears in the review queue attributed to its stale status.

Validation strategy: test_run

### R2.2 — Acceptance criterion

<!-- element:memory-crit-status-reviewed parent:memory-req-status-note -->

Marking the status reviewed refreshes its lease and restores the status line to ambient delivery; the CLI prints and the Library shows the status line, its age, and the new lease date as part of the act; statusNote age is rendered wherever the line is delivered.

Validation strategy: test_run

## R3 — Requirement

<!-- element:memory-req-scopes -->

Memories SHALL be scoped global, project, or exact session incarnation, with visibility as a union: project conversations see global plus project; session conversations additionally see their own incarnation's notes. A narrower scope influences ranking but never silently overrides a broader one, and every delivered note is labeled with its scope and age.

- Priority: must

- Risk: medium

### R3.1 — Acceptance criterion

<!-- element:memory-crit-scope-incarnation parent:memory-req-scopes -->

Session notes bind to the session incarnation, not the reusable name: a later session created with the same name does not see the earlier incarnation's session-scoped notes.

Validation strategy: test_run

### R3.2 — Acceptance criterion

<!-- element:memory-crit-scope-union parent:memory-req-scopes -->

A project conversation's delivery contains global and project notes only; a session conversation's delivery additionally contains its incarnation's notes; conflicting same-topic notes in different scopes are both delivered, each labeled.

Validation strategy: test_run

## R4 — Requirement

<!-- element:memory-req-slug-identity -->

Agents SHALL address memories exclusively by scope-local slugs: immutable internal IDs never appear in default text output or agent-facing help, slug renames keep the old slug as a resolving alias, a bare slug matching several visible scopes returns a bounded labeled disambiguation rather than a silent pick, and server-generated slugs at create are collision-safe within their scope owner. Bare-slug resolution matches active records only; archived notes are addressed through explicit archived filters, so an archived predecessor never disambiguates a bare read. Internal IDs remain canonical in link rows, revisions, delivery watermarks, and --json envelopes.

- Priority: must

- Risk: medium

### R4.1 — Acceptance criterion

<!-- element:memory-crit-slug-hidden-ids parent:memory-req-slug-identity -->

Default text output of the index block and of recall, list, and get contains slugs and no internal memory IDs, while the --json envelope carries both; every memory verb accepts a slug where it accepts an identity.

Validation strategy: test_run

CLI contract test asserting the ID pattern is absent from text output

### R4.2 — Acceptance criterion

<!-- element:memory-crit-slug-disambiguation parent:memory-req-slug-identity -->

A bare slug existing in two visible scopes returns a labeled disambiguation naming each candidate's scope and the exact narrowed command; after a rename, the old slug still resolves via alias.

Validation strategy: test_run

## R5 — Requirement

<!-- element:memory-req-ambient-index -->

Every conversation whose memory policy is ambient SHALL receive a generated memory-index block composed at the live-context seam from live rows, within the globally configured budget, with quota-ordered selection (fresh notes about-linked to the active ticket, spec, or workflow context first, then fresh session notes, then always-indexed notes, then remaining auto notes), withholding expired, archived, proposed, and review-due records — a note whose only staleness is its statusNote is delivered with the stale line withheld — and stating every withheld or omitted count with the exact drill-down command. The full block is delivered on the conversation's first turn and again on exactly these context-loss events: a runtime created without a resume handle, a Command Center compaction, and a backend-reported compaction where the backend exposes one. Every other turn carries only a delta: hooks created or revised since the conversation's index delivery watermark, status lines withheld or restored since then, and the current withheld and omitted counts. A turn with nothing changed carries at most one line. A delta never re-carries hooks omitted over budget on an earlier turn; those remain reachable through the omission line's recall instruction. Every delta closes with a hint naming the full-index command, so a conversation whose context has lost the block (a backend compaction Command Center cannot observe) can restore it in one call on any turn. Each index line carries a compact body-size marker only when the note has a body, so a line without one is visibly the whole note. The omission line SHALL be an instruction, naming the recall command first and the list command second. A small static advisory contract, under 300 words (memory is advisory and point-in-time; verify mutable claims against live artifacts; omitted hooks exist, so recall before concluding when the task touches something not in the block; the hook is the whole index entry and states a fact that stands alone; open a body only for the mechanism or an exact command; the three index modes and when each applies; about-link a note to the ticket, spec, or workflow it concerns so it leads that artifact's index; a perishable caveat goes in the statusNote and never in the hook, and a fact a live artifact answers is not recorded; capture only durable, non-obvious, non-derivable knowledge, or leased session-scoped working state) SHALL be delivered through the CC-owned governing instruction layer, using each backend's privileged instruction channel as it exists, separate from the per-turn block.

- Priority: must

- Risk: high

### R5.1 — Acceptance criterion

<!-- element:memory-crit-index-per-turn parent:memory-req-ambient-index -->

A note created or revised after a conversation's turn N appears in that conversation's turn N+1 delivery as a delta entry without any runtime restart, and an archived note is absent from the conversation's next full block.

Validation strategy: test_run

### R5.2 — Acceptance criterion

<!-- element:memory-crit-index-budget parent:memory-req-ambient-index -->

With a library exceeding the budget, the rendered full block stays within the configured cap, ends with an omission line that states the omitted count as an instruction naming the recall command first and the list command second, and never silently truncates; expired, archived, proposed, and fully review-due records are absent, while a note whose only staleness is its statusNote appears without the stale line.

Validation strategy: test_run, validator_verdict

rendered against the corpus-seeded evaluation fixture at the new default budget, stating how many of the 15 corpus notes fit; the crowded-library `T2` and `T3` comparative prompts from the evaluation re-run as fresh conversations under the instruction form, recording whether a recall is issued

### R5.3 — Acceptance criterion

<!-- element:memory-crit-index-quotas parent:memory-req-ambient-index -->

Quota reservation holds: with a large project and global library, notes linked to the active artifact and fresh session notes still appear in the block.

Validation strategy: test_run

### R5.4 — Acceptance criterion

<!-- element:memory-crit-index-static-contract parent:memory-req-ambient-index -->

Each registered backend's CC-owned governing instruction layer contains the static advisory contract (advisory framing, verification duty, the unknown-unknowns recall rule, hook authorship, the body-reading rule, index modes, artifact linking, the statusNote rule, capture bar) in under 300 words, delivered through that backend's privileged instruction channel as it exists, and the changing index content is absent from that layer.

Validation strategy: test_run

### R5.5 — Acceptance criterion

<!-- element:memory-crit-index-once-then-delta parent:memory-req-ambient-index -->

In a live multi-turn conversation on Claude and one on Codex, turn 1 carries the full block; a later turn after a note is created in another conversation carries only a delta naming that note; a turn with no library change carries at most one line; every delta's closing hint names the full-index command; a Command Center compaction is followed by a full block on both backends, and on Claude a backend-reported compaction is too; and the conversation's index delivery watermarks, including status-delivered state, advance with each accepted delivery and reset on each of those context-loss events.

Validation strategy: test_run, validator_verdict

composer and watermark unit tests over the real store, one per context-loss trigger, plus a live two-backend multi-turn verification read from durable transcripts and watermark rows

### R5.6 — Acceptance criterion

<!-- element:memory-crit-index-body-marker parent:memory-req-ambient-index -->

An index line for a note with a non-empty body carries a compact body-size marker and a line for a body-less note carries none; the block stays within its byte budget with a marker on every line.

Validation strategy: test_run

## R6 — Requirement

<!-- element:memory-req-cross-session -->

A project-scope note captured in one live session SHALL appear in a different live session's next-turn index, including when the two sessions run different agent backends, without either runtime restarting.

- Priority: must

- Risk: high

### R6.1 — Acceptance criterion

<!-- element:memory-crit-cross-session-live parent:memory-req-cross-session -->

In a live two-session run on different backends, a lesson captured mid-flight in session A is present in session B's next generated index and demonstrably usable there without a retrieval call.

Validation strategy: validator_verdict, test_run

live two-session, two-backend evidence; the automated variant covers same-process index rebuild

## R7 — Requirement

<!-- element:memory-req-recall -->

One bounded recall command SHALL serve retrieval: with no query it uses ambient scope plus active-artifact bindings; with a query it searches normalized, stemmed FTS5 over hook, slug, body, and aliases with exact-match boosts for slugs, aliases, paths, symbols, and native artifact handles; with a related-artifact flag it resolves direct about links first. It returns a bounded context pack - full bodies for the best few fresh records, then hooks with exact read commands - ranked by typed about-link match, scope specificity, explicit index mode, and lexical score, with freshness as a gate; retrieval frequency SHALL never affect ranking.

- Priority: must

- Risk: medium

### R7.1 — Acceptance criterion

<!-- element:memory-crit-recall-corpus parent:memory-req-recall -->

Ten named recall queries drawn from the real corpus each place the expected record in the returned context pack in one call, including the alias query (notebook resolves to the Notepad note) and a symptom query matching body text only.

Validation strategy: test_run

fixture seeded from the real corpus through the ordinary create and link verbs

### R7.2 — Acceptance criterion

<!-- element:memory-crit-recall-bounded parent:memory-req-recall -->

Recall output stays within its budget, states showing-N-of-M with the exact narrowing command, and repeated retrieval of one note across many calls produces identical ranking to a never-retrieved equal.

Validation strategy: test_run

## R8 — Requirement

<!-- element:memory-req-links-watch -->

Memory-to-artifact relationships SHALL be typed links (about for deterministic relevance, source for supporting context) resolving immutable native artifact identities; only about links act as relevance cues - source links never affect selection or ranking. There are no watch links and no artifact-state tokens: a claim an artifact transition could falsify is a claim about that artifact's state, which agents read live and never record. Review-queue construction SHALL evaluate every note's review lease and expiry, so a rarely delivered note still surfaces as review-due. Prose mentions may suggest links but never silently create retrieval semantics.

- Priority: must

- Risk: medium

### R8.2 — Acceptance criterion

<!-- element:memory-crit-about-ranking parent:memory-req-links-watch -->

Notes about-linked to the conversation's active ticket occupy the first index section and rank above unlinked lexical matches in related-artifact recall.

Validation strategy: test_run

## R9 — Requirement

<!-- element:memory-req-capture-policy -->

Project and session writes SHALL be one immediate command with server-side validation of shape, scope authority, size, and revision, and with advisory-only assists (lexical overlap candidates, vague-hook warnings) that never block a write. Agent-created global notes SHALL land as proposals excluded from all ambient delivery until a human approves them; human-created notes at any scope are immediate. Archive is the ordinary reversible removal; permanent deletion is a separately confirmed act.

- Priority: must

- Risk: medium

### R9.1 — Acceptance criterion

<!-- element:memory-crit-global-proposal parent:memory-req-capture-policy -->

An agent-created global note lands with lifecycle proposed and appears in no conversation's index or no-query recall on any backend until approved; approval activates it without a rewrite.

Validation strategy: test_run

### R9.2 — Acceptance criterion

<!-- element:memory-crit-advisory-hints parent:memory-req-capture-policy -->

A create overlapping an existing note and carrying a vague hook succeeds while returning the overlap candidates and hook warning as advisory output.

Validation strategy: test_run

## R10 — Requirement

<!-- element:memory-req-execution-policy -->

Memory delivery SHALL be role-conditioned: read policy is off, linked-only, or ambient, with contribution independently on or off. Read policy governs ambient and linked delivery only: explicit retrieval verbs (recall, get, list, index) remain available in every mode as deliberate, transcript-visible acts, and hermetic execution profiles exclude the memory tool surface entirely. When contribution is off, every memory mutation (create, update, link, unlink, mark-reviewed, promote, archive, delete) is refused with a typed refusal naming the policy. Read and contribution policy SHALL participate in the configuration cascade: global settings hold the values for ordinary conversations and the defaults for workflow implementers and validators; a workflow definition may set them; and they can be overridden or reset at the workflow level or for an individual implementer or validator on an execution context. Shipped defaults: ordinary conversations and implementers get ambient read with scoped contribution; validators, adversarial reviewers, collaboration second agents, and hermetic one-shots get off with no contribution; linked-only delivers exactly the notes about-linked to the context under validation. The generated-index budget SHALL be configurable in global settings only, with no more granular override level.

- Priority: must

- Risk: medium

### R10.1 — Acceptance criterion

<!-- element:memory-crit-validator-off parent:memory-req-execution-policy -->

A validator context receives no memory block by default and its memory mutations are refused with the typed policy refusal; a workflow declaring linked-only delivers exactly the about-linked notes for the context under validation and nothing from the ambient index.

Validation strategy: test_run

### R10.2 — Acceptance criterion

<!-- element:memory-crit-policy-cascade parent:memory-req-execution-policy -->

Read and contribution policy resolve through the cascade: the global-settings values apply to ordinary conversations; the global-settings implementer and validator defaults apply to workflow contexts; a workflow-definition policy overrides them for its contexts; an override on an individual implementer or validator of an execution context wins over both; and a reset returns that context to the cascade value.

Validation strategy: test_run

cascade-resolution unit tests over the settings, workflow-definition, and per-context layers, covering read and contribution independently

### R10.3 — Acceptance criterion

<!-- element:memory-crit-budget-global parent:memory-req-execution-policy -->

The index budget ships with a default of 20 KiB and 120 hooks in global settings, is read from global settings, and governs every conversation's full block; no per-project, per-workflow, or per-conversation budget override surface exists.

Validation strategy: test_run

config-schema default test plus the existing cascade tests proving no narrower override level

## R11 — Requirement

<!-- element:memory-req-session-end -->

When a session completes, its session-scoped state notes SHALL archive automatically, and its remaining durable session notes SHALL become promotion candidates surfaced through a compact count on the session completion surface, a Memory Library badge, and a prefiltered review queue. Promotion is one operation that creates a project-scope note superseding the session note, both revision histories preserved, optionally rewriting the content in the same act; a promotion that collides with an existing active project slug or alias is refused with the collision named, prompting an explicit slug choice - no silent suffixing or overwrite. No notification is emitted initially; promotion-candidate and promoted counts are logged so a notification can be added if the passive affordance is measurably missed.

- Priority: must

- Risk: medium

### R11.1 — Acceptance criterion

<!-- element:memory-crit-session-end parent:memory-req-session-end -->

On session completion, state notes archive, durable session notes are flagged as promotion candidates and listed by the session-filtered review queue, and promote creates a project-scope note superseding the session note with both revision histories preserved.

Validation strategy: test_run

## R12 — Requirement

<!-- element:memory-req-cli -->

The cctl memory command group (recall, index, list, get, create, update, link and unlink, mark-reviewed, promote, review, archive, delete, export) SHALL follow the CLI steering conventions: bounded line-oriented text by default, --json envelopes, stable exit codes, file-backed prose payloads, showing-N-of-M disclosure with exact drill-down commands, and structured refusals naming the next command (a stale revision names the current revision; an ambiguous slug lists labeled candidates). The index verb SHALL render the byte-exact delivery a chosen conversation's next turn would inject (the full block or the delta that turn is due) and, behind an explicit flag, the byte-exact full block; there is no synthetic project- or session-level preview. The group's help and the cc-cli skill SHALL carry the worked agent guidance the static advisory contract abbreviates, since skills and help are the sanctioned on-demand guidance surfaces.

- Priority: must

- Risk: medium

### R12.1 — Acceptance criterion

<!-- element:memory-crit-cli-contract parent:memory-req-cli -->

An in-process contract test drives the real CLI core against the real route handlers for every memory verb, asserting bounded output, envelope shape, and that stale-revision and ambiguous-slug refusals name the exact recovery command; the repo-wide CLI ratchet suites cover the new group.

Validation strategy: test_run

### R12.2 — Acceptance criterion

<!-- element:memory-crit-cli-index-exact parent:memory-req-cli -->

The index verb's default output for a conversation is byte-identical to the delivery injected into that conversation's next turn, and its full-block output is byte-identical to the block a first turn of that conversation would inject, absent intervening memory or linked-artifact mutations.

Validation strategy: test_run

### R12.3 — Acceptance criterion

<!-- element:memory-crit-cli-guidance parent:memory-req-cli -->

The cc-cli skill carries a hand-written memory section with worked examples for capture, artifact linking, index modes, recall, and status-line maintenance; the memory group's help domain context states the same rules as the static contract (hook authorship, the body-reading rule, index modes, linking, the statusNote rule, recall before concluding); and the generated command reference regenerates without drift.

Validation strategy: test_run

skill-reference drift test plus content assertions over the skill section and the help registry

## R13 — Requirement

<!-- element:memory-req-library-ui -->

A Memory Library panel SHALL provide scope filters and search; display of the exact hook, scope, kind, age, freshness, and author; compare-and-swap editing of hook, body, and statusNote; mark-reviewed, promote, archive, supersede, per-revision restore, and separately confirmed permanent delete; approval and rejection of proposed global notes; artifact chips opening linked artifacts; and an Index Preview showing exactly what a selected conversation would inject - the full block and, when the next turn is due a delta, that delta - with its omissions and budget. Memory mutations SHALL publish typed events so the panel stays live.

- Priority: must

- Risk: medium

### R13.1 — Acceptance criterion

<!-- element:memory-crit-index-preview parent:memory-req-library-ui -->

The Index Preview for a selected conversation matches both the full block and the next-turn delivery that conversation would inject, including omission lines and withheld counts, absent intervening memory mutations.

Validation strategy: test_run

### R13.2 — Acceptance criterion

<!-- element:memory-crit-ui-repair parent:memory-req-library-ui -->

From the Library a human can edit a wrong hook under CAS, approve a proposed global note, archive a note (removing it from the next index build), and permanently delete only through the separate confirmation.

Validation strategy: test_run, validator_verdict

component tests plus a live UI verification pass

## R14 — Requirement

<!-- element:memory-req-migration -->

Replacement SHALL NOT depend on bulk import machinery: migrating existing provider memories is a manual, selective activity an agent performs with the ordinary CLI verbs, and migration is not an acceptance criterion. Pure external pointers route to native Reference Documents or ticket attachments where the target scope supports them; otherwise a lesson with a typed source link is the pointer's home. Native Claude, Codex, and Cursor memories SHALL be disabled in the environments Command Center launches wherever the backend exposes a disable mechanism; an exception is permissible only where no such mechanism exists, and is disclosed in the Memory Library and the cctl memory index output header. Every backend receives the same static contract and current index under the selected policy, and the system SHALL provide a portable export at any time.

- Priority: must

- Risk: high

### R14.2 — Acceptance criterion

<!-- element:memory-crit-export-roundtrip parent:memory-req-migration -->

Export writes a portable frontmatter-markdown archive with current-state full fidelity: hook, body, statusNote, slug, aliases, kind, scope, index mode, lifecycle, review lease and expiry, links, and supersession pointer are all recoverable; revision history is explicitly excluded and remains in the database.

Validation strategy: test_run

### R14.3 — Acceptance criterion

<!-- element:memory-crit-native-disclosure parent:memory-req-migration -->

For each registered backend, Command Center disables native provider memory in the environments it launches wherever the backend exposes a disable mechanism; a backend with no such mechanism is disclosed in the Memory Library and the cctl memory index output header; no backend silently runs two memory systems.

Validation strategy: test_run

backend-descriptor contract test over the neutralization declaration and its rendering on both disclosure surfaces

## R15 — Requirement

<!-- element:memory-req-telemetry -->

The system SHALL record per-conversation delivery watermarks naming which note revisions were injected or expanded and whether each injected note's status line was delivered. Index-channel watermarks are the basis of delta delivery: read before composition, advanced only after the turn is accepted, and reset when the conversation loses its backend context. Observation-only telemetry (retrieval counts, promotion-candidate versus promoted counts, validator rounds spent re-deriving facts present in linked notes, useful-hook or wrong-priming annotations where gathered, and a structured recall-miss log recording each recall's query, mode, hit count, and pack size without hook or body text) SHALL never feed ranking or freshness; it exists to evaluate the system and to revisit the evidence-gated defaults (validator access, promotion notification, index budget, embeddings).

- Priority: must

- Risk: low

### R15.1 — Acceptance criterion

<!-- element:memory-crit-watermarks parent:memory-req-telemetry -->

Each delivery's injected note revisions and status-delivered state are recorded as watermarks queryable per conversation, and telemetry tables are readable while demonstrably absent from ranking inputs.

Validation strategy: test_run

### R15.2 — Acceptance criterion

<!-- element:memory-crit-recall-miss-log parent:memory-req-telemetry -->

Every recall emits one structured log event carrying the query, mode, hit count, and pack size and no hook or body text, so a zero-hit query is identifiable from the log alone.

Validation strategy: test_run

## D1 — State store canonical; FTS5 derived; markdown as format, not as storage

<!-- element:memory-dec-storage -->

Chosen approach: Memory Notes persist in the CC state store through an ordinary repository with migrations and a maximal round-trip contract fixture. The body is markdown text; SQLite FTS5 (porter/unicode61 tokenization over hook, slug, aliases, and body) is a derived, rebuildable virtual table updated with the rows it indexes and reconstructible from them at any time. Portability is served by the export verb (frontmatter-markdown archive), not by the storage layout.

Reason: Sessions run in isolated worktrees and project conversations and workflow lanes have no single worktree, so the shared live database is the only substrate that gives every conversation the same current memory, artifact foreign keys, SSE publication, and safe concurrent writers. Bun's SQLite ships ENABLE_FTS5 (verified). Markdown remains the agent-facing format per the ticket's principles without inheriting file-tree failure modes.

Rejected alternatives:

- Per-memory markdown files in the OS config directory with a derived index: Loses artifact foreign keys, per-turn recomposition, SSE, and serialized concurrent writes; hand-editability is served by the Library UI and export instead.

- Files inside the repository or worktrees: Branch-local state forks and lags; shared markdown under concurrent writers produces merge conflicts; project conversations have no worktree at all.

## D2 — Perishable status is a separately leased statusNote on durable notes

<!-- element:memory-dec-statusnote -->

Chosen approach: Durable kinds carry at most one perishable statusNote line with its own updated-at and a fixed 14-day opening lease. Freshness is tracked at two levels: a stale statusNote is withheld while the durable hook and body keep flowing; a stale note is withheld entirely. A statusNote holds a perishable caveat that no live artifact answers (work never live-tested, an evaluation not yet run, a decision awaited); ticket, merge, and spec status are read from the artifact and never recorded. Re-leasing a status line (mark-reviewed --status in the CLI, the same act in the Library) shows the line being re-asserted, its age, and the new lease date, because the act restores that claim to every conversation's ambient delivery. Wholly perishable records are the session-scoped state kind, which archives with its session.

Reason: The dominant real capture is one note holding a durable mechanism plus a current status; the measured failure (14 of 16 status entries stale) came from status woven through durable prose with no invalidation. Separating the perishable half at write time was the source system's own top wished-for change, and single-record authoring keeps capture friction at one command. Two things sharpened this in the live evaluation of the first delivery: all 37 status-bearing entries in the operator's existing index were claims about ticket, merge, or spec state, which a Command Center agent reads live from the active-ticket block or one command, so the common case is not recorded at all; and the stale-status probe showed a human re-lease putting a false claim straight back into ambient delivery, so the re-lease act now shows the claim it asserts.

Rejected alternatives:

- Two records per composite capture (a lesson plus a linked state note): Doubles authoring friction on the most common shape, so agents would predictably inline status back into durable prose, recreating the measured failure. When the provider-native control split a capture into two notes on its own, the repair took two unrelated edits and left an index line pointing at a deleted file.

- Status woven through prose with periodic manual sweeps: The measured baseline: reconciliation required reading sixteen files in full because status claims were load-bearing sentences inside durable content.

- No perishable field at all: Right for artifact status, which the contract forbids recording, but a caveat with no owning artifact has nowhere else to be index-visible while fresh: a dated body sentence is unseen without a read, and a whole-note lease would take the lesson out of circulation when the caveat expires.

- An optional watched artifact on the status line (the revision-5 design): The only claims an artifact transition can falsify are claims about that artifact's state, which agents read live and must not record; the lease alone covers the caveats that remain.

## D3 — Immutable internal IDs; slugs as the only agent-facing handle

<!-- element:memory-dec-identity -->

Chosen approach: Every note has an immutable internal ID used in link rows, revisions, delivery watermarks, and JSON envelopes, and a scope-local slug (server-generated from the hook when absent, old slug kept as alias on rename). Default text output and agent-facing help show slugs only; every verb resolves either form; cross-scope slug ambiguity returns a bounded labeled disambiguation.

Reason: cctl's convention is human handles with server-side identity resolution, and slugs keep body wikilinks readable prose while an agent who remembers a note exists can fetch it without a list round-trip. IDs stay canonical underneath so renames and promotions never break references. Hiding IDs from agent output (Alex, 2026-08-31) removes the two-handle confusion surface entirely.

Rejected alternatives:

- IDs as the only resolvable handle: Forces a list round-trip before every get and makes prose cross-references unreadable.

- Slugs as canonical identity with narrowest-scope shadowing: The same command would resolve differently as ambient scope changes, and renames would strand every stored reference.

## D4 — Static contract in the governing instruction layer; dynamic index delivered once per conversation with per-turn deltas at the live-context seam

<!-- element:memory-dec-awareness -->

Chosen approach: The unchanging advisory contract, under 300 words (advisory and point-in-time; verify mutable claims against live artifacts; omitted hooks exist, so recall before concluding; the hook is the whole entry and stands alone; open a body only for the mechanism or an exact command; the three index modes; about-link a note to the artifact it concerns; caveats go in the statusNote and never the hook, and artifact status is not recorded; the capture bar), is delivered once through the CC-owned governing instruction layer using each backend's privileged channel: a true system prompt for Claude, the governing-instructions block for Codex and Cursor. The memory-index block is composed on every turn at the same live-context seam as the charter and active-ticket blocks, from live rows, with quota-ordered sections and a global budget, but it is delivered in full only on the conversation's first turn and on the enumerated context-loss events (a runtime created without a resume handle, a Command Center compaction, a backend-reported compaction where the backend exposes one). Every other turn carries a delta computed against the conversation's index-channel delivery watermarks, read before composition and advanced after the turn is accepted: hooks created or revised since the watermark, status lines withheld or restored since then, the current withheld and omitted counts, and a closing hint naming the full-index command as the one-call recovery for a context loss Command Center cannot observe. A turn with nothing changed carries at most one line, and a delta never re-carries hooks omitted over budget earlier. Each line carries a compact body-size marker only when the note has a body. The omission line is an instruction naming the recall command first and the list command second. The full-block budget ships at 20 KiB and 120 hooks in global settings.

Reason: Codex and Cursor receive session instructions only on their first turn, so baking changing data into that layer would give per-backend freshness skew; composing at the per-turn seam keeps the headline cross-session property, because a note written by one session is in every other conversation's next delta. Delivering the full block every turn, the revision-5 design, left one copy per turn in the backend's history until compaction; the live database showed a median of 2.4 prompts per conversation but a tail reaching 42, and in that tail the repeated block was the dominant context consumer, while Claude's own memory system loads its index once per session. The first delivery's comparative runs were single-turn and never measured this. Once the block is paid for once, a larger block is cheaper than a repeated smaller one: the operator's existing 255-note library renders at about 21.5 KB against a 12 KiB budget, omitting roughly 45 percent from turn one, so the default rises to 20 KiB and 120 hooks, held below whole-library size by the source system's observed tail attention loss near 106 lines. Quotas keep artifact-linked and session notes from being crowded out; the instruction form of the omission line exists because both crowded-library evaluation runs ignored the informational form.

Rejected alternatives:

- Bake the index into the provider system prompt: A write becomes invisible until runtime recreation, with different staleness per backend; for Claude a changing system prompt would also invalidate the prompt cache for the whole conversation on every turn.

- Load the whole library each session: Rejected across all sources; the measured system showed attention loss in the tail at 106 index lines, well before token cost matters.

- Re-send the full block on every turn (the revision-5 design): Leaves one copy of the block per turn in the backend history; cheap at the 2.4-prompt median and the dominant context cost in the long-conversation tail, which is exactly where the operator's design sessions live.

- Trickle previously omitted hooks into later deltas: Declined for simplicity and predictability until evidence shows more is needed; an over-budget library is handled by the budget, the recall instruction on the omission line, and operator pruning through search-only index mode, archive, or delete.

- A turn-count fallback that re-sends the full block for backends reporting no compaction: A tuning knob that re-sends blocks to conversations that never lost them, reintroducing the per-turn cost this change removes; the delta's closing full-index hint gives a conversation that did lose its context a one-call recovery without a heuristic guessing for it.

## D5 — One bounded recall command; lexical retrieval first; embeddings evidence-gated behind the same contract

<!-- element:memory-dec-retrieval -->

Chosen approach: A single recall verb serves ambient, query, and related-artifact retrieval, returning a bounded context pack (full bodies for the best few fresh records, then hooks with exact reads). Ranking is typed artifact match, then scope specificity, then explicit index mode, then FTS5 lexical score, with freshness as a gate and retrieval frequency excluded. Semantic retrieval may later join behind the identical recall contract, only after a replayable corpus of logged lexical misses demonstrates net benefit.

Reason: The ticket requires one tool call in the common case; a single verb with modes is the smallest surface that satisfies it. Popularity ranking creates a self-reinforcing loop that entrenches wrong-but-frequent notes. Semantic similarity is notoriously good at retrieving the obsolete note topically identical to a fresh question, and no paraphrase failure has been measured yet — the research's YAGNI path.

Rejected alternatives:

- Embeddings in V1: Unmeasured need, real false-recall risk on stale-but-topical notes, and added infrastructure; deferred behind the recall contract.

- Separate find and for verbs: Splits one retrieval contract into two commands agents must choose between; --related covers artifact lookup.

- Recall-count or verify-recency ranking boosts: Feedback loops; frequency and freshness are telemetry and gates, never scores.

## D6 — Typed about and source links; no watch tokens; no graph machinery

<!-- element:memory-dec-links-watch -->

Chosen approach: Memory-artifact relationships are typed rows of two kinds: about (deterministic relevance) and source (supporting context). Only about links influence selection and ranking. There is no watch link kind, no watch-target discriminator, no observed artifact token, and no resolver registry. Freshness is leases and expiry alone: the delivery hot path checks reviewAfter and expiresAt for candidates already selected into an index or recall build, and review-queue construction evaluates every note's lease and expiry so a rarely delivered note still surfaces as review-due. Prose mentions may suggest links but never create retrieval semantics. Because migrations 0040 through 0042 and the memory_links definition in the schema floor have not shipped to main, the watch value in the kind check and the watch-only columns are removed in place rather than by a compatibility migration.

Reason: Links are progressive disclosure per the ticket, never the primary retrieval path. A watch could only fire on a Command Center artifact transition, and any claim such a transition falsifies is a claim about that artifact's state, which agents read live and which the contract now forbids recording; the first delivery's showcase for watches, a 'still unmerged' status line on a ticket, was precisely the claim that should not exist. As a review trigger for lessons about an artifact, a transition is a weak proxy: the ticket-88 design was removed by a later commit that no ticket transition would have caught, and a lease is the honest mechanism for lesson rot. Removal deletes the resolver registry, token comparison in the freshness engine, token re-recording on mark-reviewed, the ticket-status event reaction, the watch state in the Library chips, and the link-kind times target times token model, roughly 600 lines; session-end promotion never read watch links, so nothing else moves.

Rejected alternatives:

- Watch links with semantic artifact tokens (the revision-5 design), or generic updated-at tokens: Both guard derivable artifact state. The semantic version worked mechanically in the evaluation but only on a claim that should not have been recorded, and generic updated-at churns on comments and unrelated edits.

- Knowledge graph with entity extraction and traversal: Rejected by the ticket and both source analyses: extraction cost, another retrieval planner, serial traversal, stripped context.

- Background invalidation pipeline: Standing compute and event wiring for what lease checks on delivery plus a full scan at review-queue construction already provide.

## D7 — Delivery policy in the configuration cascade; validators default to off with a telemetry-gated revisit

<!-- element:memory-dec-policy -->

Chosen approach: Read policy (off, linked-only, ambient) and contribution (on, off) live in the configuration cascade: global settings for ordinary conversations plus implementer/validator defaults, workflow-definition overrides, and per-context implementer/validator overrides with reset. Read policy governs ambient and linked delivery only — explicit retrieval verbs stay available as deliberate, transcript-visible acts — while contribution off refuses all memory mutations with a typed refusal. Validators, adversarial reviewers, collaboration second agents, and hermetic one-shots ship off/no-contribute.

Reason: Ambient priming is the independence hazard: an implementer-authored plausible-but-wrong lesson auto-delivered to a validator synchronizes both lanes on the same false premise, which is exactly what independent validation exists to catch. An explicit recall is an auditable choice, not unchosen influence, so it stays available. The off default is config-visible and the spike measures validator rounds wasted re-deriving linked known traps, so the default is revisited with data rather than argument.

Rejected alternatives:

- Linked-only as the validator default: About-linkage establishes relevance, not truth; the validator-spiral evidence justifies the mode's existence, not its defaultness.

- Ambient delivery for every role: Silently weakens the adversarial validation model CC's workflows are built on.

- Blocking explicit retrieval at off: Prohibition adds an authorization matrix to prevent a deliberate, visible act; the single-operator model does not need it.

## D8 — Cheap immediate writes; global proposals; CAS snapshots; passive session-end promotion

<!-- element:memory-dec-lifecycle -->

Chosen approach: Project and session writes are one immediate command with server-side shape/authority/size/revision validation and advisory-only overlap and vague-hook hints. Agent-created global notes land as proposals excluded from ambient delivery until approved. Edits are compare-and-swap over full-snapshot revisions (a refused stale write persists nothing); archive is the ordinary reversible removal ahead of separately confirmed delete. Re-leasing a status line shows the claim being re-asserted, its age, and the new lease date on both surfaces. Session completion archives state notes and surfaces durable session notes as promotion candidates via a completion cue, Library badge, and prefiltered queue; promote creates a superseding project-scope note in one step, refusing named collisions with active project slugs or aliases rather than suffixing silently. No extraction or consolidation model sits in the write path.

Reason: The ticket's explicit trade is frictionless capture over provenance, so nothing gates the common write; the one narrow approval boundary is global scope, where a wrong note primes every project. CAS is necessary once parallel sessions edit one library. The re-lease act shows its claim because the first delivery's stale-status probe found a human re-lease restoring a false status line to every conversation's block, and adjudicating it afterward cost more than any task in the evaluation. Session-end promotion is passive because CC notifications are durable, toast-producing attention requests that a best-effort memory garden has not earned; promotion-miss logging decides whether that changes.

Rejected alternatives:

- Session-end promotion notifications from day one: Sessions complete constantly; unearned attention cost competing with merge failures and approvals.

- Admission gates, contradiction adjudication, or curator models on writes: Traded away explicitly; best-effort agent maintenance with periodic review is the chosen model.

- Codex-style background extraction from transcripts: Eventually consistent, invisible writes are where poisoned memories enter; direct authorship keeps provenance trivially clear.

## D9 — Direct replacement; manual selective migration; no staged delivery gating

<!-- element:memory-dec-phasing -->

Chosen approach: The memory system ships as the replacement for backend-native memories in one delivery: the full system (schema, FTS5 retrieval, index renderer with quotas, bounded CLI, execution policy, global proposals, Memory Library with Index Preview) is built and native provider memories are disabled wherever the backend exposes a disable mechanism - exceptions only where no mechanism exists, disclosed on the named surfaces - as part of that same work. There is no feature flag, no spike-prototype stage, and no replacement-claim gate. The corpus-seeded evaluation (recall queries, budget behavior, stale-withholding, live cross-backend propagation, CAS concurrency, comparative task runs) runs as delivery validation inside the delivery plan, not as a gating stage in the product. There is no bulk importer: an agent migrates existing provider memories selectively with the ordinary verbs. The amendments this revision carries (watch removal, once-per-conversation delivery with deltas, the larger full-block budget, the omission line as an instruction, agent guidance in help and the cc-cli skill, the body-size marker, status re-lease visibility, recall-miss logging) land as ordinary follow-up work under ticket command-center#105 through the same managed delivery lifecycle. Later additions (diff/restore browser polish, memory reference chips, promotion notifications if earned, gardening workflows, evidence-gated semantic retrieval) remain ordinary future work, not stages of this delivery.

Reason: Alex's direction on review: this is not an experiment run beside the native systems - it is the replacement, and staged trust gating protects no one in a single-operator deployment. Delivery-quality concerns are covered where they belong: acceptance criteria and the delivery plan's validation, with the evidence-gated defaults (validator access, promotion notification, budget, embeddings) revisited from telemetry after delivery. The first delivery's live evaluation is what produced the follow-up amendments, which is the intended loop.

Rejected alternatives:

- Feature-flagged Spike Prototype followed by a trust-complete Replacement V1 behind a four-condition gate: Rejected by Alex in design review: the system ships as the replacement, not as a gated experiment; the staging machinery added governance without a beneficiary.

- Bulk import machinery with dry-run reporting: Cut by Alex in requirements review: selective manual migration through the ordinary CLI is sufficient and keeps migration out of the acceptance criteria.

- Disclosure as a blanket alternative to disabling: An unrestricted disclose-instead-of-disable escape hatch would let every native store keep running, contradicting the replacement mission; disclosure is reserved for backends with no disable mechanism.

## D10 — Surfaces: a cctl command group, a Library panel with Index Preview, on-demand guidance in help and the cc-cli skill, typed events

<!-- element:memory-dec-surfaces -->

Chosen approach: Agents interact through the cctl memory group under the CLI steering conventions (bounded text, --json envelopes, typed refusals naming the next command, file-backed prose). The index verb renders the byte-exact delivery a conversation's next turn would inject, full block or delta, and the byte-exact full block behind an explicit flag; the Library's Index Preview shows both for a selected conversation. The worked agent guidance the static contract abbreviates lives on the two sanctioned on-demand surfaces: a hand-written memory section in the cc-cli skill (capture, artifact linking, index modes, recall, status-line maintenance, with examples) and the memory group's help domain context, beside the generated command reference that regenerates from the help registry. Humans get a right-pane Memory Library reusing Notepad panel patterns: filters, CAS editing, review/promote/archive/restore/delete, global-proposal approval, artifact chips. Mutations publish through the typed events seam so the panel stays live. Per-delivery watermarks record which note revisions were injected and whether each status line was delivered; they are the basis of delta delivery as well as the evaluation record, and a structured recall-miss log records each recall's query, mode, hit count, and pack size without content.

Reason: The CLI is CC's established agent tool surface with an enforced convention set, so the memory group inherits guardrails for free. The Library is the repair-and-trust mechanism a system that silently primes every agent requires, and Index Preview turns wrong-priming incidents from archaeology into a glance; with deltas, the preview must show both what the next turn carries and the full block, or a human reading it cannot tell a quiet turn from a broken one. The first delivery's evaluation found the retrieval path was never the weak link; nothing told the agent to use it. The always-injected contract is word-capped, so examples belong on demand, and skills and help are where all-project Command Center guidance ships. Notepads already proved every interaction pattern being reused, including per-revision restore and the prepare-then-settle watermark that the delta now follows.

Rejected alternatives:

- An in-process MCP memory tool server: A second tool surface with its own schema overhead beside the established CLI convention; cctl is already in every backend's toolbox.

- Graph visualization UI: Links are a list on each artifact and note; a graph canvas oversells traversal the design explicitly rejects.

- Guidance only in the always-injected contract: The contract is capped at 300 words and re-sent to every backend on every conversation; worked examples there would cost every turn what an on-demand skill section costs once.

## Design narrative

<!-- element:memory-sec-design-narrative role:design_narrative -->

The memory domain lives at src/lib/memory/ as a deep module: schemas.ts owns the Zod contracts (note, revision, about and source links, policy, delivery watermark with its status-delivered flag), a repository in the state store persists notes, revisions, and links with a maximal round-trip contract fixture, and a service exposes the domain operations (capture, recall, index composition, delta computation, review, promote, policy resolution). The FTS5 virtual table is derived state rebuilt from note rows; retrieval is a ranked-provider seam so a semantic ranker can join later without schema change, gated on the recall-miss log. Because migrations 0040 through 0042 and the schema-floor memory tables have not shipped to main, the watch removal edits the memory_links definition in place: no watch kind, no target discriminator, no observed token.

Delivery has two halves. The static advisory contract, under 300 words, joins the CC-owned governing instruction layer per backend (Claude system prompt; Codex/Cursor governing-instructions block). The dynamic index is a live-context provider composed beside the charter and active-ticket blocks on every turn from live rows, sectioned by quota (active-artifact about-links, session notes, always hooks, auto hooks) and budgeted from global settings (20 KiB and 120 hooks for the full block). What the turn actually carries depends on the conversation's index-channel delivery watermarks, read before composition and advanced only after the turn is accepted, following the notepad change-notice prepare-then-settle pattern: the full block on the first turn and on each enumerated context-loss event (a runtime created without a resume handle, a Command Center compaction, a backend-reported compaction where the backend exposes one, which today is Claude only), and otherwise a delta of hooks created or revised since the watermark, status lines withheld or restored since then, the current withheld and omitted counts, and a closing hint naming the full-index command. A quiet turn carries at most one line; omitted hooks are never re-carried; each line shows a compact body-size marker only when a body exists; the omission line is an instruction naming recall first and list second. Codex and Cursor report no compaction to Command Center, so a conversation on those backends that compacts internally stays on deltas until a Command Center compaction or a new runtime, and the full-index hint is its one-call recovery. Because every conversation of every backend recomposes from the same rows, cross-session cross-backend propagation is a property of the seam, not a subsystem: a note written elsewhere is in the next delta.

Freshness is leases and expiry only. On the delivery hot path the service checks reviewAfter and expiresAt for candidates already selected; review-queue construction (cctl memory review and the Library queue) evaluates every note's lease and expiry, so completeness lives there rather than in per-turn work. There are no watch resolvers and no token comparison. Note-level staleness withholds the note; statusNote staleness withholds the line; mark-reviewed refreshes the note's lease, and mark-reviewed --status refreshes the line's lease while printing the status line, its age, and the new lease date, with the Library showing the same before the act. The review queue, promote-as-supersede (refusing named slug collisions), archive-before-delete, and the global proposal lifecycle are ordinary service operations surfaced identically through cctl memory and the Library panel. Policy (read mode x contribution) resolves through the existing configuration-cascade machinery with global-settings defaults, workflow-definition overrides, and per-context resets; hermetic task profiles simply exclude the surface.

Events publish through src/lib/events/publication.ts. Watermarks record injected note revisions and status-delivered state per delivery, reset on the context-loss events, and serve both delta delivery and evaluation; the recall-miss log records query, mode, hit count, and pack size without hook or body text. The index verb renders the next-turn delivery by default and the full block behind an explicit flag; the Index Preview shows both. Agent guidance beyond the contract lives in a hand-written memory section of the cc-cli skill and in the memory group's help domain context, with the generated command reference regenerated from the help registry. Delivery is direct: the system replaces backend-native memories, disabling them wherever a disable mechanism exists and disclosing the exceptions, and the amendments this revision carries land as follow-up work under ticket command-center#105 through the same managed delivery lifecycle. The evaluation fixture is seeded from the real corpus via ordinary create and link calls, and the evaluation scenarios (recall queries, budget behavior at the shipped default, stale-withholding by lease, live cross-backend propagation, once-then-delta delivery over a live multi-turn conversation on two backends, CAS concurrency, comparative task runs including the crowded-library re-run under the instruction form) run as delivery validation; validator-waste, promotion-miss, and recall-miss telemetry then decide the evidence-gated defaults.

