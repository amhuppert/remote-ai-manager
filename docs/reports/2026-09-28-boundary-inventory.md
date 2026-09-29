# Boundary inventory — 2026-09-28

Most reviewed crossings reuse an owned contract or compose supported modules.
The useful corrections separate policy from persistence and pure data from
production capabilities. Folder cycles alone do not justify moving files.
One additional concrete candidate emerged: the plan-review repository imports
its record schema from a module that also imports authoring validation and
definition hashing.

This supplements [the investigation report](2026-09-28-module-structure.md).
The [complete machine-readable inventory](2026-09-28-boundary-inventory.json)
records every reviewed target and its exact callers, responsibility category,
owner, and deletion condition. Its graph evidence is the phase-2 baseline at
`a19d978dd`, with the input artifact's SHA-256 recorded in the JSON. Source
inspection checks the named responsibilities; the baseline counts are not a
claim that every edge survives this branch's refactors.

| Population | Targets | Distinct source/target pairs | Edge treatment |
| --- | ---: | ---: | --- |
| `state-store → other lib domains` | 62 | 218 | Value imports only; migrations included |
| `workflow-graph → workflows` | 42 | 113 | 72 value, 41 type-only |
| `workflows → workflow-graph` | 38 | 71 | 51 value, 20 type-only |

Repeated declarations of the same source/target pair count once; a pair with
both import kinds is a value edge. External packages and same-domain edges are
outside this inventory. The `stateStore.targets` and
`workflowCrossings.targets` arrays enumerate the complete populations above;
`workflowCrossings.groups` supplies the category map. These are static imports,
including deferred literal imports, rather than measured module evaluation.

## Responsibility map

Here, a **contract** includes a canonical pure domain decision, not only a type.
A **codec** converts or validates stored/wire representations. An **adapter**
translates between interfaces or performs infrastructure work. **Composition**
binds concrete modules at an application boundary. **Leaked policy** means a
caller owns another domain's decision; merely importing its canonical decision
does not qualify.

| Responsibility and representative source → target | Category and named owner | Retention or deletion condition |
| --- | --- | --- |
| State-store repositories → domain `schemas.ts`, execution binding, reference grammar | Codec/contract; the domain owns the record shape | Keep the canonical schema. Retire historical decoding only after supported records no longer require it. |
| Graph execution repository/setters → `lifecycle-classifier`, `structural-revision` | Contract; graph owns lease tenure, admission and structural mutation identity | Keep evaluation inside the authoritative transaction. Moving it before the write queue would permit stale decisions. |
| Delivery-plan repository → canonical document bytes and hashes | Codec/contract; specs owns candidate identity | Keep exact canonicalization and hash field selection. The inappropriate knowledge was repository-local transition policy, not these imports. |
| Ticket repositories → keyset cursor, disclosure limits, relationship semantics | Codec/contract; tickets owns paging and endpoint-relative relationships | Keep cursor ordering aligned with SQL and the API. A generic pagination abstraction is not required. |
| Notepad repository → `append-composition` | Contract; notepads owns text composition | Keep one newline rule shared with the editor, evaluated against current text inside the write. |
| Store → notification repository and checkpoint conversation gateway | Composition; state-store binds repositories on its database | Retain repository/gateway construction. This does not authorize notification dispatch or workflow orchestration from arbitrary repositories. |
| State-store → logging, caches, liveness, atomic JSON writer, config addressing | Adapter/composition; infrastructure owns those mechanisms | Keep purpose-specific operations. A future pure core should receive adapters rather than bind them itself. |
| Migrations → placement/origin/edge repair, shared-document storage, spec fingerprints | Codec/adapter; the owning domain supplies conversion and identity semantics | Migration-only behavior is not precedent for runtime side effects. Removal requires a supported-population decision. |
| Graph engine → lane, artifact, circuit-breaker, script gate and output-schema primitives | Contract/adapter; `workflows/primitives` owns the shared mechanism | Supported by the workflow adoption matrix. Do not copy these decisions into graph to reduce crossings. |
| Graph implementer/validator runners → conversation manager and turn vocabulary | Contract/adapter; conversation lifecycle owns admitted turns and cancellation | Retain semantic APIs. Keep concrete production binding outside designated lifecycle cores; callers must not drive raw actor events. |
| Graph lane-tool loader → collaboration production caller/stores; graph collaborator caller → artifact and prompt helpers | Composition/adapter; collaboration owns the negotiation slice | The production loader is a legitimate binding site. A pure lane core would receive these collaborators. Do not introduce a second collaboration engine. |
| Collaboration slice → graph collaboration schemas | Contract; collaboration artifact protocol and graph-specific configuration share this module today | Retain one artifact vocabulary. Split neutral artifacts from graph configuration only if their independent responsibilities justify it; preserve frozen config decoding. |
| `workflows/definition-*`, plan validation and queries → graph definitions, admission, storage, telemetry and result contracts | Adapter/contract; these are graph authoring/read surfaces located under `workflows` | Treat them as graph adapters, not reusable orchestration primitives. Consolidate locations only with an explicit ownership change, preserving current acceptance and response semantics. |
| Graph template routes → shared definition-edit/refusal adapters | Adapter; graph authoring owns project/global-tier request behavior | Retain the one edit/refusal pipeline. Graph engine and generic primitives must not acquire HTTP response construction. |
| Graph merge runner → merge machine, delivery actor, outcome contracts | Adapter; merge owns its lifecycle, graph adapts joins to it | Supported machine hosting, not a fourth engine. Replace only if a deeper shared hosting API removes real duplicated knowledge. |
| Merge initiation/publish → graph session-delivery and lease predicates | Contract/adapter; graph owns lease policy, merge owns dispatch/publish | Preserve both the advisory preflight and the authoritative check under the publish lock. |
| Graph production modules → `workflows/production`; composition contracts → graph/merge ports | Composition/contract; one application composition binds spec, merge and graph services | Retain this explicit composition root. Pure engines receive its ports rather than import the root. |
| Conversation production/rehydration → graph validator instructions/result delivery | Composition; production binds graph integrations to conversation lifecycle hooks | Keep feature integration outside any extracted lifecycle core. Preserve restart ordering and durable result reconciliation when changing that boundary. |

The workflow steering's adoption matrix and canonical graph owners support the
retained mechanisms above. Its folder name is not the policy:
`workflows/no-graph-schemas.arch.test.ts` prevents graph schema declarations in
that directory, but does not assert that its route/query/composition modules
are graph-neutral. The exact inventory therefore distinguishes those adapters
from `workflows/primitives`, conversation lifecycle, and merge lifecycle.

## Corrections and remaining candidates

**Shared canonical serialization.** The unchanged `stableStringify` encoder
now lives in `shared/stable-stringify.ts`; `state-store/serialization.ts`
retains `jsonOrNull` and imports that encoder. Direct callers were updated
without a compatibility re-export. This corrects ownership of a pure utility
used by hashes and persistence; the old module itself was already small and
pure, so this is not evidence of a large transitive-dependency or performance
gain. Existing serialization and representative delivery/review hash tests
pass. The separate MCP-signature serializer has different semantics and remains
unchanged. The inventory counts above continue to describe the baseline.

**Delivery-plan transition ownership.** The baseline repository implements
`requireDraft` and `applyTransition`, including allowed park/launch/abandon
states and operator remedies. Those are specs decisions. Extracting them must
leave current-row reads, draft/candidate identity checks, audit writes and
transaction rollback in the repository. Preserve the maximal round-trip and
batch-reaffirmation tests. This workstream's specs-policy extraction addresses
that responsibility without weakening transaction authority.

**Graph event construction.** The baseline `setters.ts` value import of
`createGraphWorkflowBoundaryEvent` acquired `execution-events.ts`, including
its delivery path. It now imports `boundary-event-projection.ts`; event-kind
and pending-action projection live there too. The constructor still uses the
same output projection and project basename. A transitive architecture test
rejects event publication/notification dependencies, while existing durable
event and critical-section tests preserve delivery after commit. The remaining
type-only delivery vocabulary import does not acquire that capability.

**Plan-review schema loading is the strongest additional simplification.**
`state-store/graph-plan-reviews-repo.ts` imports `graphPlanReviewSchema` from
`workflows/plan-review/schemas.ts`. That module also imports
`validateWorkflowPlan`, spec-authored-source selection, and
`workingDefinitionHash` (which imports `node:crypto`). The repository needs
record validation, not plan admission or review identity calculation.
Keep the record schemas in their existing owner and move hash/validation
operations to a separate review-identity module, updating operation callers
directly. Preserve the hash's removal of server-owned spec-plan fields and
documents. Verification should include plan-review schema, service and route
tests plus `graph-plan-reviews-repo.contract.test.ts`; a boundary test should
show that loading the record schema cannot reach authoring validation or
crypto. This recommendation changes module reach, not the identity algorithm.

**Raw lease decoding remains optional.**
`rawRecordHoldsExecutionLease` is called only by migrations 0024 and 0030;
its unknown-input parsing could live beside stored execution decoding while
calling the graph-owned lease predicate. Preserve unreadable-input
fail-closed behavior. This is lower priority than actual production capability
leaks and is not needed to make all cross-domain arrows disappear.

**Do not relocate the graph authoring adapters wholesale yet.** Their current
callers show a coherent responsibility despite their two directories. A future
consolidation should name authoring, client reads, production binding and
generic primitives separately, then migrate a complete interface. The raw
crossing count does not select that design. Likewise, collaboration's combined
artifact/config schemas merit observation, not an automatic split.

## Recent-change screen

The table ranks reviewed candidates by the number of commits touching any of
their explicitly listed source files in the last **60 non-merge commits** at
`a19d978dd`. Five clearly mechanical subjects were excluded, leaving **55**:
`3eedb6455` “regenerate cursor catalog”, `ef00e2318` “update cursor catalog”,
`2795b6761` “updated cursor catalog”, `8e9cc2ec7` “Delete historical docs”, and
`598a8f881` “Add copy of graph-workflow-audit skill for Codex”. Mixed changes
such as the Knip upgrade/dead-code cleanup remain included; a dependency bump
is not assumed mechanical when it changes runtime behavior.

| Rank | Reviewed candidate | Touching commits | Source files counted |
| --- | --- | ---: | --- |
| 1 | Conversation production composition | 10 | Conversation manager/production, queue drain, command dispatch/service |
| 2 | Graph authoring adapters | 4 | Definition route handler, definition edit handler, plan validation |
| 3= | Graph boundary event projection | 3 | State-store setters, graph execution events |
| 3= | Graph manager production composition | 3 | Graph workflow manager, workflow production root, jobs queue |
| 5 | Delivery-plan transition policy | 2 | Delivery-plan repository and specs delivery-plan module |
| 6= | Plan-review schemas and hashing | 1 | Review schemas and review repository |
| 6= | Session optimistic composition | 1 | Old shared optimistic module and its new session location |
| 8= | Backend admission schema split | 0 | Backend execution admission |
| 8= | Raw persisted lease decoding | 0 | Graph lifecycle classifier |
| 8= | Shared canonical serialization | 0 | State-store serialization |

This is a **crude prioritization screen, not timing or defect evidence**.
Candidate sets differ in size; each commit counts once per candidate, even if
it changes several listed files. No line-count weighting or rename-history
reconstruction is applied, and uncommitted changes are absent. The JSON records
the exact paths, per-path counts, matching commit hashes, all 60 subjects, and
the exclusion flags. The result supports investigating conversation composition
first. It does not demote a cheap, well-proven schema separation merely because
its file changed infrequently, nor does four touches justify relocating all
graph authoring code.

Reproduce the history window with `git log -60 --no-merges --format='%H %s'`;
for each retained hash, count candidate membership from
`git diff-tree --no-commit-id --name-only -r <hash>`. Evaluate any performance
claim separately with the registered validator's actual selection and measured
collection/runtime, accounting for setup and declared-input selection.
