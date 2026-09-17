## cctl memory

Read and write the **memory Command Center shares** across Claude, Codex, and
Cursor. Your first turn is given the full `<memory-index>` block of one-line
hooks; every later turn is given only a `<memory-index-delta>` of what changed
since. The always-injected `<memory-contract>` states the rules in one
paragraph each; this section is the worked version. The verbs and their exact
shapes are in [the command reference](command-reference.md) (`cctl memory --help` for the live
node).

**Capturing a lesson.** The hook is the whole index entry — it is the only part
most conversations ever see — so state a fact that stands alone, not a topic.
Open a body only for the mechanism or the exact command a reader would come for.

```
cctl memory create --hook 'next build opens the LIVE db, so a main-branch schema bump breaks older branches' --body-file .cc/temp/note.md
# → shared-state-db-across-branches  project  lesson  active
#   revision: 1  index-mode: auto  updated: just now
```

A hook that names the symptom and the mechanism in one line beats a titled one:
`turbopack .next/cache balloons to 8.4GB and the build stalls at 99% CPU on one
core` is found by the agent hitting the stall; `turbopack cache notes` is not.
Skip the note entirely when a live artifact answers the question — ticket,
merge, and spec status are read live and are never recorded.

**Linking it to the artifact it is about.** This is the multiplier: an `about`
link makes the note lead the index of every conversation working that ticket,
spec, or workflow. Do it in the same breath as the capture.

```
cctl memory link shared-state-db-across-branches --artifact ticket:105
cctl memory link shared-state-db-across-branches --artifact spec:memory --kind source
cctl memory recall --related ticket:105
```

`--artifact ticket:105` is the ticket's number in **this** project;
`ticket:command-center#105` names one in another. `--kind source` records
provenance and never affects selection, so use it for where a lesson came from
and `about` (the default) for what it is about.

**Choosing an index mode.** `auto` competes for the block on recency and
quotas; `always` reserves a slot; `search-only` never competes and is reached
only by recall.

Illustrative hooks; capture only findings established for the actual project.

```
cctl memory create --hook 'the git stash stack is shared across every worktree — never bare stash/pop' --index-mode always
cctl memory create --hook 'vendor export pagination uses the response header cursor, not an offset' --index-mode search-only
```

Reach for `always` only when the trap bites regardless of what the task is —
one that costs everyone an hour, not one that costs a ticket. Reach for
`search-only` for reference material (catalogues, matrices, tables) that would
otherwise crowd out lessons: it is the pruning lever when the block is over
budget.

**Recalling.** The block is budgeted, so hooks are omitted from it. If a turn
touches something the block does not list, recall before you conclude — the
omission line at the bottom of the block is asking for exactly this.

```
cctl memory recall 'turbopack build is slow'
# → showing 3 of 3 — narrow with: cctl memory recall 'turbopack build is slow' --scope project
cctl memory get turbopack-build-memory-balloon
```

Quote the query with **single** quotes. A double-quoted query carrying a
backtick is substituted by the shell before `cctl` ever sees it. `recall`
returns a bounded pack of hooks with what fits of each body; `get` prints one
note in full with its links and the revision a later `update` passes to
`--if-revision`.

**Maintaining a status line.** The `statusNote` is the perishable half: a caveat
that **no live artifact answers** ("never live-tested", "evals not done",
"awaiting a decision"), leased for 14 days and withheld on its own when the
lease runs out. A perishable caveat goes there, never in the hook. What a live
artifact does answer — whether a branch merged, what state a ticket is in,
whether a spec is approved — is not a status line and is not recorded at all;
read it live instead.

```
cctl memory create --hook 'collab resume after error re-admits the prompt under a new turn generation' --status-note 'never live-tested'
cctl memory update ticket81-collab-resume-after-error --if-revision 4 --status-note none
cctl memory mark-reviewed ticket81-collab-resume-after-error --status
# → status: never live-tested (status as of 21 days ago)
```

`mark-reviewed --status` prints the claim it re-asserts before the line is
eligible to ride the note again, so read that line: re-leasing a status you have
not checked is how a false claim gets a fresh 14 days. Eligible is not
delivered — the line travels only where the note itself does, which its scope,
its index mode, and the block's budget decide. When the claim is no longer what
you would write today, `update --status-note` rewrites it and `--status-note
none` clears it. `mark-reviewed` without `--status` re-leases the durable note
instead; `cctl memory review` lists everything whose lease has run out.

**Reading a delta.** After turn one you are given a `<memory-index-delta>`
rather than the whole block. It carries only what changed since your last turn —
hooks created or revised elsewhere, status lines withheld or restored, and the
current withheld and omitted counts — so a quiet turn is one line, not a defect.
It closes with the full-index command, which is the one-call recovery when your
context lost the block (a backend compaction Command Center cannot observe).

```
cctl memory index
cctl memory index --full
```

`index` renders what your own next turn is due; `--full` renders the whole
index whatever you are due. Neither settles anything, so previewing never
spends the block the turn is owed.

Related: `cctl memory review` is the maintenance queue (expired leases, stale
status lines, session notes offered for promotion); `cctl memory promote`
carries a session note up to project scope before the session ends; `cctl
memory archive` retires a note that stopped being true without destroying the
evidence of what was believed.

`cctl memory export` writes the exact Markdown export as a library artifact.
Use `--out <path>` to select a destination. With `--json`, scalar command data
is under `payload.data`; recall and index preserve their exact server-authored
text there, including the index block.
