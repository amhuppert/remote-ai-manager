## cctl conversation

Read **conversation transcripts** in bounded windows and work with **compaction
artifacts** — dense, structured context handoffs generated from a conversation's
history. This is how an agent pulls context from another conversation (or its
own earlier history) referenced via a `<conversation-ref>`.

A `<conversation-ref>` carries ready-to-run commands for exactly this — a
`read-command` (always) and a `compaction-command` (when a compaction exists):
copy either verbatim, no flags needed. A `<message-ref>` is the same idea
scoped to one message (its `message-index` attribute): its `read-command`
reads just that message and its `compaction-command` (present when
`compacted="true"`) fetches that message's compaction.

`read`, `compact`, and the `compaction get|list` pair are in the command
reference above; `cctl conversation read --help` lists the full selector set.

**Windows & coordinates.** Ranges are `A:B` (e.g. `--message-range 2:3`;
`A-B`, `A,B`, and a bare `N` for `N:N` are also accepted). Two coordinate
systems, don't mix them: the `#N` unit headers in read output are **message
indexes** (`--message` / `--message-range`), while the `[sN]` line markers are
**seq coordinates** — raw JSONL lines, windowed with `--seq-range`. Compaction
source refs carry both (`messageIndex` + `seqStart`/`seqEnd`). `entry get`
takes a seq; `image get` takes that same seq **plus** the image-bearing content
block index inside it — copy both from the entry export, which lists a
ready-to-run command per image, rather than counting blocks by eye.

**Output sizes — read whole, don't pre-truncate.** An outline is typically
1–3 KB, a compaction envelope 10–20 KB, and windowed reads are bounded by
`--max-bytes` (default 256 KiB) server-side. Every output is already bounded,
so do **not** wrap `cctl` in `2>&1 | head -c N` — the pipe hides the exit
code, and errors already lead with their one actionable line.

**Identity:** `<conversation-id>` is positional and defaults to
`CC_CONVERSATION_ID` when omitted — reading your own history is valid. **You
normally pass only the id: for a conversation that isn't in your own session,
cctl auto-resolves its owning project + session from the id** (via the global
conversation lookup) and reads that scope — so reading any `<conversation-ref>`
needs no `--project`/`--session`. Flags stay an override: an explicit
`--project`/`--session` is honored as given (and `--project` **without**
`--session` targets the project-scoped endpoints, for conversations that live at
project scope). Auto-resolution is skipped for your own conversation id (already
in scope) and whenever you pass those flags; a truly unknown id exits `2`.

### Progressive evidence access

Start with the referenced message when the request names one. For broader
context recovery, use an existing checkpoint or compaction, then open only the
source windows needed to answer the question. Stop when the evidence is enough.

1. **Saved checkpoint, when one exists.** `cctl conversation checkpoint list`
   indexes a conversation's frozen continuation seeds; `checkpoint get <id>
   <operation-id>` reads one receipt and `--detail seed` returns its exact
   frozen bytes — capped at 32 KB, and the conversation's own working state at
   a recorded boundary. Reading one triggers no generation. Most conversations
   have none; go to 2.
2. **Compaction artifact.** `cctl conversation compaction get <id> --format
   markdown` renders the full envelope (agent brief, current state, decisions,
   files, commands, open questions, blockers) as prose with exact
   `messageIndex`/`seq` source refs — typically 10–20 KB, read it whole. This
   is almost always all the context you need, at zero token cost to generate.
   Use `--json` instead when you need the refs' verbatim quotes or
   machine-readable fields.
3. **Windowed read.** When the compaction points you at something (or is
   stale/absent), pull a *bounded* window: `read --outline` for the table of
   contents, then `read --message-range A:B` or `--seq-range A:B` for the exact
   slice. Use `--search <regex>` to find matching units.
4. **Complete entry, then original image.** A bounded read states what it
   shortened and names the command that recovers it: `entry get <id> <seq>`
   returns that entry whole — full tool detail, no excerpt limits — and lists
   the image handles it carries, while `image get <id> <seq> <block-index>`
   writes the original bytes under `.cc/temp/` and prints the path, media type
   and sha256. Past the stdout budget an export spills to a file the same way,
   so a huge tool result survives the round trip. Run the command the output
   named; don't retype the coordinate.
5. **Complete-history requests.** When the task requires every message, traverse
   bounded windows and follow omission commands until the requested range is
   covered. An unwindowed read can hit `--max-bytes` (default 256 KiB), so it
   does not prove the whole transcript was read.

- `read` — render a window of the transcript. `--outline` returns user prompts +
  assistant headlines only (the TOC); `--message N`, `--message-range A:B`, and
  `--seq-range A:B` are mutually exclusive windows (`messageIndex` = merged
  visible message; `seq` = raw JSONL line). `--include-tools` defaults to
  `summary`; `--include-thinking` defaults off. `--format markdown` prints a
  compact fenced document instead of JSON-derived text. After `--outline` it
  hints the next escalation — and tells you whether a compaction exists to
  fetch, is still generating, or must be created first. With `--json`, the
  rendered output is in the `transcript` field for the default format, and in
  the `markdown` field when `--format markdown` is set. Invalid options exit
  `2` with one issue per line; an unknown conversation exits `2`. An empty
  window (e.g. message indexes that don't exist) reports the conversation's
  real coordinate bounds so you can re-aim. A bounded window closes by naming
  what it left out, by kind, each with the command that recovers it: entries
  the byte budget never reached (recovered by their raw `--seq-range`), the
  entry a cut landed inside, and every entry the renderer shortened (both
  recovered only by `entry get`, since raising `--max-bytes` returns the same
  excerpt). Run the printed command; do not retype the coordinate.
- `compact` — create or refresh a compaction artifact (the whole conversation,
  or one message with `--message N`). Without `--wait` it returns immediately:
  `{ ok, artifactId, status: "pending", hint }` — the artifact generates in the
  background. With `--wait` it polls until the artifact completes (exit `0`),
  fails (exit `1` with the generation error), or a bounded timeout elapses.
  `--force` regenerates even when the existing artifact is fresh. If the
  artifact is already fresh it returns it directly (`status: "fresh"`).
- `compaction get` — fetch the newest matching artifact's **full envelope**
  (`--message N` selects that message's artifact; otherwise the
  conversation-level one). `--format markdown` renders the envelope as prose
  (brief, current state, decisions, files, commands, blockers — with their
  `#N sA–B` source refs) instead of raw JSON — usually the right form to read;
  the JSON envelope additionally carries the refs' verbatim quotes. With
  `--json` the markdown is in the `markdown` field. When stale it still
  succeeds (`stale: true`, `staleBehindMessages: N`) with `hint: refresh with:
  cctl conversation compact <id>`. When absent it exits `1` with `hint: create
  with: cctl conversation compact <id>` — create one when broader context recovery needs it; a targeted read can answer a narrower question directly.
- `compaction list` — one line per artifact (id, kind, status, covered seq
  range, freshness). Ends with a hint pointing at `compaction get`.

Exit-code nuance: an unknown *conversation* is a caller mistake (exit `2`), but
an existing conversation with **no artifact yet** is exit `1` + the create hint —
distinguish them by the hint/stderr, not just the code.

```
cctl conversation compaction get 0197a3c2-... --json
# → exit 1, hint: create with: cctl conversation compact 0197a3c2-...
cctl conversation compact 0197a3c2-... --wait --json
# → { "ok": true, "artifact": { "status": "complete", "payload": { "agentBrief": ... } } }
cctl conversation read 0197a3c2-... --outline
# → #0 [seq 0-2] user ...
#   hint: narrow with --message-range A:B / --seq-range A:B, or fetch the compaction: cctl conversation compaction get 0197a3c2-...
#   (with no artifact: "…; no compaction exists — create one (background LLM generation) with: cctl conversation compact 0197a3c2-...")
cctl conversation read 0197a3c2-... --message-range 4:6 --include-tools summary
cctl conversation compaction get 0197a3c2-... --format markdown
```

### `compact` writes a document; `compact-context` changes the live conversation

`cctl conversation compact` produces a **reading artifact**. It retires no
context, consumes no message, and the conversation's next turn sees exactly
what it would have seen.

`cctl conversation compact-context` is a **lifecycle action on the live
conversation**: it freezes a bounded seed, retires the conversation's provider
context, and leaves the seed **ready**. Reach for it when a conversation's
context is the problem — not when you want something to read.

**Ready is not applied.** `ready` means the frozen seed is waiting; the next
ordinary user message delivers it once and the operation becomes `applied`.
Building the seed **does use model work** — a working-state pass plus any
repair pass, whose measured cost the receipt reports as compaction usage — but
that work adds no ordinary turn to the conversation and consumes no queued
message, so nothing else happens until you send that message. `--wait` exits
`0` only at ready/applied; a client timeout leaves the server's operation
running and prints the exact `checkpoint get` that reads it.

**Check before you start.** `cctl conversation checkpoint check` is read-only
and evaluates the same admission predicates the start enforces: exit `0` names
the eligible transition, exit `1` lists each blocker with its code and remedy.
It creates no operation and changes nothing.

**Mutations stay in your scope.** `compact-context`, `checkpoint cancel` and
`checkpoint reconcile` act on your ambient project/session. Acting on a
conversation elsewhere takes an explicit `--project` (and `--session` for a
session conversation) — cctl never discovers another owning scope and writes
there for you. The reads keep the id-only auto-resolution described above.

**Stuck operations.** `checkpoint reconcile` is deterministic repair: it never
sends a model request and never replays a message. When delivery stays unknown
it says so and remains blocked — resolve the uncertain queued messages first,
then supersede the operation explicitly with `compact-context --recover
<operation-id>`, which rebuilds from the recorded archive. Neither undoes tool
effects, files, or provider-side state.

```
cctl conversation checkpoint check
# → exit 0: "eligible: compact_context"  |  exit 1: one line per blocker + remedy
cctl conversation compact-context --wait
cctl conversation checkpoint list 0197a3c2-...
cctl conversation checkpoint get 0197a3c2-... 3f5c1e64-... --detail seed
cctl conversation entry get 0197a3c2-... 148 --include-thinking
cctl conversation image get 0197a3c2-... 148 2
```
