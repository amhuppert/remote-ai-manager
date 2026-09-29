# Module structure implementation — 2026-09-28

This implements the next-work plan in
[the investigation](2026-09-28-module-structure.md). It preserves runtime
behavior while separating reusable logic from concrete production composition.
The registered full suite, typecheck, lint and seams checks pass; measurements
and remaining limits are recorded below.

## Ownership changes

- Conversation `manager.ts` owns the dependency-required factory;
  `lifecycle.ts` owns the unchanged lazy singleton and public production
  wrappers. Queue defaults live in `conversations/message-queue-production.ts`.
  Runtime instruction policy and debug output-format policy have focused owners.
  The actor implementation receives the in-turn question operation explicitly.
  Removing only the manager's direct production import was insufficient: the
  transitive guard found the alternate question-service path and drove its fix.
- The graph manager receives its launch-time finalizing-merge lookup and
  conversation-question cleanup explicitly. Production supplies the existing
  implementations; the cohort harness retains real engine and persistence
  coverage with controlled external ports.
- `specs/delivery-plan-policy.ts` owns editable/reopenable eligibility,
  reaffirmation decisions and park/launch/abandon transitions. Storage still
  rereads authoritative rows, checks candidate identity and revision, evaluates
  policy inside its write transaction, and writes state and audit together.
  Existing edge cases and refusal messages are preserved.
- `workflow-graph/boundary-event-projection.ts` owns pure graph event construction.
  Storage imports that projection; publication and notification delivery remain
  separate and occur after commit.
- Generic `stableStringify` lives in `shared/stable-stringify.ts`. Its body and
  canonical bytes are unchanged. `jsonOrNull` stays storage-owned. The separate
  MCP serializer has different semantics and is untouched.

Consumers were rewired directly. There are no compatibility re-exports, database
schema changes, or changes to live configuration.

## Reports and enforcement

[The boundary inventory](2026-09-28-boundary-inventory.md) classifies every
state-store-to-domain target and both directions of workflows/graph crossings.
Its [JSON companion](2026-09-28-boundary-inventory.json) retains individual edges.
Schemas, codecs, authoritative transaction policy, adapters, and production
composition remain distinct categories; crossing a folder boundary alone is
not a defect.

[Module graph tooling](../module-graph.md) now provides file SCC witnesses,
forward/reverse reach, shortest paths, and affected-test estimates including
registered declared inputs. Raw graphs preserve type-only and deferred-import
metadata. Actual production roots determine runtime membership.

The seams gate checks transitive core restrictions and every edge participating
in a reviewed cross-domain production cycle. Each allowance has a rationale and
removal condition. Adding an edge within an existing cycle fails; the ratchet
can only remove allowances. The source scanner erases TypeScript before tracing
literal imports, including deferred imports. Computed imports and dependencies
hidden in external packages remain outside that scanner's claims.

The test launcher records bounded JSON artifacts containing actual selected
modules and observed collection, setup, environment, preparation, execution,
and available aggregate transform timings. A registered `test-impact` diagnostic
records native related-file selection without executing tests. Its output
explicitly excludes the wrapper's extra setup and declared-input expansion.

## Validation and measurements

The phase-two comparison uses saved pre-refactor and final raw cruises with
identical entrypoints and value-edge filters. Production membership for this
comparison is type-inclusive reach from the real entries, matching the initial
investigation; value reach excludes `preCompilationOnly` edges and retains
literal deferred imports. Counts exclude the starting file.

| Static measurement | Before this phase | After |
|---|---:|---:|
| Production files reachable from lifecycle fixture | 850 | 418 |
| Production files reachable from cohort harness | 850 | 410 |
| Production files reachable from conversation manager | 849 | 345 |
| Largest production value SCC | 54 | 43 |
| Production value SCCs with more than one file | 19 | 18 |

Both fixtures and the manager now have no value-import path to
`workflows/production.ts`; the transitive source guard verifies this independently
of the cruise. These are reachability improvements, not claims about evaluated
modules, test duration, or compiler work. The cycle gate retains 99 exact edges
in the remaining cross-domain component after shrinking its initial reviewed
108-edge baseline. Other intra-domain cycles remain visible in graph reports.

Artifacts: `.cc/temp/module-graph/phase2-before/`, current raw JSON and
`report.json`, and `phase2-comparison.json` (calculation in `compare-phase2.py`).
The final workflow-production edit estimate is 178 import-selected tests plus
25 declared-input-selected tests, 203 in the union. That estimate excludes the
wrapper's setup/configuration expansion; it is distinct from native Vitest
selection measured below.


For the same hypothetical edit to `src/lib/workflows/production.ts`, Vitest's
actual native related-file selection fell from **242 to 182 tests**: 60 removed,
none added. This was a read-only selection probe, without executing tests or
including the whole refactor diff. The wrapper's extra declared-input and setup
expansion is deliberately excluded. The new branch-local `test-impact.sh`
completed successfully and produced the after artifact. Selection evidence is
saved under `phase2-before/selection.json` and `phase2-after/selection.json`, with
an exact `phase2-after/selection-diff.json`.

The same single lifecycle admission test passed three branch-local launcher
runs before and after, with one resolved worker. The reporter produced the
expected selected file/project, successful outcome, phase values, aggregate
transform duration, and explicit `null` per-module transform. Local diagnostics
correctly have no server validation-run ID. A separate scratch-project probe
reproduced a launcher failure when the target checkout lacked the reporter;
resolving the reporter beside the launcher fixed it, and the same probe then
ran its test and wrote a valid timing artifact. Logs are in
`.cc/temp/module-wrapper-legacy/{before,after}.log`. This preserves registered
wrapper use against older session checkouts.

| Observed median, three runs each | Before | After, concurrent full suites | After, empty validation queue |
|---|---:|---:|---:|
| Collection | 3,328 ms | 9,305 ms | 3,675 ms |
| Setup | 33 ms | 123 ms | 36 ms |
| Test execution | 254 ms | 693 ms | 301 ms |

These samples **do not establish a collection-time improvement**. The first
after set ran while two full suites occupied the host. A second after set ran
with an empty validation queue and was much closer to baseline, but still did
not improve it. Overall host load/cache conditions were not controlled across
the before/after comparison, and the baseline overlaps other small
policy/projection edits. Keep all raw results rather than treating the static
or selection reductions as timing evidence. If collection latency is pursued
next, profile evaluated modules and transformations under controlled conditions;
static reach includes deferred imports and is not a measurement of that work.

No before/after incremental compiler or public-type-edit timing was captured,
so no compiler performance claim is made. Artifacts are in both snapshots'
`timings/` directories and `phase2-after/quiet-timings/`. Run-level transform
measurements are unavailable in the older baseline and must not be compared as
zero. The quiet after runs also verify the final launcher-relative reporter path
against the real lifecycle test.

Registered full-suite tests, typecheck, lint, seams and formatting pass.
Focused policy, persistence, event durability,
conversation admission/cancellation/durability, queue, schema, serializer and
new tooling tests have passed during implementation. Pure graph/scanner/ratchet behaviors and extracted policy characterizations
were observed failing assertions before implementation. Mechanical moves,
including the final graph dependency wiring, use existing behavior coverage
plus architecture assertions under the repository's mechanical-wiring exception.

Recorded aggregate verdicts:

- Full test suite: `vrun-d7e560aa-2a71-4f4e-a12d-e712058119b0`.
- Typecheck: `vrun-1c4e7569-67a8-473b-b967-814b6b385275`.
- Lint: `vrun-6b5188b2-4274-417f-a7d7-3ad3bb96eee8`.
- Seams: `vrun-261d34a0-2c32-4970-afe6-d847a4a0643f`.
- Formatting: `vrun-faf14d0f-1072-4bc4-989e-7941e3b301d4`.
- Transitive core assertions (one matched file):
  `vrun-e562b7d9-7aad-41fc-af5d-2e526b6cd713`.
- Configuration contract rerun (one matched file):
  `vrun-957c31ae-41ba-436d-bcc4-0b2fffde9136`.

## Next structural work

The remaining production composition cycle is intentionally recorded rather
than hidden behind a global count. Follow-up work should select a named decision
or concrete composition leak and remove all alternate import paths, then verify
production behavior and the affected test corpus.

The next three candidates, in order:

1. Separate context-artifact repository bindings and compaction production
   composition from `context-artifacts/route-handlers.ts`. Ticket attachments
   need compaction, and conversation composition needs a read-only repository;
   neither should acquire HTTP/auth/route dispatch. Preserve the same database
   and single lazy compaction instance with its single-flight map.
2. Separate ticket repository/read bindings from `tickets/service-factory.ts`.
   Checkpoint fork, memory, live references and session cleanup currently acquire
   launch, prompt and session composition through getters that only need storage.
3. Separate persisted plan-review record schemas from canonical hashing and
   workflow validation in `workflows/plan-review/schemas.ts`, so the state-store
   record decoder does not import the workflow validator.

Preserve legitimate canonical schemas and policy calls inside storage
transactions. Do not reorganize the workflows folders solely to make a
domain-level graph look acyclic.

## Design assessment

The added mechanisms have current consumers:

| Mechanism or contract | Current consumer and simpler alternative considered |
|---|---|
| Required question/job ports and separate production entrypoints | Conversation and graph fixtures need their real engines without production singletons. Merely changing imports to deferred imports leaves those dependencies reachable. Existing runtime result types are retained. |
| Specs policy decisions (`parked`, `launched`, `abandoned`) | The transaction maps each decision to its existing row update; editable/reopenable checks retain their existing refusal errors. Keeping policy in storage leaves domain decisions under the wrong owner. |
| Pure boundary-event projection | Both persistence and event delivery construct the same graph-owned contract. Importing the delivery module also acquires unrelated publication capability. |
| Shared stable encoder | Existing specs hashes and storage codecs consume the same exact bytes. A compatibility re-export would retain the misleading storage entrypoint. |
| File graph analysis and TypeScript-erasing scanner | This investigation uses paths/reach; seams uses actual value imports. Folder edges and count ceilings cannot distinguish a legitimate contract from the observed production paths. |
| Exact cycle allowances and core restrictions | The existing seams gate rejects added edges, duplicates, stale entries and forbidden core paths. Each failure has a distinct repair; a global cycle-count budget could hide a new edge inside the existing component. |
| Timing artifacts and native test selection | This experiment needs observed test phases and selection. Unavailable transform measurements are `null`; treating them as zero or inferring them from static reach would misstate evidence. |

Current qualitative score for the sampled seams: **7.5/10** (six of eight
diagnostics). Scope clarity, useful interface depth, abstraction comments,
design review, single-decision ownership in the changed modules, and deliberate
simplification pass. Implementation independence still fails where repository
consumers acquire route/service composition; the first two follow-ups above
address that. Boundary discoverability still fails in mixed record-schema and
validation modules; the third follow-up addresses that. This is a review judgment
about the sampled seams, not a measured repository-wide quality score.
