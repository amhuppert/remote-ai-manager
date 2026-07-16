# Command Center Unit Test Performance Remeasurement

**Date:** 2026-07-15  
**Measured revision:** `90a308bcce0017c62a4bc2383db46c3c24286dfb`  
**Previous baseline:** 972 files, 12,896 tests, 217.34 seconds  
**Current suite:** 1,062 files, 13,976 tests

## Executive summary

The merged test suite is materially slower than the previous baseline. The
best lower-contention production-equivalent run completed in 334.37 seconds,
an observed increase of 117.03 seconds (53.9%) over the previous 217.34-second
baseline. The suite grew by 90 files (9.3%) and 1,080 tests (8.4%), so test
count growth alone does not explain the wall-time increase.

The current suite is also highly sensitive to host contention. Three
production-command runs ranged from 334.37 to 623.86 seconds as other test,
Node, and UI workloads appeared on the shared host. The 334.37-second run is
the best current lower-contention baseline; the slower runs demonstrate host
sensitivity and must not be treated as intrinsic project regressions.

The largest measured cost centers are:

1. jsdom files: 29% of files and 18% of tests, but approximately 72% of
   profiled worker time.
2. Tests and hooks: 33.4% of summed worker time in the best run.
3. Collection and imports: 27.7%.
4. Environment creation: 23.1%, almost entirely jsdom.
5. Deterministic waits in dev-server, job-queue, optimistic-workflow, and
   GraphWorkflowPanel tests.
6. Full-component UI suites combining React Query, async DOM polling,
   `userEvent`, drag/drop, fetch harnesses, and large component trees.
7. Source-tree scans, real Git repositories, and real Tailwind compilation in
   Node/jsdom integration tests.

The highest-confidence next work is to remove avoidable deterministic waits,
then address isolated Markdown/Tailwind costs and the largest jsdom suites.
Runner isolation and pool changes remain later, higher-risk experiments.

## Measurement provenance

### Production-equivalent command

```bash
NODE_ENV=test CLAUDECODE=1 npx vitest run \
  --project unit-node --project unit-jsdom --no-color
```

### Environment

- Vitest 3.2.4
- 16 logical CPUs
- 16 GiB RAM
- Five-fork maximum derived by `vitest.config.ts`
- Node and jsdom remain separate Vitest projects with separate setup modules

### Validation result

Every full run passed:

- 1,060 test files passed and 2 skipped (1,062 total)
- 13,963 tests passed and 13 skipped (13,976 total)

The instrumented full run and all targeted/isolated reruns also passed.

## Full-suite wall time

| Run | Vitest wall | Process wall | Conditions |
|---|---:|---:|---|
| 1 | 334.37s | 336.46s | Lowest-contention full run |
| 2 | 461.63s | 463.83s | Competing test/worktree activity |
| 3 | 623.86s | 627.60s | Competing Node and UI load began during the run |

The arithmetic median is 461.63 seconds, but it is not a sound intrinsic
baseline because runs 2 and 3 were visibly contaminated by other host work.
Use 334.37 seconds as the best observed current baseline and retain the
334–624-second range as evidence of contention sensitivity.

### Comparison to the previous baseline

| Metric | Previous | Current | Change |
|---|---:|---:|---:|
| Test files | 972 | 1,062 | +90 (+9.3%) |
| Tests | 12,896 | 13,976 | +1,080 (+8.4%) |
| Best observed wall time | 217.34s | 334.37s | +117.03s (+53.9%) |

The refactor added 111 test files containing 1,114 tests and deleted 24 test
files within the main source/scripts/eslint test surfaces. Of the additions,
95 are Node files and 16 are jsdom files. The added files represented only
about 6% of the instrumented worker total because most additions are relatively
cheap Node tests. Existing and modified jsdom/import paths continue to dominate
the hotspot distribution.

## Worker-time attribution

The following is from the 334.37-second run. Values are summed worker seconds
across up to five forks, so they intentionally exceed elapsed wall time and
must not be added to the wall measurement.

| Phase | Worker time | Share |
|---|---:|---:|
| Tests and hooks | 440.64s | 33.4% |
| Collection and imports | 365.23s | 27.7% |
| Environment creation | 305.42s | 23.1% |
| Runner preparation | 117.51s | 8.9% |
| Setup-module imports | 91.98s | 7.0% |
| **Total** | **1,320.78s** | **100%** |

Vitest separately reported 26.70 seconds of transform time. It is excluded
from the worker-phase total because transform work overlaps collection and
other activity.

The effective worker-time/wall ratio was 3.95 despite a five-fork limit. The
gap reflects serial runner work, workload imbalance, external commands, real
waits, and host scheduling.

## Node versus jsdom

The full instrumented pass was affected by host contention, so the absolute
per-project milliseconds are diagnostic rather than baseline measurements.
The relative split and rankings remain useful.

| Project | Files | Tests | Profiled worker share | Median profiled file |
|---|---:|---:|---:|---:|
| Node | 753 | 11,418 | 28.4% | 0.84s |
| jsdom | 309 | 2,558 | 71.6% | 5.35s |

jsdom contains 29.1% of files and 18.3% of tests but approximately 71.6% of
profiled worker time. Its median file cost was about 6.3 times Node's median.

## Shared setup and environment cost

There are no distinct file-specific setup implementations: all files in a
project load the same setup modules. Per-file setup spikes observed in the
contended profile reflect scheduling rather than unique setup code.

The systemic setup costs are:

- The best full run spent 305.42 worker-seconds creating environments. Node
  environment setup is sub-millisecond per file, so this is almost entirely
  the 309 jsdom environments—approximately 0.99 seconds per jsdom file.
- Isolated representative jsdom files spent 0.8–1.4 seconds creating the
  environment and 0.23–0.43 seconds importing setup.
- `vitest.jsdom.setup.ts` was evaluated once for each of 309 jsdom files.
- `vitest.setup.ts` was evaluated once for every 1,062 files.
- The shared `_resetForTesting()` hook runs before every test. Its execution
  time belongs to tests/hooks rather than the setup-import phase.
- Environment, setup, and preparation together were approximately half of
  jsdom worker time in the instrumented profile.

The retained state-store reset is a correctness constraint. Any attempt to
narrow it must use a controlled benchmark plus isolation/leak validation.

## Slow files

The table below comes from isolated reruns with one file per Vitest process.
Process wall includes roughly 3–4 seconds of Vitest startup, so tests/hooks and
collection are the actionable values.

| File | Process wall | Tests/hooks | Collection | Dominant characteristic |
|---|---:|---:|---:|---|
| `src/features/tickets/components/TicketBoard.test.tsx` | 21.51s | 12.55s | 2.43s | 55 async queries, `userEvent`, React Query, drag/drop |
| `src/lib/dev-server/registry.test.ts` | 16.93s | 10.99s | 0.53s | Real subprocesses, polling, and fixed waits |
| `src/features/project-detail/ProjectDetailView.test.tsx` | 13.24s | 3.63s | 4.62s | Async full-page renders and broad imports |
| `src/features/workflows-builder/components/WorkflowBuilderEditor.test.tsx` | 13.02s | 3.93s | 4.32s | Full editor/store rendering |
| `src/components/markdown/markdown-boundary.test.ts` | 11.75s | 0.77s | 6.34s | Source-tree scan during collection |
| `src/lib/shared/optimistic.test.ts` | 10.91s | 3.04s | 2.93s | Production 500ms delay on successful paths |
| `src/lib/jobs/queue.test.ts` | 10.88s | 5.31s | 1.62s | 42 fixed 50ms settlement delays |
| `src/components/markdown/Markdown.test.tsx` | 9.62s | 5.19s | 0.10s | Deferred document renderer and fixture matrix |
| `src/features/session-workflow/components/GraphWorkflowPanel.test.tsx` | 9.36s | 2.21s | 2.60s | Explicit 1.2s negative polling assertion |
| `src/lib/shared/tailwind-cascade-order.test.ts` | 8.30s | 2.02s | 0.18s | Real PostCSS/Tailwind compilation |
| `src/lib/git/commits.test.ts` | 7.48s | 2.55s | 0.49s | Real temporary Git repositories |

The full profile also consistently ranked these jsdom files near the top:

- `src/features/session/ConversationWorkspace.test.tsx`
- `src/components/session/sidebar/ConversationSidebar.test.tsx`
- `src/features/workflows-builder/components/WorkflowInspectorPanel.test.tsx`
- `src/features/session/ConversationsPage.test.tsx`
- `src/features/tickets/components/TicketDetailView.test.tsx`
- `src/features/session-workflow/components/ContextConfigTab.test.tsx`
- `src/features/project-detail/components/CreateSessionModal.test.tsx`
- `src/features/project-detail/spawn-card/SpawnCard.test.tsx`
- `src/features/tickets/components/AttachmentDialog.test.tsx`
- `src/features/config/ConfigPage.test.tsx`
- `src/features/tickets/TicketsPage.test.tsx`

## Slow individual tests

Representative isolated outliers:

| Test | Duration | Mechanism |
|---|---:|---|
| Markdown `document` shared 10-fixture matrix | 4.22s | Deferred/full document rendering |
| Tailwind committed cascade integration | 1.99s | Real Tailwind/PostCSS compile |
| TicketBoard overlapping failed deletes | 1.31s | Full board, async mutations, repeated polling |
| GraphWorkflowPanel negative live-refetch assertion | 1.215s | Explicit 1.2s real timer |
| Dev-server Tailscale registration | 1.205s | Real readiness/process timing |
| Git merge-resolution commit | 1.112s | Real temporary repository |
| WorkflowBuilder add-context interaction | 1.049s | Full editor/store interaction |
| Successful optimistic workflow cases | ~0.509s each | Production 500ms sleep |

The queue file has no comparable single-test outlier: its isolated maximum was
about 120ms. Its cost is cumulative—42 calls to a 50ms `settle()` helper impose
a 2.1-second deterministic floor before any actual test work.

## Collection and import fan-out

Collection/imports consumed 365.23 worker-seconds (27.7%) in the best run.
Within the instrumented non-externalized import self-time:

- Schema modules accounted for 27.6%.
- Shared Vitest setup accounted for 22.8%.
- Reusable UI primitives accounted for 9.8%.

Frequently re-evaluated modules included:

| Module family | File contexts |
|---|---:|
| `src/lib/shared/schemas.ts` | 620 |
| `src/lib/agent-backends/schemas.ts` | 552 |
| Workflow config schemas | 473 |
| Workflow collaboration schemas | 471 |
| Job schemas | 467 |
| Config schemas | 398 |
| Conversation schemas | 343 |

`src/lib/agent-backends/claude/query-session.ts`, which statically imports the
Claude SDK, was evaluated in 85 file contexts and was a notable collection
hotspot. This identifies an import-boundary investigation target; it does not
by itself prove that moving the import is safe or quantify wall savings.

The Markdown boundary test is a special case: it scans and reads the source
tree during module collection, which grew more expensive as the refactor
expanded the tree. Its isolated collection time was 6.34 seconds.

## Shared characteristics of slow files

These are correlations within the owning Vitest project, not causal claims.

### jsdom

Compared with other jsdom files, mean tests/hooks time was:

| Characteristic | Relative mean tests/hooks time |
|---|---:|
| Fetch harness | 2.4× |
| Drag/drop | 2.3× |
| `waitFor` / `findBy*` | 2.2× |
| `userEvent` | 2.1× |
| Existing internal-module mocks | 1.9× |
| React Query | 1.5× |

Internal mocks likely proxy broad integration surfaces rather than causing the
cost directly. They remain migration debt under the project's testing rules
and should not be introduced as a performance workaround.

The leading jsdom files repeatedly combine several characteristics:

- Full component/page mounting
- Query client construction and fetch fixtures
- Deferred/dynamic imports
- Repeated `waitFor` and `findBy*` retries
- `userEvent` interaction sequences
- Radix UI primitives
- Drag/drop and keyboard accessibility behavior
- Large fixtures and multiple state transitions per test

### Node

Compared with other Node files, mean tests/hooks time was:

| Characteristic | Relative mean tests/hooks time |
|---|---:|
| Subprocess or Git | 4.2× |
| Filesystem-heavy | 2.0× |
| Timer or sleep | 2.0× |
| Database/state-store | 1.5× |

Node outliers are therefore behavior-heavy integration tests rather than
ordinary pure unit tests.

### File size is secondary

The correlation between test-file line count and tests/hooks time was only
0.43 for jsdom and 0.15 for Node. Expensive behavior is more predictive than
raw file size. Test count had a moderate 0.39 correlation with jsdom
tests/hooks time, while counts of async DOM and `userEvent` operations were
similarly predictive.

## Verified deterministic waits

These are implementation facts, not projections:

- `src/lib/jobs/queue.test.ts`: 42 `settle()` calls at 50ms each, a 2.1s
  deterministic floor.
- `src/lib/shared/optimistic.ts`: every successful path awaits `sleep(500)`.
- `GraphWorkflowPanel.test.tsx`: one negative refetch assertion waits 1.2s.
- `src/lib/dev-server/registry.test.ts`: explicit test sleeps total at least
  4.225s, in addition to readiness/process polling.
- The Tailwind cascade tests perform real compilation in separate files.
- The Markdown document adapter accounts for most of its file's execution
  time.

These values must not be summed and presented as projected wall savings.
Five-worker parallelism and file scheduling determine how worker-time removal
translates to elapsed time. Each change requires a direct before/after benchmark.

## Recommended optimization order

### 1. Remove deterministic waits

1. Replace queue `settle()` sleeps with an awaitable job-completion signal.
2. Inject the optimistic workflow sleep dependency so tests can complete it
   without real time while production retains the delay.
3. Replace GraphWorkflowPanel's 1.2-second negative assertion with an
   injectable or fake polling clock.
4. Replace dev-server fixed sleeps with readiness, output, or process-exit
   signals where real integration semantics permit.

This is the highest-confidence, lowest-risk category because the waits are
directly observed and do not require weakening assertions.

### 2. Reduce isolated scan/compile/render costs

1. Consolidate the two real Tailwind cascade assertions so one compilation can
   prove both properties, if diff-scoped invalidation remains sound.
2. Restructure the Markdown document fixture test so the document adapter does
   not dominate the shared matrix while retaining semantic coverage.
3. Consolidate related source-boundary scans or move work out of module
   collection without weakening source-tree coverage.

### 3. Deepen the largest jsdom tests

Prioritize:

1. TicketBoard
2. WorkflowBuilderEditor / WorkflowInspectorPanel
3. ProjectDetailView
4. ConversationWorkspace / ConversationSidebar
5. Ticket and attachment dialogs/pages

Extract pure mutation/state logic and narrower production component seams.
Retain meaningful integration tests for React Query, keyboard, drag/drop, and
accessibility behavior. Do not replace production behavior with internal
module mocks.

### 4. Investigate import fan-out

Evaluate schema barrels, UI primitive import paths, and the static Claude SDK
boundary. Any change must be benchmarked independently and preserve module
ownership and runtime correctness.

### 5. Defer runner/isolation experiments

Non-isolated jsdom, VM pools, file consolidation, or worker-count changes may
reduce environment overhead, but they require leak detection, order-randomized
correctness runs, and resource measurements. They should follow the simpler,
verified wait and test-structure opportunities.

## Measurement protocol for follow-up changes

For each optimization:

1. Record the exact revision and command.
2. Run the directly affected file(s) in isolation before and after.
3. Run the relevant owning project.
4. Run the production-equivalent full suite when the projected impact is broad.
5. Record competing host processes and reject contaminated runs as intrinsic
   baseline measurements.
6. Compare tests/files/pass counts to confirm merge-gate parity.
7. Report worker-time and wall-time savings separately.
8. Commit only conceptually focused changes that demonstrate meaningful benefit.

## Residual uncertainty

- The current host did not remain idle for three complete full-suite runs.
  Therefore 334.37 seconds is the best observed lower-contention baseline, not
  a statistically stable p50.
- The full custom-reporter profile incurred event/reporting overhead and ran
  under contention. It is valid for phase/file ranking and within-project
  correlations, not absolute wall-time comparison.
- The previous 217.34-second baseline was not rerun from the old revision on
  the same current host. The 53.9% increase is an observed baseline comparison,
  not a controlled causal estimate of the refactor alone.
- No proposed optimization savings are claimed until a direct before/after
  implementation benchmark exists.

