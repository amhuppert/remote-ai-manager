# Workspace write relaxation: no interactive locks, worktree-level confinement

**2026-10-15 follow-up.** Alex removed the owned-path write restriction entirely.
Seats run from their assigned worktree with the whole tree writable; owned and
readOnly scopes remain task, scheduling, evidence and landing metadata. There is
no post-turn scope-violation gate. Materialized document copies are writable;
canonical artifact bytes and frozen revisions remain immutable. This supersedes
the named-path exceptions and scope-violation enforcement proposed below. The
existing boundary outside the worktree remains, as do the backend network and
settings policies; this follow-up does not implement the separate network and
settings proposals in slices 2 and 3.

Design amendment to `docs/design/2026-10-02-shared-conversation-design-r2.md` (§6.1, §6.2, §6.5, and the places
§4 lists) and to `docs/design/2026-10-12-claude-between-turns-c5b.md` (§3.2, §4.1, §5, §6, §9.1).

**Decision.** On 2026-10-14 Alex chose two changes and kept parallel writers in one worktree:
- **Interactive work never waits and is never waited on.** No interactive conversation holds a worktree lock, and lane
  publication protects uncommitted work with Git's own checks instead of requiring a clean session worktree.
- **Confine seats to their worktree, not to paths.** A confined seat runs in its worktree with the whole worktree
  writable except named paths. Its owned scope becomes a contract that is checked after each turn.

**Status.** Revision 3. Revision 2 answered the Opus and Astra reviews (`.cc/temp/reviews/write-relax-design-{opus,
codex}.md`, cited "O-n" and "A-n"): it replaced the dry run, compare-and-swap and `read-tree` refresh with a single
`git merge --ff-only`, made a scope violation a halt, and let session writers run before a publication. Revision 3
answers Astra's verification of revision 2 (`.cc/temp/reviews/write-relax-design-verify-codex.md`, "V-n") and records
Alex's decisions D1–D4 (§5). Dispositions for all three: `.cc/temp/reviews/write-relax-design-dispositions.md`.
Slice 1 (§2) is implemented (`.cc/temp/overhaul/relax-s1-report.md`; its reviews `.cc/temp/reviews/relax-s1-{opus,
codex}.md` and their dispositions `.cc/temp/reviews/relax-s1-dispositions.md` corrected §2.1–§2.3, §2.5 and §2.6);
slices 2 and 3 are not.

**Sources.** Facts and citations: `.cc/temp/overhaul/write-relax-research.md`, cited "R§n".

## 1. The problem

Two live tests on 2026-10-14 (R§0) showed the write restrictions causing more trouble than they prevent:

- **A deadlock.** The owner of a lane run ended its turn with a background loop polling the run. Its Claude runtime
  stayed in custody, and custody holds an `interactive_write` grant on the session worktree (R§1). Lane publication
  needs a `git` grant there, which waits for every interactive grant. The loop waited for the run and the run waited for
  the loop for 33 minutes, while `cctl run show` reported no stall, halt or reason. Custody's bound is 120 minutes.
  Any wait in an owner turn, foreground or background, deadlocks a run with lanes.
- **Unrelated work blocks publication.** Publication refuses any uncommitted file in the session worktree and then runs
  `reset --hard` (R§2). An owner's unrelated edit, or a finished session context's uncommitted result, halts every
  later lane publication until someone commits or removes it.
- **Per-path sandboxes distort the seats.** Both native sandboxes make the cwd writable, so a seat confined to part of
  a worktree runs from a scratch folder outside it (R§7). That cost the Codex seats `AGENTS.md` and the project skills,
  blocked an owned Claude seat from creating its own missing parent folder, made Edit/Write and Bash enforce
  differently, and makes briefings and `cctl` path handling special for confined seats (R§9).

What the restrictions protect, and what must keep being protected, for one operator on one machine:
1. uncommitted work survives a publication;
2. parallel seats in one worktree do not overwrite each other's files, and the right seat is blamed when one does
   (owned landing trusts that no other seat writes its paths, R§10);
3. a seat's work stays within its declared scope, so its landing, evidence and review cover what it changed.

## 2. Interactive work holds no lock

### 2.1 Grants

- Delete the `interactive_write` grant kind and `jumpsTheQueue` (`admission.ts`). The conflict relation keeps
  `observe`, `scoped_write`, `full_write`, `stable_read` and `git`; `git` conflicts with every supervised kind.
- User turns and task turns (`/commit`, conflict resolution, validation fix, tickets) take no grant: delete
  `interactiveGrant`. The grant polling loop stays, because seat turns still use it.
- **Custody holds the runtime, not a grant** (amends C5b §3.2 and §4.1). A conversation's background work no longer
  affects any other operation's admission. The conversation's own guard against an uncollected runtime stays
  (`readyForMessage`), and seat grants are still quarantined. Custody's quarantine goes with its grant, but a seat whose
  processes could not be confirmed stopped keeps its grant, so a publication into that seat's worktree waits until the
  server restarts (§2.6).
- **Delete the restart fence** (amends C5b §6 and §9.1). It kept turns and publications off a worktree for 5 s after a
  restart, while orphaned background work could still write. Turns are no longer gated by grants, and a publication
  racing an orphaned writer is the same case as one racing any interactive edit (§2.3).
- Interactive turns no longer wait for Git operations on their worktree. They are cooperative writers in every respect:
  files a publication changes can appear under a running turn, as they would after an owner's own `git pull`.

### 2.2 Publication

The workspace executor's `publish` keeps its shape (R§2):

1. **Capture reads the session branch ref without a grant.** A ref read touches no worktree. The `stillAdmitted` check
   stays where it is.
2. **Integration** in the lane is unchanged.
3. **The final step** still takes the session's `git` grant and the session lock. The grant waits for supervised grants
   on the session worktree: this run's session contexts, which the schedule orders against publications (§2.4), and
   other runs' seats there. The lock waits for CC's own Git jobs (commit, merge, rebase, resolve conflicts, R§3).

The lane publish step in `lane-git.ts` becomes four steps, and stays separate from the shared `publishPreparedMerge`,
which keeps its behaviour for the session-into-main merge (R§3):

1. **Checks**, unchanged: the session branch is checked out; its head is the incorporated head (else `stale`); no merge
   is in progress; the lane contains that head.
2. **Prepare** the squash commit `P` with `prepareSquashMerge`, as today. `P`'s parent is the head.
3. **Merge** in the session worktree:

   ```
   git -c core.hooksPath=/dev/null merge -q --ff-only --no-squash --no-overwrite-ignore --no-autostash
       --no-verify-signatures <P>
   ```

   Git's fast-forward checks every path, writes the index and the files, then moves the branch with the head as the
   expected old value (O appendix M13; V publication table). It keeps every uncommitted change, staged or not, to files
   the lane does not change, and untracked files elsewhere. It refuses, leaving the branch, index and worktree as they
   were, when a local change, an untracked file or an ignored file (including one at a parent path, or a dangling
   symlink) is in the way of the lane's files, including files the lane deletes or renames (dispositions, merge probe;
   V publication table). It refreshes stat information itself, so a file that was touched but not changed does not
   block. Hooks are off, so a project `post-merge` install does not run; `--no-autostash` keeps Git from pushing onto
   the stash every worktree shares; `--no-squash`, `--no-verify-signatures` and the explicit `--ff-only` override
   repository and branch merge settings (`branch.<name>.mergeOptions=--squash` otherwise makes the command exit 0
   without moving the branch, V-2).
4. **Classify** Git's result and delete the parked ref after every attempt (each attempt prepares its own commit).
   Success is a postcondition, not an exit code: the session branch's head is `P`. A lock is told by the path Git
   names in "Unable to create '<path>': File exists", compared with `git rev-parse --git-path` for the session
   worktree's index lock and the session branch's ref lock.

   | Git result | Outcome |
   |---|---|
   | The branch head is `P`, whatever the exit status | `published` with commit `P` |
   | Exit 0 and the branch head is not `P` | `publication_failed`, naming the head found |
   | The branch moved off the incorporated head ("Not possible to fast-forward", or the ref update lost its expected value) | `stale`: a new attempt integrates the new head |
   | The session worktree's `index.lock` exists | wait: watch the lock file, holding no grant, lock or Git process, and run the step again once it is gone; `waitingOn` names the lock (§2.5) |
   | The session branch's ref lock exists: Git wrote the index and files, then could not move the branch | the same wait; the next try accepts index entries that already equal `P` |
   | Local changes, untracked or ignored files would be overwritten | `publish_blocked`, with Git's path list |
   | Unmerged index entries without a merge in progress (after a conflicted cherry-pick, say) | `publication_failed`, with Git's "Merging is not possible because you have unmerged files" |
   | Any other lock, a lock error other than "File exists", anything else | `publication_failed`, with Git's message |

Deleted: `dirtyPaths` as a publication gate, `replacedUntracked` (which `--no-overwrite-ignore` supersedes and which
had false positives, O-1), and `reset --hard` in lane publication.

### 2.3 Completion and residual risks

There is no longer a state in which the branch holds `P` while the index still holds the old head: Git writes the index
before it moves the ref.

- **Restart recovery** keeps finding a publication by its `CC-Publication` marker. A marker on the session branch means
  the publication is complete; no marker means the attempt is requeued. `completePublication` and its classifier are
  deleted.
- **A crash after Git wrote the index but before it moved the ref** leaves the head unchanged and the lane's files in
  the index. The requeued attempt prepares a commit with the same tree, and the merge accepts index entries that already
  equal the target (O appendix M14).
- **An owner commit during the merge**, between the index write and the ref move, commits the lane's content as part of
  the owner's commit; the merge's ref update then fails and the publication is `stale`. The next attempt finds the lane
  already applied and publishes `unchanged`. No reversal reaches history. Astra reproduced this for a modified, a
  deleted and a renamed lane file (V publication table). Slice 1's integration test interleaves the commit at the
  `post-index-change` boundary, as Astra did.

Residual risks, accepted for this envelope:
- **An edit to a lane file while the merge runs** can be overwritten. Git checks every path before it writes any, so the
  window is the length of the command and grows with the size of the lane.
- **An index change while the merge runs** can be overwritten (V-1). Git reads the index before it takes the index
  lock, so a `git add` landing in between is replaced by the merge's index, even for a file the lane does not touch.
  The file's content on disk survives; only a staged snapshot that differs from the working file is lost from the
  index.
- **A lane brings back a file the owner deleted** without staging the deletion, when the lane modifies it.
- **A crash during the merge's file writes.** Git writes the worktree files before the index, so a crash or signal in
  between leaves some lane files written while the index still holds the old head. The requeued attempt reports
  `publish_blocked` naming the lane's own files; restoring them to HEAD clears it. Nothing is lost: Git checks every path
  before it writes any, so those files held no owner work.
- **The merge holds `index.lock` while it runs**, the converse of V-1: an owner's `git add` or `git commit` in that
  window fails with "index.lock exists" and has to be run again.
- **Lane content can reach the session before `published`**: an owner commit during the merge carries it (above), and a
  held ref lock leaves it staged. `published` is what lets work that needs the lane's code start.
- Submodules, sparse checkout and checkout filters get no special handling; Git's own behaviour applies.

### 2.4 Ordering rules

Session contexts stay ordered against each lane's publication, never concurrent with it, because a publication changes
files a session context's candidate is judged on, and a full-scope context's evidence is the whole tree. This amendment
gives writers the rule readers already have: a session writer runs either after the lane's work or before it (the
lane's work depends on it, `outputOnly`). A finished writer's uncommitted files no longer block publication unless they
collide with the lane's files. In `checkWaits` (`workflow-definition.ts:640-657`) the writer branch takes the reader's
`before` set; the refusal messages, `src/cli/commands/run/definitions.ts:73` and `run-planning/references/
placement.md` drop "its uncommitted results block publication".

### 2.5 Observation

A waiting publication says what it waits for.
- The workspace executor records, in memory, why each running operation is waiting: the holders of the grants it waits
  for, a session lock held by a named CC job, or a held Git lock (the index lock or the branch's ref lock, which may be
  stale). A publication queued behind another lane's publication into the same session names that lane.
- `admission.blockers()` is fixed to report only waiters ahead of the request; today it reports every conflicting
  waiter, including later ones (`admission.ts:245-255`).
- Run observation adds `waitingOn` to each lane's view. `cctl run show` prints, for example,
  `publishing (attempt 1), waiting for commit job <id> to release the session`.
- The executor logs `workspace.publication_waiting` when a wait starts, with its holders, and
  `workspace.publication_wait_ended` with its duration.

### 2.6 What can still make a publication wait

- **A CC Git job.** The session lock is held for a whole job. One cycle remains (O-5, A-4): the owner waits on its run
  in the foreground, a concurrent commit job fails validation and queues a fix on that owner, and the fix waits behind
  the owner's turn. It needs a foreground wait, which the run-planning skill tells owners not to make. `waitingOn` names
  the job, and cancelling the job breaks the cycle.
- **Another run's seat in the session worktree**, for example one holding its grant while it waits for its owner's
  answer. `waitingOn` names it.
- **A quarantined seat.** A seat whose processes could not be confirmed stopped keeps its grant on its worktree until the
  server restarts, and a publication into that worktree waits as long. `waitingOn` names the seat's turn.
- **Another lane's publication into the same session.** Publications into one session run one at a time. `waitingOn`
  names the lane.
- **A Git lock.** Any Git process in the session worktree, an interactive turn's included, briefly holds its index lock;
  one that died can leave the lock, or the branch's ref lock, behind. `waitingOn` names the lock; a lock left behind is
  deleted by hand once no Git process runs there.

No interactive conversation, and no conversation's background work, holds a grant that directly delays a publication;
the job cycle above is the remaining indirect wait.

## 3. Confining seats to their worktree

### 3.1 One envelope

Every seat that is confined today, an implementer with an owned or read-only scope, gets the same envelope:

- **cwd: the worktree root.** The scratch folder and its root are deleted. The payload directory is
  `<worktree>/.cc/temp/<context>` for every seat, read-only ones included; scratch files and document copies go there.
- **Writable:** the worktree and the per-context temp directory (kept outside the worktree for the AF_UNIX path budget,
  R§7).
- **Denied:**
  - `.git`;
  - `.cc/run-docs`, so a seat cannot plant a link that breaks another context's document delivery (R§9);
  - the owned paths of every other context in the same workspace in the run's current definition, except paths that
    overlap the seat's own (O-7). The set is recomputed when each turn starts; a changed set, after an amendment,
    recreates the runtime at that turn boundary, which `fsWritePolicy` already triggers (R§9).

Two residuals are named; the scope check (§3.3) covers tool writes in both, not shell writes:
- seats of **other runs** in the same worktree are not in the deny list;
- a context an amendment adds starts at once, while a running seat's current turn still lacks its deny until the next
  turn starts (V-4).

A read-only scope is an owned scope with no paths: the same envelope. The compiler already keeps read-only contexts
from running beside writers in one worktree. Read-only remains a semantic scope: it still selects whole-tree evidence,
no write grant, accept-in-place and reader ordering (A, "what to keep").

`checkFsWritePolicy` already accepts denies inside an allow (R§7). The policy's ordering contract becomes
`allowWrite = [worktree, tmp]` with the worktree as cwd.

Full-scope implementers and reviewers keep running unconfined (`bypassPermissions` or `danger-full-access`, R§7), as
Alex decided for reviewers on 2026-10-04. Giving them the same envelope would protect `.git` everywhere; that is a
separate decision.

### 3.2 Per backend

- **Claude.** Sandbox `allowWrite` is the worktree (the cwd) and the temp directory; `denyWrite` is the deny list.
  Edit, Write and NotebookEdit get the matching permission rules: allow the worktree and temp, deny each denied path as
  both `//<path>` and `//<path>/**`. The sandbox network opens to every domain (D2). Confined Claude seats load the
  same setting sources as every other Claude seat (`["user", "project", "local"]`, D3), so they get CLAUDE.md and the
  project's settings, as Codex seats regain `AGENTS.md`. Accepted by Alex: a user or project `Edit(...)` allow rule
  adds writable folders, possibly outside the worktree, because the SDK merges those rules into the sandbox's
  `allowWrite` (A-7). CC's denies must still win and the sandbox must stay on whatever the settings say (P2d).
- **Codex.** cwd is the worktree and `writable_roots` the temp directory, so the post-start verifier's set
  `{cwd} ∪ writableRoots` still equals `allowWrite` (R§8). `.git` relies on Codex's built-in protection under writable
  roots, and the linked worktree's gitdir must not become a writable root (P3). The sibling and `.cc/run-docs` denies
  use a filesystem permission profile if the installed CLI supports one (P3); the verifier then checks the effective
  profile after start and after resume. Without that support those denies are instruction-only for Codex, as everything
  is for Cursor, and the scope check is the guard. Running from the worktree gives Codex seats `AGENTS.md`,
  `.agents/skills` and the managed skills back (R§9).
- **Cursor.** Still instruction-only. The rendered text says: write anywhere in the repository except the denied paths;
  your scope is these paths.
- **Briefing.** The repository is the working directory: drop the absolute-path instruction and the scratch folder.
  State the owned scope as what the seat is responsible for and judged on; list the denied paths; say that a change to
  a file outside the scope halts the work for the owner; put scratch files and document copies in the payload
  directory; never restore content you did not write. A shared manifest or lockfile has one owner (placement.md), and
  the network being open does not change that. `briefing.ts` and `payload-location.ts` become true for every seat
  (R§9).

### 3.3 The scope check

- **Input.** Each backend adapter reports the turn's successful file writes as repository-relative paths: Claude
  Write, Edit and MultiEdit `file_path` and NotebookEdit `notebook_path`; Codex `fileChange` items, including a rename's
  destination; Cursor tool arguments that name a path, best effort. A failed or denied tool call is not a write. Whether
  a Claude sub-agent's edits reach the parent turn is premise P6. Conversation carries the list on the settled turn
  report.
- **Judgment.** Execution Context checks the list at the common report boundary for every confined implementer turn
  (work, output capture and advice), before the kind-specific settlement, continuation and certification, so no review
  is spent on work a violation stops (V-3). A turn that ended unsuccessfully is still judged on the writes it recorded.
  A violation is a path inside the repository that is not ignored, outside the context's owned paths, and outside its
  payload directory. The rule is the same for every scope; a read-only scope has no owned paths.
- **Effect.** The context halts with `scope_violation`, naming the turn and each path, for the owner (D4). The files stay
  as they are: the owner restores, keeps or reassigns them, then resumes with `continue`. Nothing restores content
  automatically; the seat is told never to restore content it did not write, because HEAD is not the pre-turn state and
  cooperative writers may have uncommitted work in the same file (O-3, A-5).

This is a best-effort guard for attributable writes, not a completeness proof (A-8). **Shell writes are not recorded
per file by any backend** (R§10). Their guards are the OS denies of §3.1 where the backend enforces them; in a lane,
publication's existing refusal of unlanded changes; and in the session worktree, nothing: a stray shell write stays as
an uncommitted change, like a person's edit. A whole-tree diff cannot replace the records: parallel scoped writers and
interactive turns run at the same time, so it would blame the wrong author (R§10).

### 3.4 What changes for the seats

- Parents of an owned path that do not exist yet can be created.
- Ignored folders (`node_modules`, `.next`, caches) become writable to confined seats. Two parallel seats in one
  worktree can now run installs or builds into them at the same time, and evidence and unlanded-path checks skip
  ignored files. Named and accepted: parallel seats that build should use lanes.
- Owned landing is unchanged. Its trust that no other seat writes its paths rests on the sibling denies where the
  backend enforces them, and on the scope check otherwise. On Cursor, and on Codex without P3b, a sibling's tool write
  into a seat's path halts the sibling, but if the seat lands first, its landing commits that write.

### 3.5 Deleted

- The scratch folder, `SCRATCH_ROOT_DIR_NAME`, and the cwd relocation in `write-envelope.ts` and the Codex envelope.
- `contextPayloadDirectory` and the task-path envelopes that no production caller reaches (`buildClaudeFsWriteEnvelope`,
  Codex `HERMETIC_CONFIG`, the restricted branch of `task-run-permissions.ts`, `laneTmpDirName("validator")`, R§11).
- The briefing's absolute-path and scratch-folder instructions.

The temp directory, `checkFsWritePolicy`, the glob-character refusal in owned paths (still needed for Claude's rules)
and the compile-time placement rules other than the writer rule of §2.4 stay.

## 4. Persistence, deploy and documents

- **Schema changes.** The settled turn report gains the list of written paths, and Execution Context gains the halt kind
  `scope_violation` with the disposition `continue`. Both follow the domain schema rules, with repository round-trip
  fixtures (AGENTS.md). No new tables or columns are expected. Publication outcomes keep their kinds; `publish_blocked`
  carries Git's message as its detail.
- **Deploy.** `fsWritePolicy` is a runtime-recreate dimension (R§9): a confined seat with a live runtime at deploy is
  recreated under the new policy, and Claude may not resume a session started from a different cwd. Deploy with no run
  active.
- **Documents amended with the code:**
  - r2: the front matter (decision 9 and the amendment list), §6.1 ("backend-native restrictions enforce scoped
    writes"), §6.2 (the interactive row of the conflict table and the prose that publications wait for interactive
    turns and CC Git effects wait for the turn), §6.5 step 3, the §12 journeys (`:866`, a clean session target;
    `:870`, publication waiting for the owner's turn and any dirt blocking it), the §16 acceptance example, and §17's
    limits and decisions 1 and 5, marked superseded rather than removed;
  - C5b: §3.2, §4.1 handover, the §5 table row for lane publication, §6's restart rule and cleanup, §9.1;
  - the notepad's Workflow section, which r2 §17 decision 1 names as the rule's record;
  - `src/cli/commands/run/definitions.ts:73`, the `run-planning` skill (`references/placement.md`: "Your own
    uncommitted changes in the session worktree block a publication too", and the reasons table), and
    `cc-cli/references/runs.md` (where to copy a run document).

## 5. Decisions (Alex, 2026-10-14)

- **D1. Deny siblings' owned paths in the OS where the backend can,** using §3.1's set. Without it, a seat writing into
  a sibling's path is committed by the sibling's owned landing and retires the sibling's candidate instead of being
  blamed (R§10).
- **D2. Open the network for confined Claude seats,** like every other seat, including confined Codex seats (R§8).
  Today they can reach only the CC host and cannot install packages.
- **D3. Load project settings for confined Claude seats,** the same sources as every other Claude seat. The reviews
  recommended keeping them off, because a project's ordinary allow rules can add writable roots outside the worktree
  that no deny of ours prevents (A-7). Alex chose consistency and CLAUDE.md, accepting that widening. P2d must hold:
  loaded settings cannot turn the sandbox off or remove CC's denies. If they can, slice 3 returns to Alex first.
- **D4. Halt for the owner at the first scope violation.** Sending the work back loops (the seat's undo is another
  out-of-scope write) and invites restoring from HEAD, which destroys cooperative work (O-3, A-5).

## 6. Premises

- **P1** (verified, R§12): two-way `read-tree -m -u` keeps unrelated uncommitted work. Kept for the record; publication
  uses `git merge` instead.
- **P5** (verified on this Mac, Git 2.39.5; dispositions, O appendix M1–M16 and the V publication table): the merge
  command of §2.2 keeps unrelated work; refuses collisions (tracked, untracked, ignored, ignored ancestors, dangling
  symlinks, files the lane deletes or renames) leaving branch, index and worktree as they were; passes
  touched-but-unchanged files; refuses a moved head and a held `index.lock`; writes the index before the ref, so an owner
  commit in between carries the lane's content and the merge fails stale; replays cleanly after an interruption between
  index and ref; and overrides repository and branch merge settings with `--no-squash`. Slice 1's integration tests pin
  these cases with a real repository. The Linux host's Git is checked when that host deploys.
- **P2** Claude sandbox on macOS: (a) `denyWrite` inside the writable cwd holds for an existing and a missing path,
  including symlink and case aliases; (b) Edit/Write deny rules match a file and a folder path; (c) the sandbox network
  setting that allows every domain; (d) with user, project and local settings loaded, no setting turns the sandbox off,
  exempts a command from it (`excludedCommands`, `allowUnsandboxedCommands`) or removes CC's denies. On the Linux host
  (bubblewrap), (a) is checked at its deploy.
- **P3** Codex CLI 0.159: (a) `.git`, and a linked worktree's `.git` pointer file, are read-only under a writable cwd;
  (b) a filesystem permission profile can deny paths under a writable cwd, and how the app-server reports it after
  start and after resume; (c) the linked worktree's gitdir is not added as a writable root.
- **P6** Write records: only successful writes appear; Codex reports a rename's destination; whether a Claude sub-agent's
  (Task) edits reach the parent turn's records. If they do not, sub-agent writes join the shell-write residual.

## 7. Implementation slices

Each slice follows the session's process: implementer, Opus and Astra reviews, dispositions, full suite, commit.

1. **Publication without interactive locks** (§2): admission and `blockers()`, conversation core, custody, restart
   fence, the lane merge step, recovery, the writer ordering rule, observation, and the guidance and design-text
   amendments for §2. Independent of the rest; it fixes the deadlock.
2. **Premise probes** P2, P3 and P6 on this Mac, reported before slice 3.
3. **Worktree envelope and scope check together** (§3): envelope composition, the Claude and Codex adapters, Cursor
   text, briefing, write records on the settled report, the `scope_violation` halt, and the §3 document amendments.

Tests that pin today's behaviour and change with slice 1 are listed in R§5; slice 3's in R§11.

## 8. Acceptance probes

Live, after the slices land:

- **A1.** Repeat the lane smoke test (`run-d24f58e5`) while the owner runs a background task and edits an unrelated
  tracked file during publication: every lane publishes, and the edit is kept.
- **A2.** The owner edits a file a lane changes: publication is blocked naming that file; after the owner reverts it,
  `cctl run retry --lane` publishes.
- **A3.** A CC commit job holds the session while a lane publishes: `cctl run show` names the job.
- **A4.** An owned Claude seat whose scope's parent folder is missing creates it from Bash, and it has CLAUDE.md. Its
  write into a sibling's path is denied and does not halt it. A Write-tool change outside its scope halts the context
  naming the file, and an owner's uncommitted edit in that file survives.
- **A5.** An owned Codex seat reads `AGENTS.md` and its managed skills; its effective policy shows the worktree and temp
  directory as writable roots and, if P3b holds, the sibling deny.
- **A6.** A read-only seat writes its `--file` payload under its payload directory without a violation, in a context
  with no checks or reviewers; a repository write by it halts the context.
- **A7.** An amendment adds a session context beside a running owned seat: the seat's next turn denies the new
  context's paths.

The crash between the index write and the ref move, and an owner commit during the merge, are covered by integration
tests with a real repository, not live.
