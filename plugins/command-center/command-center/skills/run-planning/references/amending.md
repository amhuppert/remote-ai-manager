# Amending a running workflow

Reference for [run-planning](../SKILL.md). Read it when a running workflow must change: a route halted on a result, a loop ran out of passes, work must be added or changed before it starts, or the documents or charter need correcting. Only the owner amends, only a workflow run can be amended, and only until it finishes.

## Procedure

1. Read the run and its definition revision: `cctl run show <run-id>` prints `definition revision N` on its first line.
2. Save the definition as written: `cctl run definition <run-id> > .cc/temp/workflow.json`. The text output is the definition alone; delete a trailing `hint:` line if one follows it. If stdout starts with a `notice:` line instead, the response was too large for stdout: the named artifact holds the response, and the definition is its `payload.data.definition` string.
3. Edit the file. It is the whole definition in the `run workflow` shape, as it should be from now on.
4. Check it, then amend, naming the revision you read and why:

```
cctl run amend-check <run-id> --file .cc/temp/workflow.json --based-on <revision>
cctl run amend <run-id> --file .cc/temp/workflow.json --based-on <revision> --reason "<why the definition changes>"
```

The check verb applies the topology rules locally. The rules below need the run's history, so only the amendment applies them; it refuses the whole amendment and names each refused change. An amendment that names `--based-on` is refused when the definition changed since that revision, so always pass it; without it, the amendment applies to whatever revision is current. When it is refused, read the definition again. The reply names the revision now in force, the halts that remain and any documents removed. `--reason` is kept with the charter and document revisions the amendment makes.

## What may change

Work that has not started, outside a started loop, may change, be added or be removed. What has happened stays as it happened:

- **A started context** stays exactly as written: its dependencies, routes, lane, brief, tasks, criteria, checks, output schema, seats and settings. It cannot be removed, join a loop or leave one; cancel the run to stop it. An amendment may also not change which of its own checks it runs, which depends on the work beside it: keep that work as it was, or order new work after the started context.
- **A started loop**: once any member starts, every member stays exactly as written, including members that have not run yet, and the loop keeps its body, entry, exit and `until`. Its `maxPasses` may only rise, and raising it runs another pass of an exhausted loop.
- **A decided route** stays decided: a route taken or not taken stays so, and a context or lane a route skipped stays skipped. Put new work in a new context or lane. Removing work can be refused when it would turn an `else` route the other way.
- **A halted route** may change: a result that broke its source's cardinality, or could not be read, may get new routes, which clears that halt.
- **A lane** that has been provisioned, or asked to be, keeps its contexts, its publication checks and its worktree, and its contexts cannot come to need another lane's code.

## Documents and the charter

Both are declared again in full. `cctl run definition` lists each current document as `{path, revision, description, readWhen?, appliesTo?}`:

- Leave an entry as listed to keep that revision, while it is still the latest; a seat may have published one since, and then you read the definition again.
- Add `from` or `contents` to replace a document. Keep its `revision` when a seat published the current one, so you replace what you read.
- Leave a document out to remove it, and leave the charter out to remove it, for work that has not started.

A context that already started keeps the documents and charter revision it froze; the change reaches only work that starts later, a later loop pass included.

## When not to amend

A started context's contract cannot change. When its brief or criteria are wrong (a `plan_defect` the reviewer is right about, or work converging on the wrong target), cancel the run with `cctl run cancel <run-id>` and launch corrected work. Session contexts' partial work stays in the session worktree; a lane's unpublished work stays on the lane's branch and worktree, and a relaunch starts without it.
