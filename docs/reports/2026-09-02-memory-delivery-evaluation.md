# Memory delivery — live evaluation

**Date:** 2026-09-02
**Spec:** `memory` (pinned revision 5), ticket `command-center#74`
**Execution context:** `memory-final-verification`
**Instance under test:** the worktree dev server at `http://localhost:3002`, config dir
`<worktree>/.config` — a second CC instance with its own database, transcripts and
api-token. Confirmed worktree-local, not the production config dir, before anything was
mutated. CLI: that server's own `.config/bin/cctl` (build `4f9a9273`, matching the server
build; build parity green).
**Scratch project:** `plc-test-lab`. **Sessions:** `mnemo-alpha` (Claude), `mnemo-beta` (Codex).

Everything below was produced by driving the running application — real routes, real LLM
turns, real SQLite — and verified against durable state rather than the screen. No claim
here rests on a unit test.

---

## 1. Reachability audit

Every surface the audit names was exercised live.

| # | Surface | Result |
|---|---|---|
| 1 | `<memory-index>` in a real **session** conversation turn | PASS |
| 1b | `<memory-index>` in a real **project** conversation turn | PASS |
| 2 | `cctl memory create` / `get` / `recall` / `list` against the running server | PASS |
| 3 | Memory Library renders; a repair action persists | PASS |
| 4 | A workflow context under `linked-only` receives exactly its about-linked notes | PASS |
| 5 | Native-memory disclosure for a no-mechanism backend | PASS (both surfaces) |

### 1.1 The block reaches a real turn on both conversation kinds

Session conversation `04267684-e950-454c-8c6b-730e01a3cd4a` (Claude, Opus 5) was prompted
with tools explicitly forbidden and asked whether its context carried a `<memory-index>`
block. Transcript row 3 contains a single text block — no `tool_use` anywhere in the turn —
and reads:

> Yes, there is a `<memory-index>` block in this turn.
> Slug: `reachability-probe-rchx7-the-dev-server-memory-route-answers-a`
> Hook line: `- reachability-probe-rchx7-… [project, just now] Reachability probe RCHX7: the dev-server memory route answers a real create`

The quoted hook line is byte-identical to `cctl memory index` for the same conversation.

Project conversation `74bf68ff-5cc8-4a04-9739-7fa171004004` was created by
`POST /api/projects/plc-test-lab/prompt` and answered the same prompt with the same
verbatim quote.

Scope union, observed live on the two conversations:

```
session conversation → visibility: global + project + session mnemo-alpha   (session + auto sections)
project conversation → visibility: global + project                          (auto section only)
```

### 1.2 The CLI answers end to end

`create` returned the new slug at revision 1; `get` returned hook and body; `recall`
returned `Showing 1 of 1 memory records.`; `list` returned a bounded list with its
drill-down hint. All against `http://localhost:3002` with that server's own token.

### 1.3 The Library renders and repairs

The Memory tab of the right pane rendered the library/index view switch, scope and status
filters, a search box, note rows, and a note detail carrying Hook / Body / Status-note
editors, Save and Revert, Mark reviewed, Supersede, Archive, Delete, and a revision history
with a Restore control.

A hook was edited in the UI and saved. Durable check:

```
sqlite> select slug, revision, hook from memory_notes where slug like 'reachability-probe%';
reachability-probe-rchx7-…|2|Reachability probe RCHX7 EDITED-IN-UI: the Library hook edit persists under CAS
```

Revision moved 1 → 2 and the edited text is in the row — the repair persisted, it did not
merely paint.

**Index Preview vs `cctl memory index`, rendered back to back: BYTE-IDENTICAL (537 == 537
bytes).** An earlier pair differed by exactly one word — `2 minutes ago` versus
`3 minutes ago` — because the two renders straddled a minute boundary. Worth recording
because it is the one way the two can legitimately disagree: the block embeds relative ages,
so byte-identity holds only within a rendering bucket, not across arbitrary delay.

### 1.4 `linked-only` is exact to the context under validation

A one-off execution (`1b482c45-3a11-4ea3-ba47-2f10f8400149`) ran two ordered `full` contexts
on one lane:

- `ctx-ambient` — default policy
- `ctx-linked` — `memory: { implementer: { read: "linked-only" } }`

It was launched with `approvalRequired` so the notes could be linked while the run was
parked. Three notes were about-linked: one to `context:<exec>/ctx-linked`, one to
`context:<exec>/ctx-ambient`, one to `execution:<exec>`. The `memory_links` rows carry
`artifact_context_id` values `ctx-linked`, `ctx-ambient` and `NULL` respectively, so
per-context and execution-wide links persist distinctly rather than aliasing.

`ctx-ambient`'s real lane turn received five hooks:

```
## about execution:<exec>, context:<exec>/ctx-ambient (2 of 2)
- linkprobe-execwide …
- linkprobe-ctx-ambient …
## session (1 of 1)
- session-scope-probe-sesx9-…
## auto (2 of 2)
- linkprobe-ctx-linked …
- reachability-probe-rchx7-…
showing 5 of 5 hooks
```

`ctx-linked`'s real lane turn received exactly one:

```
delivery: linked-only (notes about-linked to the active artifacts)
## about context:<exec>/ctx-linked (1 of 1)
- linkprobe-ctx-linked [project, 1 minute ago] LINKPROBE-CTXLINKED: this note is about-linked to the ctx-linked execution context only
showing 1 of 1 hooks
```

The execution-wide note, the sibling context's note, the project auto notes and the
session-scope note were all absent. This is the criterion's exactness claim, observed on a
real lane turn rather than inferred from the composer.

Operational note: definition approval could not be performed by an agent — the API answers
`human_act_required` — so it was done from the UI. That is the design working; recorded so
the next live run does not lose time to it.

### 1.5 Native-memory disclosure

`cctl memory index` writes to **stderr**, leaving stdout byte-exact:

```
native memory still running: Cursor (the Cursor SDK exposes no option that disables its
memories; the only memory switch in the package is server-delivered feature config an
embedder cannot set)
```

The Memory Library renders the same disclosure above the view switch, outside the Index
Preview `<pre>`:

> Cursor still runs its own native memory beside this library: the Cursor SDK exposes no
> option that disables its memories; …

---

## 2. Live two-backend cross-session propagation

**Result: PASS.**

| | Session A | Session B |
|---|---|---|
| Session | `plc-test-lab/mnemo-alpha` | `plc-test-lab/mnemo-beta` |
| Conversation | `04267684-e950-454c-8c6b-730e01a3cd4a` | `ec84abd7-5652-4bb9-9761-053ef01edc2c` |
| Backend | **Claude** (Opus 5) | **Codex** |

**B1 — establish B's runtime before the lesson exists.** A tool-free Codex turn reproduced
its block: `## auto (4 of 4)`, no `xbackend-prop-4417`.

**A — mid-flight capture.** A's Claude turn was started detached with instructions to run one
`cctl memory create` and then write a 1500-word essay with no further tools, so the turn
stays in flight long after the capture. Transcript row 27 is the real tool call:

```
TOOL_USE Bash {"command": "cctl memory create --slug xbackend-prop-4417
  --hook 'XBACKEND-PROP-4417: the cross-backend propagation fixture resolves to the number 8613' …"}
```

`memory_notes` shows the row at revision 1, `created_at 2026-09-02T18:22:29.082Z`.

**B2 — B's next turn while A is still running.**

```
A status before B turn: running   at 18:22:46Z
A status after  B turn: running   at 18:22:58Z
```

B2's first line was `8613`, followed by its block:

```
## auto (5 of 5)
- xbackend-prop-4417 [project, just now] XBACKEND-PROP-4417: the cross-backend propagation
  fixture resolves to the number 8613
…
showing 5 of 5 hooks
```

**Used without a retrieval call — proven structurally.** Session B's entire transcript is
eight rows: two turns of `user → system → assistant(text) → result`. There is no `tool_use`
or `tool_result` row anywhere in it. The number `8613` exists nowhere but the hook.

**No restart.** `cctl dev ensure` ran once, before the whole sequence. B reused the same
Codex conversation across both turns; A stayed `running` on both sides of B's turn.

**Telemetry recorded it.** `memory_delivery_watermarks` holds five `index`-channel rows for
conversation B, including memory `45a25e04-…` (= `xbackend-prop-4417`) revision 1 at
`18:22:48.111Z`; `memory_observation_counters` has `retrieval_index:45a25e04-…` count 1 at
the same instant.

---

## 3. Corpus-seeded evaluation

The committed corpus `docs/fixtures/memory-eval-corpus.json` (15 notes, 10 named queries,
one stale-status specimen) was seeded through ordinary `cctl memory create` calls — aliases
via `--alias`, the specimen's status line via `--status-note-file`. No note was written
directly to the database and the operator's home directory was never read.

### 3.1 The ten named recall queries — 10/10, twice

Each query was one `cctl memory recall '<query>'` call; a pass means the expected slug's
record is in the returned pack.

| Query | Expected slug | Corpus only | With 100 filler notes |
|---|---|---|---|
| `notebook` (alias) | `notepad-feature-roadmap` | PASS, rank 1 of 1 | PASS, rank 1 of 1 |
| `memory pressure sysctl isolation` (body only) | `vitest-ontaskupdate-timeout-swap-thrash` | PASS, rank 1 of 5 | PASS, rank 1 of 5 |
| `test passed but zero files matched` | `scoped-test-vacuous-pass` | PASS, rank 1 of 7 | PASS, rank 1 of 23 |
| `tailwind utility loses legacy css` | `tailwind-loses-to-legacy-css` | PASS, rank 1 of 3 | PASS, rank 1 of 3 |
| `position fixed offset transform` | `docked-stage-transform-containing-block` | PASS, rank 1 of 2 | PASS, rank 1 of 2 |
| `jq truncated json output` | `cctl-json-pipe-truncation` | PASS, rank 1 of 4 | PASS, rank 1 of 4 |
| `grep finds nothing binary file` | `raw-nul-byte-grep-binary` | PASS, rank 1 of 6 | PASS, rank 1 of 6 |
| `backticks empty argument` | `cctl-backtick-shell-substitution` | PASS, rank 1 of 2 | PASS, rank 1 of 2 |
| `next build extremely slow one core` | `turbopack-fs-cache-slow-build` | PASS, rank 1 of 8 | PASS, rank 1 of 8 |
| `ENAMETOOLONG` | `long-worktree-name-enametoolong` | PASS, rank 1 of 1 | PASS, rank 1 of 1 |

Every expected record came back **ranked first**, in one call, both on the bare corpus and
after the library grew to 121 notes. The alias query and the body-only symptom query — the
two the corpus singles out — behave like the rest.

### 3.2 Index budget adherence

100 procedurally generated filler notes (lexically disjoint from the corpus) took the
library past the budget. The rendered block:

```
BYTES: 12167   (budget 12288)   HOOKS: 69
…
showing 69 of 121 hooks — omitted 52 over budget: cctl memory list
```

PASS: inside the byte budget, an explicit omission line naming the count and the exact
follow-up command, no silent truncation. The `## session (1 of 1)` section still held its
slot with 120 project notes competing, so the reservation is doing its job.

Also observed on the same block:

- An agent-created **global** note landed `proposed` and appeared in **no** conversation's
  block — checked against all three live conversations (session A, session B, the project
  conversation): zero occurrences each. The block instead carried
  `withheld: 1 proposed — cctl memory list --lifecycle proposed`.
- Its `create` returned overlap candidates as **advisory** output beside the created note,
  not as a refusal.
- Archiving a note removed it from the next block with no restart
  (`before: 1 → after: 0`), and the archived note stayed fetchable behind the explicit
  `--archived` filter, whose absence the refusal names.

### 3.3 The stale-status specimen

`ticket88-cursor-darwin-status` carries the corpus's intentionally-perishable status line
`ticket-88 work still unmerged` and a `statusNote` watch on a ticket. (Its index mode was set
to `always` so it held a slot in an over-budget block; nothing else about the specimen was
changed.)

**Before** the watched ticket moved (status `in_progress`):

```
## always (1 of 1)
- ticket88-cursor-darwin-status [project, just now] Cursor darwin support derives the SDK package from …
  status: ticket-88 work still unmerged (status as of 4 minutes ago)
```
Recall carried hook, status line and body. Review queue: `0 total`.

**After** `cctl ticket update plc-test-lab#1 --status done`:

```
## always (1 of 1)
- ticket88-cursor-darwin-status [project, just now] Cursor darwin support derives the SDK package from …
                                  ← the status line is gone
```
Recall carried hook and body, **no status line**. Review queue:

```
review queue: 1 total, 1 shown
ticket88-cursor-darwin-status  project  status review due  — cctl memory mark-reviewed ticket88-cursor-darwin-status --status  Cursor darwin support derives …
```

The durable lesson kept being delivered the whole time; only the perishable half was
withheld, and the note was queued attributed to its stale status with the exact clearing
command. An explicit `cctl memory get` still showed the status line — correct: withholding
governs ambient delivery, and the operator asked to review it needs to see what is in
question.

**`mark-reviewed --status`** refreshed the lease, restored the status line to the block, and
re-recorded the token (`memory_links.observed_token` moved `in_progress` → `done`); the
queue returned to `0 total`.

**Semantic, not any-edit:** a subsequent `cctl ticket update … --description "…"` moved the
ticket's `updated_at` and the queue stayed at `0 total`, with the status line still in the
block. A comment-grade edit does not fire the watch.

### 3.4 Concurrent compare-and-swap

Two writers were launched in parallel, both stating `--if-revision 1` on the same note.

Winner (exit 0): revision 2, hook `WRITER-B rewrote the hook`.
Loser (exit 1):

```
This write states revision 1, but the note is now at revision 2.
why: Another writer changed the note after the revision this write was based on;
     overwriting blind would discard their edit.
instruction: Re-read with 'cctl memory get scoped-test-vacuous-pass', then re-run with --if-revision 2.
```

PASS: the refusal names the current revision and the exact recovery command. The refused
payload was never persisted — `WRITER-A` appears in zero rows of `memory_notes` **and zero
rows of `memory_note_revisions`** — and history is intact (rev 1 `create`, rev 2 `edit` with
`base_revision` 1).

### 3.5 Export

`cctl memory export` wrote all 123 visible notes (archived and proposed included) as a
57 KB frontmatter-markdown archive carrying hook, body length, status note, slug, aliases,
kind, scope, index mode, lifecycle, leases, links and both supersession directions resolved
to slug handles (`supersedes: "project:filler-098"`).

---

## 4. Gaps found

The audit's job is to find what code tracing cannot. Two defects surfaced, each recorded as
a remediation task in this execution context with its own acceptance criterion.

### G1 — the ticket artifact handle takes an id space nobody holds

`cctl memory link --artifact ticket:<id>` resolves against the ticket's immutable UUID
(`tickets.id`), but every documented example in `src/cli/commands/memory.help.ts` uses the
per-project **display number** (`ticket:74`, at lines 203, 463, 469, 497) — the number every
human-facing surface prints and `cctl ticket create` returns.

Following the help produces one of two wrong outcomes, both reproduced live against ticket
`plc-test-lab#1` (id `12dc2816-…`):

- `--kind watch` is **refused**: *"No watch token can be resolved for a ticket artifact, so
  the watch was not recorded."* The message blames the artifact kind; the real cause is that
  the artifact exists and the id space is wrong. The same link succeeded, recording
  `observed_token = in_progress`, when the UUID was passed.
- the default `--kind about` is **accepted silently** and persisted with `artifact_id = '1'`.
  That link can never fire, because the live-context provider builds the active-artifact ref
  from `findLinkedTicketId`, which returns `ticket.id`. The note never leads an index block
  and never answers `memory recall --related`, and nothing says so.

Unit tests do not catch this because they construct the artifact ref directly; only a live
run through the documented CLI surface puts the two id spaces in the same room.
→ remediation task `remediate-ticket-handle`.

### G2 — a superseded note does not name its successor on the read path

Supersession archives the predecessor and persists the pointer both ways, and
`memory export` resolves both directions to slug handles. But `cctl memory get <slug>
--archived` prints nothing about the note having been replaced, and its `--json` envelope
carries `supersededById` as a bare internal id with no slug counterpart. Lineage ids are
resolved to handles in exactly one place — the export route — so the reader who follows a
stale slug out of an old transcript is shown the retired note with no signal that a
replacement exists.
→ remediation task `remediate-successor-pointer`.

### Non-memory observation

The project first-prompt SSE stream (`POST /api/projects/<name>/prompt`) emitted each
`content` event and the `done` event **twice**. Outside this delivery's scope; recorded
because it was seen while driving the real route.

---

## 5. Useful-hook and wrong-priming observations

**Hooks that carried their own weight.** The clearest signal in the whole run is the
cross-backend proof: Codex answered `8613` from a hook alone, with no retrieval call and no
body. Hooks written as *the fact* rather than *the topic* are directly consumable — the
model does not have to decide whether to go and read more. The corpus hooks that name a
symptom and a verdict in one line (`Zero test failures plus 'Timeout calling onTaskUpdate'
means swap thrash, not a branch defect`) are the shape that survives the index budget,
because the whole lesson fits in the line that gets delivered for free.

**Ranking behaved better than the design promised.** Every one of the ten queries returned
its target ranked first, including the alias query and the body-only symptom query, and
adding 100 filler notes did not displace a single one. The one query whose candidate pool
grew sharply under filler (`test passed but zero files matched`, 7 → 23 returned records)
still ranked its target first. Lexical retrieval over slug, alias, hook and body is
carrying this corpus without embeddings.

**Wrong priming is a real, observable failure mode — and the separation is what defends
against it.** The corpus's stale-status specimen is the honest version of the problem: its
durable body (*the evidenced-host matrix was removed; none of that vocabulary exists in
`src/` anymore*) stays true forever, while its status line (*ticket-88 work still unmerged*)
became false the moment the watched ticket moved. Before the transition, an agent reading
the block would have been primed with a false claim about merge state — and the body would
have been right. After the transition, the block delivered exactly the durable half and
dropped the perishable one, without a human touching the note. That is the mechanism
earning its keep: had hook and status been one field, the whole note would have had to be
withheld or the whole note would have kept lying.

**Where wrong priming still gets through.** Two shapes this run did not close:

1. A note whose *hook itself* is time-bound has no separation to fall back on. Nothing
   structural stops a capture like `slices 1-2 merged` from ageing into a lie; only the
   review lease catches it, and only after it expires.
2. G1 above is a priming risk in the other direction — a note the author believed they had
   linked to a ticket is silently unlinked, so the agent working that ticket is primed by
   whatever generic project notes win the auto budget instead. Silence is the dangerous
   part: the author has no way to notice.

**Cost observation.** The zero-call path is real. Across every turn in this evaluation, no
agent spent a tool call to obtain memory it then used — the cross-backend answer, the two
lane reports and both conversation-kind probes all came out of the injected block. The one
place a call was spent was deliberate, in the ten recall queries.


---

## 6. Comparative evaluation (D9)

### 6.1 Setup — reproducible

**Three fixed tasks**, each a real Command Center trap drawn from the committed corpus, each
answerable in a few lines and gradable against a known root cause:

| id | prompt (verbatim, identical in every mode) | the corpus lesson it needs |
|---|---|---|
| T1 | *In Command Center, a registered path-scoped validation run (`cctl validate run test -- <path>`) exited 0, but I do not believe those tests actually ran. What is the most likely explanation, and exactly what do I do to be sure? Answer in at most 6 lines.* | `scoped-test-vacuous-pass` |
| T2 | *A vitest run in the Command Center repo reports 0 test failures but dies with `Timeout calling "onTaskUpdate"`. Is the branch broken? What do you check first? Answer in at most 6 lines.* | `vitest-ontaskupdate-timeout-swap-thrash` |
| T3 | *In Command Center, a `min-h-full` Tailwind utility has no effect on an element inside the document editor, and the jsdom test asserting it passes. Why, and how do you confirm it? Answer in at most 6 lines.* | `tailwind-loses-to-legacy-css` |

A fourth prompt, **S1**, is the wrong-priming probe rather than a task, and is scored
separately: *Is the ticket-88 cursor-darwin support work merged yet? Answer in one line, and
say plainly if you are not sure.* Its note carries the corpus's intentionally-perishable
status line.

**Run isolation.** Every run is a **fresh project conversation** created by
`POST /api/projects/plc-test-lab/prompt` on the dev server, so no run inherits another's
context. Backend: Claude (Opus 5) in every CC-side run, so backend is not a variable. Tools
were **allowed** in every mode — the point is to measure how many calls each mode spends,
not to forbid them. Answers, tool calls, turn counts and usage are read from the durable
transcript, not the stream.

**Grading.** A task is a **hit** only if the answer names the corpus lesson's root cause
*and* its confirming action. Getting a plausible neighbouring cause right is a miss, and is
recorded as such below.

**Modes.**

| mode | configuration |
|---|---|
| `no-memory` | CC global config `memory.conversations = { read: "off", contribute: "off" }`, applied through `PUT /api/config` and reverted afterwards. `cctl memory index` confirmed *"no memory block: this conversation is told nothing right now"* before the runs. |
| `cc-memory` | shipped ambient policy, library as the corpus evaluation left it: **121 notes**, 100 of them procedural filler, block at 12280 bytes / 67 hooks with 52 omitted over budget. |
| `cc-memory-clean` | shipped ambient policy, filler archived so the corpus fits: **22 hooks / 3820 bytes, nothing omitted**. |
| `provider-native` | the real `claude` CLI (2.1.258, Opus 5) run **outside** Command Center against the operator's real `~/.claude` home, in a throwaway project directory whose native auto-memory store was primed with the same four lessons: **6 native notes / 1236-byte `MEMORY.md`**. Setup in §6.5. |
| `provider-native-crowded` | the same control after the **same 100 filler notes** (identical hook text and ordering to `cc-memory`) were written into the native store: **106 native notes / 19116-byte `MEMORY.md`, nothing omitted — the format has no budget**. |

The second and third CC modes were not in the original plan. They were split apart after the
crowded run produced the finding in §6.3, and keeping both is what makes that finding
attributable to budget pressure rather than to memory in general. `provider-native-crowded`
was added for the same reason and in the same shape: it applies the identical crowding
pressure to the other memory system, so the two can be compared under load and not only when
uncrowded.

### 6.2 Results

| task | `no-memory` | `cc-memory` (crowded) | `cc-memory-clean` | `provider-native` | `provider-native-crowded` |
|---|---|---|---|---|---|
| T1 vacuous pass | **MISS** | **HIT** | **HIT** | **HIT** | **HIT** |
| T2 swap thrash | **MISS** | **MISS** | **HIT** | **HIT** | **HIT** |
| T3 layered CSS | **MISS** | **MISS** | **HIT** | **HIT** | **HIT** |
| **score** | **0 / 3** | **1 / 3** | **3 / 3** | **3 / 3** | **3 / 3** |

Per-run measures, from the transcripts:

| mode | task | tool calls | of which memory calls | turns | cost (USD) | output tokens |
|---|---|---|---|---|---|---|
| no-memory | T1 | 2 | 0 | 3 | 0.178 | 876 |
| no-memory | T2 | 0 | 0 | 1 | 0.125 | 458 |
| no-memory | T3 | 0 | 0 | 1 | 0.133 | 780 |
| | **total** | **2** | **0** | | **0.436** | |
| cc-memory | T1 | 2 | 1 | 3 | 0.215 | 763 |
| cc-memory | T2 | 0 | 0 | 1 | 0.182 | 745 |
| cc-memory | T3 | 0 | 0 | 1 | 0.184 | 815 |
| | **total** | **2** | **1** | | **0.581** | |
| cc-memory-clean | T1 | 2 | 1 | 3 | 0.176 | 612 |
| cc-memory-clean | T2 | 2 | 1 | 3 | 0.186 | 669 |
| cc-memory-clean | T3 | 2 | 1 | 3 | 0.206 | 1285 |
| | **total** | **6** | **3** | | **0.568** | |
| provider-native | T1 | 1 | 1 | 2 | 0.207 | 565 |
| provider-native | T2 | 1 | 0 | 2 | 0.163 | 466 |
| provider-native | T3 | 0 | 0 | 1 | 0.148 | 495 |
| | **total** | **2** | **1** | | **0.518** | |
| provider-native-crowded | T1 | 1 | 1 | 2 | 0.257 | 780 |
| provider-native-crowded | T2 | 1 | 0 | 2 | 0.232 | 438 |
| provider-native-crowded | T3 | 1 | 1 | 2 | 0.237 | 458 |
| | **total** | **3** | **2** | | **0.727** | |

In the two native modes the T2 tool call is `sysctl vm.swapusage` — a diagnostic the lesson
told the agent to run, not a retrieval — so it is counted as a tool call and not as a memory
call.

**Repeated errors.** None of the nine runs repeated an error within its own run — each is a
single diagnosis. The repeated error is *across* modes: the two wrong root causes
(`no-memory` and crowded `cc-memory` on T2 and T3) are the same two wrong causes each time —
"the reporter RPC timed out / something is leaking a handle" for T2, and "a percentage
`min-height` has no definite parent" for T3. Both are the plausible textbook answer, and both
are what this repository's operator has already paid for once. That is the failure memory is
supposed to retire, and in `cc-memory-clean` it does.

**Cost.** Memory cost about **30% more per task** than no memory ($0.568 vs $0.436 for the
three tasks) and moved root-cause accuracy from 0/3 to 3/3. The premium is two things: a
larger prompt (the block) and one expansion call per task. Uncrowded, the provider's own
memory system landed in the same place for the same reasons ($0.518, 3/3); crowding is where
the two diverge, and §6.5 measures that.

**Recall calls — the honest number is not zero.** In `cc-memory-clean` each task spent
exactly **one** `cctl memory get <slug>` call: the hook told the agent the lesson existed and
named it, and the agent chose to read the body before committing to an answer. That is the
design's one-bounded-call path, not the zero-call path. The zero-call path is real too — the
cross-backend proof in §2 shows Codex answering from a hook alone with no tool call at all —
and the difference is the hook. A hook that **is** the whole fact ("resolves to the number
8613") costs nothing; a hook that **points at** a fact ("layered Tailwind utilities never beat
unlayered legacy CSS") buys one call. Both are cheaper than being wrong, but hook authorship
is what decides which one you pay.

### 6.3 The headline finding: budget pressure evicts by recency, not by relevance

The crowded and clean CC modes differ only in whether 100 filler notes were archived. That
single difference moved the score from 1/3 to 3/3.

Rendering the block that the crowded runs actually received shows why. **Only 2 of the 15
corpus notes survived the budget:**

```
scoped-test-vacuous-pass         ✓  (edited minutes earlier by the CAS test — recent)
ticket88-cursor-darwin-status    ✓  (index-mode: always — holds a reserved slot)
the other 13 corpus notes        ✗  omitted
showing 67 of 119 hooks — omitted 52 over budget: cctl memory list
```

T1's lesson survived and T1 was a hit; T2's and T3's lessons were evicted and both were
misses. The `auto` section orders by recency, so a hundred notes created seconds ago displace
lessons that have been true for months. The block said so honestly —
`omitted 52 over budget: cctl memory list` was right there in every crowded run — and
**neither agent followed it**. An agent that does not know a lesson exists has no reason to
suspect the omission line is about the thing it is currently getting wrong.

This is a property of the design, not a defect in the delivery: the block is composed before
the question is known, so it cannot rank by relevance to a question it has not seen. Three
things already in the product mitigate it, and the evaluation exercised all three:
`index-mode: always` (which is exactly why the ticket-88 note survived), `index-mode:
search-only` for notes that should never compete, and `cctl memory recall`, which found every
one of the ten corpus queries at rank 1 **even at 121 notes** (§3.1) — the retrieval path was
never the weak link. The weak link is that nothing tells the agent to use it.

Two things worth considering, offered as findings rather than as work this context did:

1. **Make the omission line actionable rather than informational.** It currently names a
   listing command (`cctl memory list`). Naming the *search* command instead —
   "52 hooks omitted; if this turn is about something not listed above, `cctl memory recall
   '<topic>'`" — turns a fact into an instruction at the one moment the agent can act on it.
2. **Age the `auto` tail, or cap how much of the budget recency may claim.** A library that
   grows monotonically will reach this state without anyone generating filler; the filler
   only got there faster. §6.5 runs the identical crowding against the provider's own memory
   store and lands on this same recommendation from the other direction: with no budget at all
   the accuracy survives and the token bill grows instead, which is what makes *eviction order*
   rather than *eviction itself* the thing worth fixing.

The caveat, stated plainly: 100 notes created within the same minute is an artificial worst
case for a recency-ordered section. A real library accrues over months and would degrade more
gently. But the criterion asked for a library that exceeds the budget, and this is what
exceeding the budget did.

### 6.4 Stale actions and repair cost (probe S1)

| mode | tool calls | memory calls | cost (USD) | took a stale action? |
|---|---|---|---|---|
| no-memory | 6 | 2 | 0.256 | no |
| cc-memory | 3 | 1 | 0.247 | no |
| cc-memory-clean | 9 | 1 | 0.343 | no |
| provider-native | 1 | 1 | 0.177 | no |

**No mode took a stale action.** All four refused to assert the false claim, and all of them
found the same tell — the note's durable body says the matrix *merged and was then removed*
while its status line says the work is *still unmerged*:

> *"the memory note is unreliable here: its status line says ticket-88 is still unmerged while
> its body says it merged"* — `cc-memory`

> *"the live ticket (plc-test-lab#1) is marked **done**, which contradicts the memory note's
> 18-minute-old 'still unmerged' status"* — `cc-memory-clean`

> *"my two stored notes contradict each other (one says ticket 88 merged with the matrix
> removed the next commit, the other says still unmerged as of today)"* — `provider-native`

Four observations follow.

1. **A note with a false status line is not free even when nobody believes it.** Adjudicating
   one bad status line cost 3, 6 and 9 tool calls and $0.25–$0.34 across the three modes — the
   most expensive single prompt in the whole matrix, more than any of the three real tasks.
   That is the measured price of a stale claim: not a wrong action, but a diverted turn.
2. **The withholding mechanism was not what saved these runs — a human re-lease defeated it.**
   The status line was legitimately withheld while the watch was stale (§3.3). It was back in
   the block for these runs because `mark-reviewed --status` had refreshed the lease, and
   `mark-reviewed` asserts *"this is still true"* without checking. The lease is a prompt to a
   human, not a proof; a human who clears it wrongly puts the false claim straight back into
   ambient delivery. What actually saved these runs was the note's internal contradiction and
   the agent's willingness to reconcile against the live ticket.
3. **`read: off` does not remove the memory surface, by design.** In `no-memory`, the agent
   still ran `cctl memory recall` and `cctl memory get` and read the note. That is the
   documented contract — read policy governs what arrives *unasked*, and retrieval verbs are
   never gated in any mode — and the static advisory contract tells every backend `cctl memory`
   exists regardless of policy. Worth stating because "no memory" in this table means **no
   ambient block**, not an agent that cannot reach the library.
4. **The provider's own memory reached the same refusal a different way, and more cheaply.**
   Handed both halves in one priming debrief, native auto-memory *noticed the contradiction at
   capture time* and split them into two notes on its own initiative, filing the status as a
   dated snapshot whose own index line reads *"conflicts with the merged-design lesson, verify
   the branch before relying on it"* (§6.5). That is capture-time judgement doing what CC does
   structurally with `statusNote` and leases. It is not equivalent: it happened because one
   debrief contained both halves at once, and it produced advice to a future reader rather than
   a mechanism — nothing withholds the claim, expires it, or surfaces it in a review queue.
   It cost 1 tool call and $0.177, the cheapest S1 run in the matrix.

#### 6.4.1 Repair time

The criterion asks for repair time, so the same repair was performed and timed on both
systems: *the ticket-88 status claim is false — make the library stop asserting it, without
losing the durable lesson.*

| system | operations | wall clock | result |
|---|---|---|---|
| CC memory | 1 (`cctl memory update … --if-revision 3 --status-note none`) | 0.71 s | revision 3 → 4; status line gone, durable hook still in the next index build |
| provider-native | 2 (delete `ticket-88-cursor-darwin-unmerged.md`, then edit the `MEMORY.md` index line) | 0.16 s | same end state, reached in two unrelated edits |

The wall-clock numbers are not the finding — both are sub-second machine operations and the
real cost in either system is the human deciding the claim is false. **Operation count and
what happens on a partial repair are the finding**, and that was measured rather than argued.
After step 1 alone the native store was left in this state:

```
$ rm .../memory/ticket-88-cursor-darwin-unmerged.md
$ grep -n unmerged .../memory/MEMORY.md
6:- [Ticket 88 (cursor darwin) unmerged as of 2026-09-02](ticket-88-cursor-darwin-unmerged.md) — dated status snapshot; …
```

The note file is gone and the index still asserts the false claim, pointing at a file that no
longer exists — and the index is the part that is actually injected into every turn. Nothing
detects the dangling line. The two writes are not atomic, there is no compare-and-swap, and a
concurrent editor would not be told. CC's single `update` is one transaction against one
record, the index is derived from that record per turn rather than separately maintained, and
a stale-revision write is refused naming the current revision (§3.4). This is the clearest
structural advantage the delivery holds over the native store, and it is a repair-path
advantage rather than a retrieval one.

### 6.5 Mode 2 — the provider-native control

**Decision.** The operator chose *"use my real provider home"*. The control therefore runs the
real `claude` CLI (2.1.258) against the real `~/.claude`, so authentication, settings cascade
and the native auto-memory feature are all the genuine article rather than a reconstruction.
The one thing held apart is the **working directory**: Claude's native memory store is keyed
by project path (`~/.claude/projects/<slugified-cwd>/memory/`), so the control runs from a
throwaway `/tmp/cc-native-memory-control` and its memories land under
`-private-tmp-cc-native-memory-control`. Alex's real 256-note command-center library was
neither read nor written. That is the same isolation the CC-side runs had — those ran in the
`plc-test-lab` scratch project, not against a production library — so the modes stay
comparable, and it is why "real home" did not have to mean "real library".

The store started empty, as §6.5 previously recorded: the project directory did not exist, and
`claude` created `memory/` on first run. Codex was left out of the control on purpose — the
CC-side runs are all Claude, so making the control Claude keeps backend from being a variable;
`~/.codex/memories_1.sqlite` was separately confirmed empty (`jobs` 0 rows, `stage1_outputs`
0 rows), so the same priming problem would have applied there.

**Priming.** Four sessions, one per lesson, each a separate `claude -p` run so each lesson is
learned the way a real one is — in its own debugging session. Each prompt delivers the corpus
note's hook and body verbatim and asks for it to be recorded durably; the last delivers the
ticket-88 note *including its perishable status claim*, because the whole point of S1 is what
each system does with a fact that will rot. This is a **generous** setup for native memory:
explicitly telling a system to remember something is the best case for its capture path, and
it is stated here so the 3/3 below is not read as more than it is. Cost: $0.938 for the four
priming runs.

The four priming prompts, verbatim — each run as
`claude -p "<prompt>" --model opus --output-format json --permission-mode bypassPermissions`
from `/tmp/cc-native-memory-control`. The lesson text in each is the corpus note's hook
followed by its body, unchanged:

```
L1  Debrief from a debugging session on the Command Center repo. I lost an hour to this and
    want you to remember it. A scoped test run passes with zero matching files - a mistyped
    path still exits 0. Specifically: `cctl validate run test` with a path filter exits 0 when
    no files match, so a typo silently produces a vacuous pass. The verdict line names the
    matched-file count. Use --require-match to make an empty match exit 1. Separately, --wait
    can exit 0 with no verdict at all: always read the verdict, or use --json. Record this
    durably so a future session does not repeat the mistake. Reply with only the word RECORDED.

L2  …Zero test failures plus `Timeout calling "onTaskUpdate"` means swap thrash, not a branch
    defect. Specifically: a vitest run that reports no test failures but dies with Timeout
    calling "onTaskUpdate" (or a single lone test timeout) is memory pressure, not a real
    failure. Check `sysctl vm.swapusage` and re-run the file in isolation before hunting a
    branch defect. …

L3  …Layered Tailwind utilities never beat unlayered legacy CSS regardless of specificity -
    measure in the live browser. Specifically: utilities in the Tailwind layer lose to any
    unlayered legacy rule; specificity is irrelevant because layer order decides. `min-h-full`
    lost to a `.ProseMirror` rule, and jsdom could not observe the difference - only a live
    browser measurement showed it. …

S1  Debrief from a session on the Command Center repo. Two things to remember about ticket 88
    (cursor darwin support). First, the durable lesson: <ticket88 hook + body verbatim>.
    Second, the current status: the ticket-88 work is still unmerged. Record both durably so a
    future session has them. Reply with only the word RECORDED.
```

L2 and L3 share L1's framing sentences (`Debrief from a debugging session … I lost an hour to
this and want you to remember it.` … `Record this durably so a future session does not repeat
the mistake. Reply with only the word RECORDED.`), elided above only to keep the block
readable. S1 is the one that deliberately mixes a durable lesson with a perishable status
claim in a single debrief.

Native memory captured all four, and made two decisions of its own:

```
memory/MEMORY.md  (6 entries, 1236 bytes)
- [cctl validate: zero-match vacuous pass]      — …use `--require-match`.
- [cctl validate --wait: no verdict]            — …always read the verdict or use `--json`.
- [vitest `onTaskUpdate` timeout = swap thrash] — …check `sysctl vm.swapusage`…
- [Tailwind layer loses to unlayered legacy CSS]— …jsdom cannot see it, measure in a live browser.
- [Cursor darwin: SDK package from platform+arch] — ticket 88's evidenced-host matrix was removed…
- [Ticket 88 (cursor darwin) unmerged as of 2026-09-02] — dated status snapshot; conflicts with
  the merged-design lesson, verify the branch before relying on it.
```

It **split** L1 into two notes (the vacuous pass and the `--wait` verdict trap are one corpus
note but two facts), and it **separated the perishable claim from the durable lesson on its own
initiative**, dating it and annotating it with the contradiction. That is worth recording
plainly: the thing this delivery builds as a mechanism, a capable model will sometimes do as a
judgement call. The difference is that a judgement call happens only when the model notices —
here it noticed because one debrief contained both halves — and it produces a warning to a
future reader, not a lease, a withheld line, or a review queue.

**Runs.** The same four verbatim prompts as §6.1, one fresh session each, tools allowed, Opus 5,
`--output-format json`; tool calls read from the durable session transcript.
Driver: `.cc/temp/native-control/control.py`; raw records:
`.cc/temp/comparative-provider-native.json` and `-crowded`.

**Result: 3/3, uncrowded and crowded alike.** The answers are in
`.cc/temp/comparative-provider-native*.json`; graded on the same rubric (root cause *and*
confirming action), all six task runs are hits. Two things about *how*:

- **The zero-call path is real here too.** Uncrowded T3 answered with **no tool call at all** —
  layer order beats specificity, jsdom cannot see it, measure in a live browser — straight from
  the injected index line. T1 spent one `cat` of the note file; T2 spent one `sysctl
  vm.swapusage`, which is the lesson's *prescribed action*, not retrieval.
- **The retrieval mechanics are generic, not special.** Native memory is plain files, so the
  agent reads a note with `Bash cat <abs path>`. CC's equivalent is `cctl memory get <slug>`.
  Both are one call; neither system needed a search.

**The crowding result is the one that matters.** The same 100 filler notes were written into
the native store, in the native format, with identical hook text and ordering to the CC crowded
mode. Nothing was evicted, because `MEMORY.md` has no budget — it grew from 1236 to 19116
bytes and all 106 lines were injected.

| | index size | notes visible to the turn | score | cost, T1–T3 | input tokens / run |
|---|---|---|---|---|---|
| `cc-memory-clean` | 3820 B | 22 hooks, 0 omitted | 3/3 | $0.568 | — |
| `cc-memory` (crowded) | 12280 B (**capped**) | 67 of 119 hooks, **52 omitted** | **1/3** | $0.581 | — |
| `provider-native` | 1236 B | 6 notes, 0 omitted | 3/3 | $0.518 | 25.8k–53.2k |
| `provider-native-crowded` | 19116 B (**uncapped**) | 106 notes, 0 omitted | 3/3 | **$0.727** | 65.2k–66.9k |

**The two systems trade the same pressure in opposite directions.** Crowding cost CC memory
**accuracy at flat cost** — the budget held the block to 12280 bytes and spent $0.581 either
way, but evicting by recency dropped two of the three lessons and the score with them (§6.3).
Crowding cost native memory **money at flat accuracy** — every lesson stayed reachable and all
three stayed hits, but the per-turn prompt grew by roughly 8600 input tokens and the three
tasks cost **40% more** ($0.727 vs $0.518). Neither system is simply better here. CC bought a
bounded prompt and paid in relevance; the native store bought relevance and paid in unbounded
growth, on a curve that has no ceiling in it — 100 filler notes is a rounding error next to the
256 notes Alex's real command-center library already holds.

This sharpens the two suggestions in §6.3 rather than changing them. The eviction is the price
of the cap, and the cap is the right call — an index that grows forever eventually eats the
context window it was meant to save. What the crowded native run shows is that the delivery is
paying that price **with the wrong eviction order**: recency, applied to lessons whose value
does not decay with age. Capping how much of the budget recency may claim (§6.3, item 2) buys
back most of the accuracy at none of the token cost, and it is the change this comparison most
supports.

**What mode 2 does not establish.** The native store held 6 purpose-primed notes against CC's
22, and every one of them had been placed there for these exact tasks; a native library grown
organically over months would not be so well aimed. The control also exercises none of what the
spec builds memory *for* beyond retrieval — it is single-agent, single-backend and
single-session by construction, so cross-session and cross-backend propagation (§2), role-
conditioned delivery (§1.4), and the repair path (§6.4.1) have no native counterpart to compare
against. Those are the differences that survive this evaluation, and they are structural rather
than a matter of scoring three prompts.

**Reproducing it.** `zsh .cc/temp/native-control/prime.sh`, then
`python3 .cc/temp/native-control/control.py T1,T2,T3,S1`, then
`python3 .cc/temp/native-control/seed-native-filler.py` and
`MODE=provider-native-crowded python3 .cc/temp/native-control/control.py T1,T2,T3`. The scratch
project can be removed with
`rm -rf /tmp/cc-native-memory-control ~/.claude/projects/-private-tmp-cc-native-memory-control`;
it is left in place so the numbers above can be re-read, and it is the only thing this control
wrote outside the worktree.
