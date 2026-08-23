# Lane Placement, File Ownership, and Parallelism

Reference for [graph-workflow-planning](../SKILL.md). Read this when deciding lane sharing, `ownedPaths` for a tricky surface, what the write envelope lets executing agents do, parallel-vs-sequential calls, or when answering a `placement-*` refusal.

Every execution context declares `placement`: which **lane** it runs on, and what it may write there. There is no default and no inference — a plan whose contexts do not all carry placement is refused.

A lane is one git worktree on one branch, and several contexts may share it. That is the point: a lane hosting N contexts costs **one worktree and one fan-in join** for the whole group, where N single-member lanes cost N of each. Read-only contexts on the `session` lane cost nothing at all — a fan-out with eight readers provisions no worktrees and produces no merges.

## The three placement grades

```jsonc
{ "id": "judge", "title": "Judge the candidates",
  "acceptanceCriteria": [ { "id": "names-one-winner", "statement": "…" } ],
  "placement": { "lane": "session", "mode": "readOnly" },
  "outputSchema": { "type": "object", "properties": { "winner": { "type": "string" } }, "required": ["winner"] } }

{ "id": "persistence", "title": "Persist the new fields",
  // one of several unordered "impl" members — that race is why it declares ownedPaths
  "acceptanceCriteria": [ { "id": "round-trips-new-fields", "statement": "…" } ],
  "placement": { "lane": "impl", "mode": "owned",
                 "ownedPaths": ["src/lib/state-store", "docs/persistence.md"] } }

{ "id": "dependency-bump", "title": "Bump the SDK",
  "acceptanceCriteria": [ { "id": "lockfile-matches-manifest", "statement": "…" } ],
  "placement": { "lane": "sdk-bump", "mode": "full" } }
```

| grade | substrate | may write | costs | use for |
|---|---|---|---|---|
| `readOnly` | the session worktree (`"lane": "session"`), or a group lane to read that lane's tree | nothing in the repository — its own scratch only | no worktree, no landing commit, no join | fan-out readers, judges, classifiers, reviewers, triage |
| `owned` | its lane's worktree, shared with the lane's other members | exactly its `ownedPaths`, each covering itself and everything beneath it | one worktree and one join, shared with the whole lane | unordered write-capable members of a shared lane — the only case that needs a list |
| `full` | its lane's worktree | the whole tree | one worktree and one join, but the lane to itself while it runs | every other write-capable context: alone on its lane, or ordered against every lane-mate |

`readOnly` requires `outputSchema`: a reader produces no commit and no join, so captured structured output is the only thing it can deliver (`placement-readonly-missing-output-schema`).

## Lane visibility and fork points

Lane visibility follows committed branch ancestry, not dependency arrows alone:

- Same-lane landed work is visible immediately. A downstream lane-mate can run as soon as the upstream member's landing commit is recorded; no join intervenes.
- When an authored lane does not exist yet, it forks from its single upstream lane, or forks from the session branch when it has no worktree upstream. The fork carries the committed tree visible at that point.
- When the authored target is an existing target lane and an upstream is not already visible there, the engine performs a `context_merge` before dispatch. For multiple upstream lanes, the sources likewise converge through a `context_merge` before dispatch; a new lane can then fork from the converged head.
- A read-only context contributes its captured structured output payload. It creates no repository commit, so consumers receive the payload rather than repository ancestry from that context.

A fork is a branch snapshot, with no continuous synchronization. Later commits become visible only through same-lane landing or another explicit join. A workflow lane also does not inherit uncommitted or later work from a different authoring session merely because that session created the plan.

## Choosing a grade

`ownedPaths` is a **concurrency mechanism, not a scoping mechanism**. Its one job is to let write-capable contexts run at the same time in one worktree without corrupting each other — declare `mode: "owned"` only for members that actually race: two or more write-capable members of one lane that no dependency edge orders. Every other write-capable context takes `mode: "full"`:

- **Alone on its lane** → `full`. There is no sibling to be disjoint from; an ownership list buys no parallelism, and every legitimate write it failed to foresee is refused at the tool boundary or halts the lane with `ownership_violation`.
- **Sharing a lane sequentially** → `full` on each member. Dependency-ordered members never run concurrently, so they may share paths freely — the disjointness rule tests ordering first and binds only unordered pairs, and a `full` member is legal beside lane-mates it is ordered against (`placement-full-access-concurrency` bites only unordered pairs). The group still costs one worktree and one join.
- **Parallel on different lanes** → `full`. Isolation across lanes comes from separate worktrees and the merge resolver, never from ownership; a list adds nothing there.

Reach for the **shared, ownership-disjoint lane** — several `owned` members running concurrently in one worktree — when contexts implement genuinely disjoint blocks of one change and running them at the same time is worth having. That lightweight parallelism is the one thing ownership lists buy, and the whole group still verifies and lands once.

Give a context an **isolated single-member lane** when sharing would be wrong rather than merely inconvenient:

- **Same-file competition.** Tournament candidates, competing refactors, two designs of one module — anything whose whole point is that both write the same paths. Ownership cannot be disjoint there, so separate lanes are the answer and the LLM resolver handles the overlap at the joins.
- **Dependency-mutating work.** A lockfile update, a dependency bump, a codegen or barrel regeneration, a migration that renumbers — work whose effects are not confined to the paths it names. A member that reinstalls dependencies changes what its lane-mates are building against mid-flight.
- **A lane that must run its own verification.** Whole-repo verification runs once per lane, at its join. A context that needs `typecheck` or `test` green at ITS OWN boundary — because a later context depends on that fact — needs a lane whose barrier it owns.

Put readers on the `session` lane. Fan-out readers, judges, and synthesis inputs need to see the repository, not change it, and a write-capable placement buys them a worktree and a merge for nothing. Put a reader on a GROUP lane only when it must read that lane's in-progress tree — a reviewer of work its lane-mates have not published yet.

## Ownership is literal and directory-grain

Everything in this section applies to the unordered write-capable members of a shared lane — the only place `ownedPaths` belongs.

An `ownedPaths` entry is a normalized repo-relative POSIX path covering itself and everything beneath it, compared at segment boundaries — `src/lib` does not swallow the sibling `src/libraries`. There are no globs: a metacharacter is an ordinary filename character here, and the write-policy adapter refuses one outright.

Prefer **directory-grain ownership** over file lists. An implementer working red-green creates files that did not exist when you wrote the plan — the new test beside the module, a new schema file — and a file-grain entry denies exactly those writes at the tool boundary, mid-task. Own `src/lib/state-store`, not eleven paths inside it.

Rules a plan is checked against:

- Lane names become branch and worktree path segments: `/^[A-Za-z0-9_.-]+$/`, no leading `.` or `-`, no `..`, no trailing `.`, `-`, or `.lock` (`placement-lane-name-invalid`).
- `session` is the reserved authored name for the session worktree and admits read-only contexts only (`placement-session-lane-write-capable`). The engine's internal `__session__` is never an authored name (`placement-reserved-lane-name`).
- `.git` is denied and `.cc` is reserved. Never author either.
- The repository root is not an ownership entry — name the directories the context owns.

## Sequencing shared surfaces

A barrel or index file, a lockfile, a shared `schemas.ts`, a migration registry, a generated snapshot — one surface several blocks must touch — has exactly one owner. Two concurrent same-lane members claiming overlapping prefixes is refused at accept time (`placement-owned-paths-overlap`), not discovered at the join.

Two ways to resolve it, in preference order:

1. **Home it upstream.** Land the shared surface in a context every member depends on (Planning Procedure step 3), and let the members own only their own blocks. This is the same rule that stops parallel siblings from inventing competing copies of a shared schema.
2. **Order it inside the lane.** Dependency-ordered same-lane members may share paths freely — the disjointness rule tests ordering first, and only unordered pairs must be disjoint. So a "wire the barrel" context that depends on every block it exports simply takes `mode: "full"`: nothing runs concurrently with it, so it needs no list at all.

What does not work: handing the shared surface to whichever member needs it first, or splitting one file's ownership by intent. Ownership is by path.

## What the envelope changes about the agents you are planning

Placement is enforced mechanically, per turn, at the tool boundary — not by prompt discipline. Plan around it:

- **No agent commits.** `.git` is denied, so an implementer **cannot commit, branch, or reset**; the engine lands each member's owned prefixes for it. Never write task instructions that ask an implementer to commit, stash, rebase, or clean the tree.
- **No per-context whole-repo gate.** Automatic whole-repo gating runs once per lane, at its join, through `laneMergeValidation`. A placed, enveloped context runs no script gate of its own, so its `scriptValidator.commands` must be empty or a subset of the lane's barrier selection — anything else is refused rather than silently discarded. Put the deterministic thesis on the barrier, and keep a context that genuinely owns a check on its own lane. This does not touch the agent tier: placement never narrows `agentValidation`, so an enveloped implementer still runs `cctl validate run` for whatever its snapshot grants.
- **Scratch and payloads.** An owning member writes `cctl … --file` payloads to its **payload directory** under the worktree's `.cc` namespace, and has a **per-context scratch** root besides. A session reader has no payload directory: its **per-context scratch** root is the only place it can write, and its prompt points `--file` there. Either way a plan never authors ownership of `.cc`.
- **Unattributed writes halt the lane.** A TRACKED change in a shared worktree that no member's ownership covers raises `ownership_violation`. It is recoverable through plan repair, but it is a halt — a context whose real write surface is wider than its declared one fails loudly instead of corrupting a sibling. That protection only earns its cost where a concurrent sibling exists; on a member with no unordered lane-mate the same halt fires with nothing to protect, which is why ownership belongs only on racing members. Gitignored content is never judged, so build output, caches, and installs need no mention in `ownedPaths`: declare the work, not the toolchain.

## Accept-time refusals

| code | what to fix |
|---|---|
| `placement-lane-name-invalid` | the lane name is not spliceable into a branch name and a path |
| `placement-reserved-lane-name` | the plan authored `__session__`; write `session` |
| `placement-session-lane-write-capable` | a write-capable context sits on `session`; move it to a group lane |
| `placement-readonly-missing-output-schema` | a read-only context declares no `outputSchema`, so it can deliver nothing |
| `placement-full-access-concurrency` | a `full` member shares its lane with a write-capable member it is not ordered against |
| `placement-owned-paths-overlap` | two concurrent same-lane members claim overlapping prefixes |

## Parallelization guidance

Contexts on **different** lanes run in isolated git worktrees on separate branches, so they cannot interfere with each other mid-flight. Branches are merged automatically at join points and at final publish, and merge conflicts are **resolved automatically** by an LLM resolver (the same machinery as Smart Merge). Lane-merge validation follows `laneMergeValidation`: the default `final-only` strategy validates the integrated tree on the last merge in a serial join, while `every-merge` validates each source-lane merge. Do not plan as if all merge conflicts must be avoided.

Contexts **sharing** a lane are a different regime: one worktree, no merge between them, and the ownership envelope rather than the resolver is what keeps them apart. There, disjointness is a hard accept-time requirement.

Across lanes, plan for aligned intent rather than file disjointness:

- Two contexts on different lanes needing to touch the same file does **not** by itself preclude running them in parallel. Logically independent edits to a shared file merge cleanly or resolve straightforwardly.
- Do not serialize contexts on separate lanes merely to avoid merge conflicts.
- What parallel contexts must share is intent: contracts, conventions, and vocabulary declared up front — in the charter or a short foundation context — so their changes compose.
- When the same overlap sits inside one lane, it is not a merge question at all: separate the lanes, make the ownership disjoint, or order the members.

Parallelize when all of these are true:

- Contexts make logically independent changes, aligned by shared contracts, even if their file sets overlap.
- No context needs another context's implementation details to make good decisions.
- Validation can be judged locally for each context.

Stay sequential when contexts are semantically coupled — when running them in parallel would mean two agents independently designing the same behavior:

- Contexts change the same state machine, runtime lifecycle, adapter contract, or persistence schema in ways that must compose behaviorally. Automatic resolution fixes textual conflicts; it cannot make two independently designed changes to one design surface coherent.
- A backend support decision is still unverified.
- One context's implementation would be useful foundation context for another agent, even without a hard dependency.
- Diagnostics, retries, and status semantics span several contexts and need a single authoritative vocabulary.

A conflict the resolver cannot handle halts the workflow at the join, so heavy overlap on a coupled surface still carries risk; prefer a short foundation context that lands the shared contract first, then parallelize freely on top of it.

## Placement failure modes

- Ownership without a race: `mode: "owned"` on a context that is alone on its lane or ordered against every lane-mate. The list buys no concurrency, and the first legitimate write it fails to foresee is a denied tool call or an `ownership_violation` halt. Use `full`.
- File-grain ownership: `ownedPaths` lists the files that exist today, so the first new test file the implementer creates is denied at the tool boundary. Own the directory.
- A shared surface with two concurrent owners: two same-lane members both claim the barrel, the lockfile, or the shared `schemas.ts`. Refused at accept time — home it upstream or order the members.
- A gate asked of an enveloped context: `scriptValidator.commands` selected for a context that shares a lane, where the gate does not run and the barrier is the join. Either put the thesis on `laneMergeValidation` or give that context its own lane. (The agent's own `agentValidation` commands are unaffected — only the automatic gate defers.)
- Instructions that ask an implementer to commit: `.git` is denied under the envelope, so "commit your work", "rebase onto main", or "stash first" are impossible instructions the agent will burn a turn discovering.

## Placement checklist

- Every context carries `placement`, every read-only context also carries an `outputSchema`, and no write-capable context sits on the `session` lane.
- Every `mode: "owned"` context has at least one write-capable lane-mate nothing orders it against; every other write-capable context is `full`.
- Same-lane members that nothing orders own pairwise-disjoint, directory-grain prefixes; shared surfaces (barrels, lockfiles, schema files) have exactly one owner or live in an upstream context.
- Any `scriptValidator.commands` on an enveloped context is empty or a subset of the lane's `laneMergeValidation` selection, and every check the plan relies on is owned either by a barrier or by a single-member lane.
- No task instruction asks an implementer to commit, stash, rebase, or clean the tree.
- Parallel branches are truly independent or have an explicit foundation edge.
