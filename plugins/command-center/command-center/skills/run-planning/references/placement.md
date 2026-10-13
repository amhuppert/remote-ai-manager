# Placement

Reference for [run-planning](../SKILL.md). Read it when contexts write at the same time, a context works in a lane, or the check verb refuses a scope, a lane or a check.

A context works in one **workspace**: the session worktree, or the worktree of the lane it names. Only contexts in the same workspace can change files under each other, so every rule below applies per workspace. The check verb applies all of them and names the dependency or scope to change.

## Scopes

| `scope` | May write | Use for |
|---|---|---|
| absent, or `{"mode": "full"}` | the whole workspace | a writer nothing else in its workspace runs beside |
| `{"mode": "owned", "paths": [...]}` | only those paths | writers that run side by side in one workspace |
| `{"mode": "readOnly"}` | nothing | surveys, judges, classifiers and reviewers of earlier work |

- Two contexts run side by side when neither depends on the other, directly or through others, and no route excludes one of them. Side by side, their scopes must be disjoint: owned paths that do not contain each other. A full scope overlaps everything.
- A read-only context reads the whole workspace, so it cannot run beside any writer there; two readers can. Its result is its whole deliverable: give it an `outputSchema` when later work or a route reads the result.
- An owned path is a repository-relative directory or file, with no `.` or `..` parts and no trailing `/`, never the root, `.git` or `.cc`, and never a glob. It may not contain `[ ] ( ) { } * ? !`, even in a directory name: own the nearest parent directory without them instead. Prefer directories: implementers create files you did not plan, and may not write outside their scope.
- A shared surface (a barrel file, a lockfile, a shared schema) has one owner. Home it in a context the others depend on, or order the contexts.
- Give `owned` only where two writers really run side by side. A context ordered against every other writer in its workspace takes the full scope.

## Checks on a shared workspace

A selected check runs over the workspace's changes against its target branch, other contexts' changes included. When another writer can run beside a context, that context's check would judge the other's half-finished work, so it is not run for that context, and its reviewers are told so. Something must run it on the assembled tree, or the check verb refuses the workflow:

- in the same workspace, a later context that depends on it, directly or through others, that runs whenever it runs (no route can skip it), and that selects the same check; that context's own check is judged the same way;
- or, for a context in a lane, the lane's publication checks (`lanes: [{key, checks}]`) when they include the check.

## Lanes

`"lane": "<key>"` puts a context in an isolated lane: its own worktree and branch. Lane keys are 1–32 lowercase letters, digits, `-` or `_`, starting with a letter or digit and not ending with `-`. Several contexts can share a lane; declare its publication checks with `"lanes": [{"key": "<key>", "checks": ["<check>"]}]`.

- A lane starts from the session branch's committed head once every lane whose code its contexts need has published. Each accepted result in the lane is committed on its branch.
- When all its contexts are done or skipped, the lane is merged with the current session head. Agents resolve conflicts and fix failing publication checks in the lane, then the lane publishes into the session branch, and the session worktree moves to it.
- Work outside the lane sees the lane's code only after it publishes. A lane context that depends on a context in another lane waits for that lane to publish, unless the dependency is `outputOnly`.
- A lane cannot see a session context's code, which is never committed. When a lane context needs only a session context's result, write the dependency as `{"key": "<key>", "outputOnly": true}`; otherwise place the dependency in a lane too.
- `outputOnly` lifts only a lane context's wait for code. A session context stays ordered against each lane's publication whatever its dependencies say ([below](#session-contexts-around-a-publication)), so give a session context a plain dependency on lane work.
- Lanes that would wait for each other's code are refused; mark a dependency `outputOnly`, or move the contexts into one lane.
- A loop runs all its passes in one workspace.

Use a lane for risky, long or self-contained work that should land as one checked merge, or when parallel writers cannot have disjoint scopes. Keep simple sequential work in the session worktree: a lane costs a worktree, a merge and the ordering rules below.

## Session contexts around a publication

A publication changes the session worktree, and any uncommitted change there blocks it. So every session context must be ordered against each lane's publication:

- a session **writer** depends on the lane's work, so it runs after the publication;
- a session **reader** either depends on the lane's work, or the lane's work depends on it (`outputOnly`), so it finishes before the lane publishes.

In this workflow the read-only survey runs first, the lane works on its result, and the release notes are written after the lane publishes:

```json
{
  "title": "Move billing to the new ledger",
  "lanes": [{ "key": "billing", "checks": ["test", "typecheck"] }],
  "contexts": [
    {
      "key": "survey",
      "brief": "List every caller of the old ledger API and what each one needs from it.",
      "scope": { "mode": "readOnly" },
      "outputSchema": { "type": "object", "properties": { "callers": { "type": "array", "items": { "type": "string" } } }, "required": ["callers"] }
    },
    {
      "key": "ledger-schema",
      "lane": "billing",
      "brief": "Add the new ledger tables and their repository.",
      "dependsOn": [{ "key": "survey", "outputOnly": true }]
    },
    {
      "key": "billing-service",
      "lane": "billing",
      "brief": "Move the billing service onto the new ledger repository.",
      "dependsOn": ["ledger-schema"]
    },
    {
      "key": "release-notes",
      "brief": "Describe the ledger move in CHANGELOG.md.",
      "dependsOn": ["billing-service"]
    }
  ]
}
```

Your own uncommitted changes in the session worktree block a publication too. Commit or remove them before a lane finishes.

## When a lane stops

A lane that cannot be provisioned or published halts the run. Lane contexts that do not need it go on; session contexts wait for every unpublished lane, except one whose work waits for them. `cctl run show <run-id>` prints each lane's state, worktree, branch, attempt and the reason it stopped. Fix the cause, then ask for a new attempt:

```
cctl run retry <run-id> --lane <key>
```

| Reason | Fix |
|---|---|
| the session worktree has changes publication would overwrite or leave behind | commit or remove them |
| the session branch moved after the lane was checked | nothing; the new attempt merges the new head |
| the merge conflicted, or a publication check failed and the agents could not fix it | fix the cause the detail names |
| provisioning failed | fix the cause the detail names |
| whether the session holds the publication is uncertain | follow the detail, which names the commit and the worktree |

A new publication attempt merges the current session head into the lane and runs its checks again; a provisioning retry only provisions the lane.
