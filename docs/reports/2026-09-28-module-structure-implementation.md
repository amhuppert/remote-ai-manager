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

### Context-artifact composition follow-up (2026-09-29)

Completed the first candidate. `context-artifacts/repo-production.ts` now owns
one lazy repository bound through the same `getStateDb()` accessor.
`context-artifacts/production.ts` owns one lazy compaction service, including its
single-flight map, and uses that repository. Routes and ticket attachments call
the same getters; conversation composition and naming-context readers import
only the repository binding. Checkpoint probes use the compaction entrypoint.
There are no compatibility re-exports from the HTTP module.

Task execution, configuration resolution, transcript reads, publication, clock,
and route behavior are unchanged. Transitive seam rules keep the repository
binding independent of compaction, lifecycle, and authentication, and keep the
non-HTTP consumers independent of the context-artifact route handlers. The cycle
baseline replaces two moved composition edges and deletes the eliminated
conversation-production-to-route edge: 99 reviewed edges become 98. The remaining
ticket/compaction/lifecycle cycle is still recorded, with ticket read bindings
as its next separation point. This change makes no compile/test speed claim.

Follow-up validation passed: five targeted files covering route behavior,
compaction (including concurrent-trigger coalescing), naming context, ticket
attachments, and transitive boundaries
(`vrun-15822dad-b9a0-45c2-876d-963843aacfda`); full typecheck
(`vrun-b8f1d05b-7549-40c5-a540-198d99c1a2ee`); seams
(`vrun-57bf54f6-6af2-48b8-8ce2-5a16d1881e0d`); lint
(`vrun-c8f617d3-6e02-4664-a079-2bc26cb7a459`); and formatting
(`vrun-370a7947-8d11-46f6-9459-d06d39a30c9e`). Independent code review found no
substantive issues. The full suite was not rerun for this mechanical extraction.

### Ticket storage and plan-review follow-ups (2026-09-29)

Completed both remaining candidates:

- `tickets/storage-production.ts` owns the ticket repository, project resolver,
  content store, and live-context provider. Launch, enrichment, compaction, and
  session orchestration remain in `tickets/service-factory.ts`. Repository-only
  callers, session cleanup, memory, checkpoint fork, live references, bundles,
  lifecycle observers, and conversation/collaboration readers now use storage
  bindings directly. Every moved global singleton retains its original key;
  the same database accessor and shared write-queue functions still own writes.
  Project lookup fallback, content paths, and per-turn rereads are unchanged.
- `workflows/plan-review/schemas.ts` now imports only Zod. The persisted record,
  digest pattern, terminal verdicts, and findings refinement are unchanged.
  `definition-hash.ts` owns the unchanged canonical hash and plan-validation
  operations. Storage decodes the same record without acquiring the workflow
  validator. Hash consumers import the new module directly; canonicalization
  and the advisory review semantics are unchanged.

Transitive guards cover both boundaries. The ticket separation removes 16 more
production cycle edges (98 to 82), with no added allowances. The remaining
cycles stay explicitly recorded; completing these candidates does not mean the
whole production graph is acyclic. No database migration, compatibility
re-export, or measured compile/test performance claim accompanies these moves.

Validation passed for all six targeted plan-review, workflow-definition,
delivery-plan, and record durability test files
(`vrun-c4739878-7173-453a-a197-2c5efd38849b`), plus all eight targeted ticket
storage, project resolution, content, live-context, lifecycle, launch, and
boundary test files (`vrun-8cd44f61-6d25-4de9-92d4-106ddde2e938`). Full typecheck
passed (`vrun-03dfa8a7-90ab-40ae-8faf-c73296d814ba`), as did lint
(`vrun-0666922e-4860-4ab2-ba42-fa2a4c0a6008`) and formatting
(`vrun-e7f758b3-57d8-433a-8b5d-4f433e04b482`). Independent review found no
substantive issues. These mechanical extractions used existing behavior tests;
the full suite was not rerun. The final seams check passed against the shrunk
82-edge baseline (`vrun-e305eca2-3254-4b64-9f73-c60044548e0b`).

The three named follow-ups are complete. Further structural work should start
from a fresh graph and concrete source witnesses before selecting another
ownership change.

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

The earlier phase-two review scored the sampled seams at 7.5/10. Its two named
ownership concerns are now addressed: repository consumers have storage
bindings separate from route/launch composition, and persisted plan-review
records have a schema module separate from hashing and validation. This is a
review of those specific boundaries, not a repository-wide quality score or a
claim that every production composition cycle has disappeared.
