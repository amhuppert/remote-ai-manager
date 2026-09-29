# Module structure investigation — 2026-09-28

This is the initial investigation and plan. See the subsequent
[implementation report](2026-09-28-module-structure-implementation.md) for the
implemented changes and updated evidence.

The next substantial target is production composition leaking into the
conversation manager and its test fixtures. The small fixes below improve
locality, but leave the largest value-import cycle intact. Folder-level cycles
are screening evidence; a violation needs a named decision, its proper owner,
and the callers that currently know too much.

This continues conversation `c5d83586-8b13-4350-a0de-9d3f081b6e7b`
(read its full conclusion with `cctl conversation entry get <id> 1`). The
measurements below were refreshed in this session worktree; earlier aggregate
counts used a different test corpus and edge filter and are not directly
comparable.

**Implemented and checked**

- Moved session-only optimistic orchestration from `shared/optimistic.ts` to
  `sessions/optimistic.ts`. The core requires dependencies; concrete defaults
  live in `sessions/optimistic-production.ts`, wired by `sessions/service.ts`.
  Tests can now load the orchestrator without importing production services.
  The production path retains its previous behavior and integration coverage.
- Moved backend execution schemas and their inferred types to
  `agent-backends/execution-schemas.ts`. Admission decisions and their error
  remain in `execution-admission.ts`. Updated consumers directly, without
  compatibility re-exports. Tickets and commands legitimately share the backend
  refusal contract; they no longer acquire its policy implementation too.
- Extended `bun run deps:graph` to preserve `production.json` with
  `tsPreCompilationDeps: "specify"`. `--tests` additionally saves
  `validation.json` and `test-inputs.json`; `--no-render` omits Graphviz work.
  The test inventory includes registered unit profiles, their fixtures through
  imports, setup files, and declared non-import inputs in a separate artifact.
- Added two narrow architecture assertions in
  `scripts/module-boundaries.test.ts`. Both failed on the original imports and
  pass after the separation. These guard the reviewed direct boundaries; they
  are not a global or transitive dependency-policy engine.

The code moves preserve implementation bodies. Existing behavior tests cover
the mechanical rewiring; no new product behavior was introduced. Registered
typecheck, seams, lint, and seven focused test files passed: optimistic workflow,
status-bus wiring, backend admission, ticket schemas, command availability,
AgentCall admission, and the new boundary checks. A full-suite run and a live
application exercise were not performed.

**Measured structural effect**

| Static value-import measurement | Before | After |
|---|---:|---:|
| Production files reachable from optimistic unit test | 848 | 9 |
| Unit test files reverse-reachable from admission policy | 1,375 | 1,151 |
| Largest production file strongly connected component | 54 | 54 |
| Production file SCCs with more than one file | 19 | 19 |

The admission change removes 224 tests from that policy file's static reverse
reach, with no newly reached tests. Changes to the shared schema contract still
have broad impact, as expected. The optimistic core's reverse reach remains
broad because production still composes it; its unit test's forward reach is
what improved. These are different benefits.

Reachability excludes `preCompilationOnly` edges, retains dynamic imports and
`require`, and counts unique internal files. It does not mean those files were
evaluated. Test impact here excludes setup fanout and `@vitest-inputs` matching;
those inputs are saved, not silently treated as import edges. Neither wall-clock
test improvements nor compiler speedups have been established. The compiler
still sees the optimistic core's type dependencies on service signatures.

Artifacts are under `.cc/temp/module-graph/`: original snapshots in `before/`,
current cruises, and `before-summary.json` / `after-summary.json`. The temporary
`analyze.py` records the calculation. Production membership is type-inclusive
reachability from Next routes, instrumentation, middleware, CLI, and Cursor
worker entrypoints; UI modules are reached through their imports. External
packages are not traversed. The cruise has unresolved external package export
paths, but no unresolved project-relative or `@/` imports; these figures make
no claims about dependency-package internals.

**Next work, in priority order**

1. **Measure and separate conversation composition.** Start with
   `workflows/conversation/testing/lifecycle-fixture.ts`, which reaches the
   production manager, and `workflow-graph/testing/cohort-engine-harness.ts`.
   One verified path is `lifecycle-fixture → manager → message-queue-drain →
   conversation-commands/dispatch → conversation-commands/service →
   workflows/production`; another is `cohort-engine-harness → workflow-manager
   → jobs/queue → workflows/production`. The manager also directly imports its
   own `production.ts`. Removing only that direct import does not close the
   alternate paths. Inventory these exits, keep real lifecycle/SQLite coverage
   as integration coverage, and isolate the smallest core needed by narrower
   tests. Model replacement edges, not just deleted edges. Success means a
   designated core cannot reach production composition, existing lifecycle
   behavior remains covered, and actual scoped selection and collection time
   improve for representative edits.

2. **Move delivery-plan decisions to specs while keeping transaction authority
   in storage.** `state-store/spec-delivery-plan-repo.ts` owns `applyTransition`
   and the permitted park/launch/abandon states, including operator remedies.
   Extract a pure specs-owned transition decision and characterize the state
   table before moving it. The repository must still reread current rows,
   verify candidate/revision identity, invoke the policy inside its transaction,
   and commit state plus audit event atomically. Preserve the repository
   contract tests for immutable candidates, approval, compare-and-swap,
   reopening, and batch atomicity. Calling policy only before the transaction
   would introduce a race.

3. **Separate graph event construction from delivery.** `state-store/setters.ts`
   needs `createGraphWorkflowBoundaryEvent`, but imports it from
   `workflow-graph/execution-events.ts`, which also owns publication and
   notification delivery. Put pure projection in a graph-owned module consumed
   by storage and delivery. Preserve critical-section and durable-event tests:
   effects occur only after commit. This removes unnecessary delivery capability
   from a persistence import without moving graph policy into storage.

4. **Classify the remaining edges by responsibility.** For each
   `state-store → domain` and `workflows ↔ workflow-graph` edge, record contract,
   codec, adapter, composition, or leaked decision, with a source example and
   proposed owner. Retain canonical `holdsExecutionLease` /
   `evaluateLeaseAdmission` calls inside authoritative storage operations;
   retain specs-owned identity hashing and the ticket pagination contract.
   Consider moving generic `stableStringify` to shared as a separate mechanical
   cleanup, preserving exact bytes. Keep raw persisted-record lease decoding
   beside storage if that later simplifies ownership. Do not merge or split
   `workflows` folders until this inventory distinguishes generic primitives
   from graph adapters and deliberate composition roots.

5. **Turn reviewed responsibilities into enforceable reports.** Add reusable
   file-level SCC witnesses, shortest import paths, forward/reverse reach, and
   declared-input selection to the graph tooling. Rank candidates using recent
   non-mechanical edit frequency and measured avoidable feedback cost. Add
   explicit core-to-production restrictions and reviewed cross-domain value
   cycle baselines to registered seams; existing allowances need a rationale
   and deletion condition. Keep broad filename screens advisory. Do not impose
   a global cycle or fan-in threshold that treats lawful vocabulary as a defect.

For the first experiment, capture the registered runner's selected files and
per-file collection/transform/setup/execution timing for an equivalent
implementation-only edit before and after, with consistent cache and worker
conditions. Its current bounded success output does not expose that timing;
add a bounded reporter artifact to the registered runner rather than inferring
it from Vitest's execution-only cache or bypassing validation. Measure public
type edits and incremental typecheck separately. Keep the branch refactor diff
out of the representative one-file comparison.

Qualitative design score for the sampled unresolved seams: **5/10**. Four
diagnostics pass in this review: meaningful depth, useful interface comments,
attention to design in review, and active investment in simplification. Scope
clarity, implementation independence, single-decision ownership, and boundary
discoverability need improvement. The fixture/composition split addresses the
first two; the specs policy and event-projector extractions address the latter
two. This is a review judgment about the sampled seams, not a repository-wide
quality measurement.

**Review disposition:** accepted the finding that whole UI directories used as
production roots included story-only fixtures. Removed those extra roots and
regenerated the graph. Before figures are filtered from the saved graph using
the same real entrypoints. This adds no runtime mechanism or state and removes
misclassified roots. The accompanying simplification is to let the real route
imports discover production UI instead of maintaining a second UI root list.
