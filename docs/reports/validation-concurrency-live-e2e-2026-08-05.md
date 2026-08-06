# Validation-concurrency live E2E acceptance

Date: 2026-08-05 (live events crossed 00:00 UTC on 2026-08-06)  
Status: **PASS**

This report records the green rerun of the validation-concurrency live acceptance matrix. It exercised the assigned worktree through the real Next.js server, browser UI, fixture datastore, `cctl validate`, real Codex workflow lanes, graph joins, process groups, and persisted SQLite ledger. The earlier isolation failure is retained below as useful RED evidence; all acceptance mutations in this rerun targeted the exact assigned lane.

## Isolation and production-shaped fixture

- Assigned and resolved worktree: `/Users/alex/github/command-center/.worktrees/granular-validation-scripts-and-parallelism-limits-fb4230.consumer-migration`
- The green preflight obtained the app through `cctl dev ensure nextjs` at its isolated port 3001; no assumed shared port was used.
- Next.js `get_project_metadata` returned that exact path before the first mutation and again after the simulated unclean restart.
- Fixture creation returned that same worktree and `/Users/alex/github/command-center/.worktrees/granular-validation-scripts-and-parallelism-limits-fb4230.consumer-migration/.config/command-center.db` as its durable database.
- The disposable `validation-e2e` Git project was committed at `8d73dce687cdeab3c556b7c80ce575ff82bd3cb5` before sessions were created.
- Fixture sessions `fx-validation-e2e` and `fx-validation-budget` were created through the production fixture CLI. A third post-restart gate fixture independently re-proved the same target.
- All retained ledger evidence and pre-cleanup transcript observations cited below came from the assigned lane's `.config`, not a sibling worktree.

The first attempt correctly stopped when `cctl dev ensure` resolved a stale sibling build. Its screenshot remains as [the original hard-gate failure](assets/validation-concurrency-live-e2e/00-config-wrong-build.png). The remediation added verified context-aware dev and fixture targeting; this rerun passed the gate twice.

## Global configuration UI round-trip

Global Settings was changed through the browser, saved, reloaded, and read back through `/api/config`. Both raw and effective values matched:

| Setting | Saved value |
|---|---:|
| `validation.concurrencyLimit` | `4` |
| `validation.defaultTimeoutMs` | `120000` (2 minutes) |
| Script validation | only `gate-auto` |
| Implementer commands | every registered command except `format` |
| Context-validator commands | only `allowed` |
| Lane merge | `every-merge`, custom `merge-project` |

Evidence:

- [Script policy](assets/validation-concurrency-live-e2e/01-global-script-policy.png)
- [Independent agent-role policies](assets/validation-concurrency-live-e2e/02-global-agent-policy.png)
- [Lane-merge mode and command](assets/validation-concurrency-live-e2e/03-global-lane-merge-policy.png)
- [Reloaded capacity and timeout](assets/validation-concurrency-live-e2e/04-global-limits-readback.png)

The exact pre-test raw global configuration was saved before mutation and restored during cleanup.

## Workflow and context policy cascade

The browser created workflow definition `7ed153aa-f71c-4cc9-97b1-e34ba4645ad4`, renamed it to `Validation Concurrency Live E2E`, and exercised all three provenance levels before launch:

| Policy leaf | Context 1 | Context 2 |
|---|---|---|
| Script gate | per-node: `gate-auto` | workflow: `pre-merge` |
| Implementer | per-node: `allowed`, `scoped` | global |
| Context validator | workflow: `scoped` | workflow: `scoped` |
| Lane merge | no context-level selector | no context-level selector |

The workflow-level lane policy was independently set to `final-only` with custom command `merge-override`. The resolved definition API reported `per-node`, `workflow`, and `global` sources exactly as shown. The context editor exposed no lane-merge selector, which confirms lane merge remains a project/workflow policy rather than a context leaf.

Evidence:

- [Per-leaf context overrides](assets/validation-concurrency-live-e2e/05-context-per-leaf-overrides.png)
- [Inherited provenance](assets/validation-concurrency-live-e2e/06-context-inherited-provenance.png)
- [Workflow-level overrides](assets/validation-concurrency-live-e2e/07-workflow-policy-overrides.png)

## Real LLM workflow

The UI launched revision 4 with the captured request body containing definition ID, revision `4`, and tier `project`. The workflow ran four real Codex contexts (`gpt-5.4`, low reasoning) in a three-root fan-in topology and completed without intervention:

- Execution: `d53f3c28-8ab1-47ed-ab28-b236b0be001c`
- Started: `2026-08-06T01:54:38.009Z`
- Completed: `2026-08-06T01:56:07.089Z`
- Context merge join: `43ca1658-0625-4f79-a781-bbcc0bc3eb35`
- Final publish join: `65658fe6-db63-469b-a2fd-2b2cbaecc671`

[The launch selection](assets/validation-concurrency-live-e2e/08-session-workflow-launch.png) and [completed execution](assets/validation-concurrency-live-e2e/09-workflow-completed.png) were captured in the browser.

### Agent enforcement and automatic gates

| Context | Production action | Result |
|---|---|---|
| `context-1` | `cctl validate run allowed --wait --json` | passed, `vrun-77f578e8-6863-45cc-9f02-188742361549` |
| `context-2` | scoped `cctl validate run scoped --path ... --wait --json` | passed, one scoped path, `vrun-894bc1f2-0962-4f43-99fe-a8a5c5db87d0` |
| `context-3` | attempted `format` | `skipped_by_policy`; no run ID, process marker, or ledger row |
| `context-4` | read all predecessor markers | produced `VC-E2E-JOIN` after the fan-in merge |

Pre-cleanup inspection of the corresponding lane transcripts found markers `VC-E2E-A`, `VC-E2E-B`, `VC-E2E-C`, and `VC-E2E-JOIN`, along with the exact CLI outcomes summarized above. Session deletion intentionally cascade-deleted those transcript files. The retained structured logs and ledger independently preserve the workflow/context identities, command names, scoped flag, run IDs, policy skip, and automatic-gate sources; together these observations prove real model tool use was constrained by server policy rather than prompt wording alone.

Automatic graph script gates produced four passed ledger rows: `gate-auto` for contexts 1, 2, and 4, and the per-node `pre-merge` override for context 3. Their `source` is `graph_script_validator`; none bypassed the service.

### Lane-merge deferral and final publish

The three-root fan-in emitted `graph-workflow.join.validation_deferred` while two predecessor lanes remained. The later context-merge event covered both merged predecessor contexts and produced service run `vrun-0d68bc35-db53-4997-aaab-27d5a25fa4b6` with source `graph_lane_merge`.

The `final-only` policy still executed the documented final-publish exception after context 4. The final join covered context 3 and produced `vrun-fd65e19e-401b-4261-9cd0-912b50b732e8`, also through `graph_lane_merge`. There was one deferred validation, one context-merge validation, and one final-publish validation—no duplicate per-lane runs.

## Shared-budget matrix at limit 4

The matrix used production HTTP/CLI admission and silent process-group scripts. It used marker polling rather than fixed sleeps for synchronization.

| Scenario | Evidence | Result |
|---|---|---|
| Immediate admission | cost-3 `hold-3` admitted with `inUse=3` | PASS |
| Fail-fast capacity | second cost-3 refused with `capacity_unavailable`, `inUse=3`, `limit=4` | PASS |
| Queue | waiting cost-3 entered position 0 | PASS |
| No leapfrog | cost-1 fail-fast was refused although one unit was free because the older cost-3 waiter blocked it; waiting cost-1 entered position 1 | PASS |
| Budget ceiling | interval reconstruction from persisted start/finish times produced max active configured cost `4` | PASS |
| FIFO release | older cost-3 started before cost-1; they then ran together at cost 4 | PASS |
| Disabled no-op | `format` returned `skipped_by_policy`; zero spawn markers and zero ledger rows | PASS |
| Oversized command | cost-5 rejected as `validation_cost_exceeds_limit` both with and without `--wait`; zero ledger rows and zero spawn markers | PASS |
| Queue excludes timeout | timeout candidate stayed queued for more than 2.5 seconds with no `started_at` while a blocker ran | PASS |
| Execution timeout | after admission, 1500 ms default produced `timed_out`, `queueMs=3149`, `execMs=1552`, then `group_dead` before release | PASS |
| Unclean restart | running cost-3 row became `interrupted`; orphan process group was killed and confirmed dead | PASS |
| Post-recovery admission | a fresh `allowed` run passed at configured limit 4 | PASS |

The queue/release runs were:

| Queue order | Command | Cost | Status | Queue ms | Exec ms |
|---:|---|---:|---|---:|---:|
| 8 | `hold-3` | 3 | passed | 4 | 669 |
| 9 | `hold-3` | 3 | passed | 288 | 302 |
| 10 | `hold-1` | 1 | passed | 188 | 301 |
| 11 | `hold-3` blocker | 3 | passed | 2 | 3200 |
| 12 | `default-timeout` | 3 | timed_out | 3149 | 1552 |
| 13 | `hold-3` restart victim | 3 | interrupted | 4 | 46832 |
| 14 | `allowed` after recovery | 1 | passed | 5 | 71 |

The terminal subset contains five passed rows, one timed-out row, and one interrupted row. There are zero queued/running rows after the matrix.

### Restart recovery detail

The target Next.js process group was killed with `SIGKILL` while validation run `vrun-984f4547-cd5c-468b-9b2e-359ccb752cf8` remained live in a distinct process group. Restarting through `cctl dev ensure nextjs` restored the exact assigned worktree. Startup recovery then:

1. killed and confirmed death of validation process group `48773`;
2. persisted the ledger row as `interrupted` with reason `unclean_shutdown`;
3. logged `validation.recovery.reconciled` with `interrupted=1`, `killedGroups=1`, `unverifiable=0`;
4. admitted and passed a new validation under the restored configured limit of 4.

The recovery completion log reports limit 8 because recovery runs before the first runtime config synchronization and uses the seeded default. It performed no admission. The first post-recovery admission and completion both report limit 4, matching raw and effective config.

## Persisted ledger accounting

The eight workflow rows and seven matrix/recovery rows remain in SQLite as terminal evidence. Every workflow row carries the expected `source`, execution/context provenance, `queue_ms`, `exec_ms`, and `scoped` fields. The scoped agent run records `scoped=1` and `scoped_path_count=1`; all unscoped rows record zero. The rejected cost-5 requests and policy-skipped `format` correctly created no execution rows.

Every normal and timeout runner path observed a `validation.runner.group_dead` event before `validation.scheduler.released`/`validation.run_completed`. Startup recovery separately confirmed process-group death before the interrupted terminal transition, then logged its aggregate `killedGroups=1` reconciliation after persistence. The ledger ended with no active rows and reconstructed maximum cost 4.

## Acceptance result

| Required behavior | Result |
|---|---|
| Exact worktree and durable fixture database | PASS |
| Browser-editable global budget and timeout with persistence round-trip | PASS |
| Independent global/workflow/context script and role policies | PASS |
| Project/workflow-only lane merge selection | PASS |
| Real LLM policy enforcement and service-owned script gates | PASS |
| Fan-in deferral and final-publish exception | PASS |
| Shared configured-cost budget, FIFO/no-leapfrog, and fail-fast behavior | PASS |
| Oversized rejection without clamping, including `--wait` | PASS |
| Queue-independent timeout and release after process-group death | PASS |
| Durable interrupted recovery after unclean restart | PASS |
| Per-run source, scope, queue, and execution accounting | PASS |

No new implementation defect was found, so no additional remediation task was registered.

## Cleanup

Evidence was captured before cleanup so deletion of disposable workflow/session state could not erase the proof. Cleanup completed as follows:

- Restored the exact snapshotted raw global configuration. A normalized full-object comparison returned `equal=true`; the restored values include base directory `/Users/alex/projects`, concurrency limit 8, default timeout 600000 ms, empty global script selection, the original role policies, and project-selected `final-only` lane validation.
- Deleted workflow definition `7ed153aa-f71c-4cc9-97b1-e34ba4645ad4`; the project workflow API then returned an empty list.
- Deleted `fx-validation-e2e`, `fx-validation-budget`, and `fx-validation-restart-gate`; each API response confirmed `worktreeRemoved=true`, the session API returned an empty list, and SQLite retained zero fixture session rows.
- Permanently removed the disposable committed scratch project beneath `.cc/temp/validation-e2e-projects`; it contained no user data. A post-cleanup audit found and removed its orphan project-registry row through the production state-store repository; the final project-row count is zero.
- Closed and cleared the `vc-e2e` browser session.
- Stopped the isolated Next.js and control/proxy processes, then removed their run-specific scratch configuration and harness files. Ports 3001, 43123, and 43124 were clear, and the restart-victim process group remained dead.
- Confirmed the repository's `nextjs` dev command remains `bun run dev`.
- Retained all 15 terminal validation ledger rows, with zero active rows, as required by the design.
