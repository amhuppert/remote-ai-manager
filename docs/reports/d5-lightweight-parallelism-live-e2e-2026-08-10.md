# D5 lightweight parallelism — live E2E acceptance

Date (America/New_York): 2026-08-10

Spec reference: `lightweight-parallelism`, approved revision 4 (`693fc8b5…`)

Status: **PASS after remediation**

This report records deterministic regression testing, real-provider graph-workflow execution, restart/recovery exercises, and browser/runtime verification for D5. The final acceptance runs used the production scheduler, lane manager, join runner, output-capture path, Claude and Codex backends, CLI sandbox proxy, ordinary project/session state, and final-publish path. A workflow's terminal status was not accepted as sufficient evidence: the committed artifacts, event order, worktree cleanliness, concurrency ceiling, and post-restart state were checked independently.

## Target and isolation

All work and fixtures stayed inside the assigned worktree at `csm/live-test-d5-d6-f07145`, based on `8f310f89`. `cctl dev ensure` assigned this worktree's Next.js server to `http://localhost:3001`; no shared port was assumed. The final browser pass targeted build `8f310f89-2026-08-11T00:11:49.572Z` and Next.js MCP confirmed the project path was this worktree.

The live fixture was a disposable repository named `d5-live-scratch`, with session `fx-d5-live`. It was created beneath `.cc/temp`, exercised, then permanently deleted after evidence collection. The global configuration was restored to its original raw document, including `baseDir` and `maxConcurrentQueries: 3`, and a normalized deep comparison passed.

## Native-spec reconciliation

The approved native spec contains 15 requirements, 25 acceptance criteria, 16 decisions, and 21 tasks. The compiled plan covers all 25 criteria, and `cctl spec verify` passes. Five path-overlap lint findings remain advisory.

The native delivery ledger contains **0/25 historical criterion evidence records** even though the implementation had been human-admitted and merged before this round. `spec delta` therefore classifies all 25 criteria as `never_delivered`. This is historical evidence debt, not evidence produced or repaired by this live round; no records were fabricated or backfilled. The executions and validation runs below are retained in this report as acceptance evidence, but they do not rewrite the native ledger.

## Acceptance matrix

| Capability | Live or deterministic evidence | Result |
|---|---|---|
| Parallel shared-lane scheduling | Three initial contexts admitted concurrently in the broad run; same-lane writes landed serially | PASS |
| Isolated lane compatibility | Real Claude isolated-lane context landed, joined, and published | PASS |
| Legacy session read-only placement | Three read-only contexts ran without worktree writes and banked outputs | PASS |
| Mixed providers | Real Claude and Codex contexts completed in one graph | PASS |
| Output schemas | Claude structured output and Codex const-only schema projection completed; all required outputs were banked | PASS |
| Stop, restart, and resume | Broad run was intentionally stopped/restarted; a halted join was resumed after a fresh server process | PASS |
| Live definition edits | Safe runtime edits were accepted and applied; structural invalid cases remained rejected by deterministic tests | PASS |
| Lane-wide quiescence | Capacity-delayed member B landed before its shared lane was consumed by the join | PASS |
| Capacity ceiling | A fresh `maxConcurrentQueries: 1` run measured `maxActive = 1` across all implementer dispatches | PASS |
| Join replay and index isolation | Target and source private-index drift were reproduced, remediated, resumed, and merged | PASS |
| Final publish | Both final acceptance executions committed exact marker artifacts to clean session worktrees | PASS |
| UI/runtime surface | Session graph controls and workflow builder rendered; Next.js reported no build/runtime errors and every observed request succeeded | PASS |

## Real-provider execution results

### Broad mixed-lane run

- Definition: `b03a4157-6540-457d-89c5-526139e1f8f7`
- Execution: `22d23ece-f73a-4977-a52e-26dcaa7d7995`
- Terminal event: sequence 339, `completed`
- Final session commit: `24114a0`
- Initial parallel wave: `alpha`, `isolated`, and `beta`
- Providers and placements: Claude and Codex across shared, isolated, and session read-only contexts

The final summary contained the six exact markers:

```text
D5-LIVE-ALPHA-7319
D5-LIVE-BETA-2846
D5-LIVE-ISOLATED-9052
D5-LIVE-READER-ONE-4173
D5-LIVE-READER-TWO-6385
D5-LIVE-READER-THREE-8524
```

The run exercised stop/restart/resume, live edits, structured outputs, the sandbox proxy, an intentionally halted join, recovery, synthesis, and final publish. The original join failed at event 306, was resumed at event 311 after remediation, succeeded at event 316, and the workflow published and completed. The final worktree was clean.

### Capacity-one shared-lane join run

- Definition: `46df8c95-ed2b-41bc-8935-7c517ec72b1c`
- Execution: `1847fb64-e3c6-4986-a34f-ad6f05bb9fb1`
- Terminal event: sequence 610, `completed`
- Final session commit: `ef6b98d2c105af469bf168018f1a5ff42d2ec40a`
- Observed concurrency ceiling: `maxActive = 1`

Dispatch order was A (event 529), target T (545), B (562), then downstream C (590). B landed at event 571 before the join began at event 576, proving that a capacity-delayed member of the authored shared lane was durable before lane consumption. The first join attempt exposed stale source-index state and failed at event 578. After the red-green fix and a clean server restart, the same execution resumed at events 584–585, merged at 586, succeeded at 588, published at 609, and completed at 610.

The committed final artifact was checked independently and contained exactly:

```text
D5-RACE-A-1147
D5-RACE-B-3371
D5-RACE-TARGET-2293
D5-RACE-C-4489
```

Two earlier diagnostic executions reached a `completed` status while their expected target/final files were absent. Those runs were explicitly rejected as acceptance evidence. Their transcripts exposed a restricted-Claude relative-path briefing defect; only the fresh run above, whose committed files and event ordering passed, is the capacity-one proof.

## Defects found and remediated

| Defect | Remediation | Red/green evidence |
|---|---|---|
| A capacity-delayed shared-lane member could be assigned a different fallback lane, allowing its authored lane to join too early | Preserve the authored lane as the capacity fallback, except for the join target itself; add the delayed-member regression scenario | Execution-loop focused suite: 92/92, `vrun-722900c9-5eb5-49db-ae5f-069f33dcf5bf` |
| Lifecycle in-flight state was incorrectly used as the global query-capacity lease | Add separate FIFO capacity leases, progress epochs, refreshed scheduler snapshots, re-entry exclusion, transient join leases, and exact pending-error propagation | Execution-loop scheduler/regression suite `vrun-722900c9-5eb5-49db-ae5f-069f33dcf5bf` |
| Restricted Claude resume could inherit a stale filesystem envelope and escape the intended repository | Apply exact non-full-placement policies on every query, fail closed on worktree mismatch, and run restricted shell commands from a bound scratch directory | Final consolidated matrix `vrun-c4f16b45-2103-45e7-ab8e-3da5d42718f4` |
| The sandboxed `cctl` client bypassed the authenticated loopback proxy under `NO_PROXY` | Route sandbox-runtime CLI traffic through the authenticated proxy. Claude additionally confines sandbox networking to the trusted Command Center origin; the Codex SDK currently exposes only a sandbox-wide `network_access` switch, so this report does not claim exact-domain confinement for Codex. | Final consolidated matrix `vrun-c4f16b45-2103-45e7-ab8e-3da5d42718f4` |
| Production scheduling did not forward `excludedContextIds` | Wire the exclusion set through the workflow manager | Final consolidated matrix `vrun-c4f16b45-2103-45e7-ab8e-3da5d42718f4` |
| Managed Command Center skills could be reported as lane drift, while a blanket static exemption hid foreign content | Discover exact adapter-owned checkout paths, attest only safe Command Center bundle symlinks, and fail closed for foreign/unsafe/error cases | Red/green focused suite `vrun-80f420d8-6951-4dd5-90af-4faddd65a8bb` |
| Authored lane dependencies could contract into a re-entry cycle such as `shared → target → shared` | Validate acyclicity after contracting authored non-session lanes | Final consolidated matrix `vrun-c4f16b45-2103-45e7-ab8e-3da5d42718f4` |
| Codex rejected a valid const-only output schema because the provider boundary lacked an inferred primitive `type` | Project a non-mutating provider schema at the Codex boundary while preserving the canonical schema and post-gate | Final consolidated matrix `vrun-c4f16b45-2103-45e7-ab8e-3da5d42718f4` |
| Output-capture integration did not prove the exact write policy or resumed backend reference | Forward the policy and backend reference through the integration adapter and cover owned/read-only paths | Final consolidated matrix `vrun-c4f16b45-2103-45e7-ab8e-3da5d42718f4` |
| A graph-owned join target's ordinary index could be stale after private-index landing | Resynchronize the target index to HEAD under the existing session lock before merge | Red `vrun-5227992f-3756-4faa-ad50-60baf4573329`; green `vrun-d77d8835-85ac-4af1-beed-92aa19d6e28d` |
| Restricted implementers interpreted task-relative repository paths from the scratch shell directory | State explicitly that shell CWD is scratch and every relative repository path must be resolved against the absolute repository path | Red `vrun-20ef5d97-bcc5-4327-9dea-a5fd8e1943b5`; green `vrun-42de5ef2-02e2-493e-9a29-70c8ea172b56` |
| A graph-owned join source's ordinary index could also be stale after private-index landing | Resynchronize both graph-owned worktree sides of the join under the same lock/quiescence proof | Red `vrun-2b39f25c-ab0b-4785-b394-591dcef04961`; focused green `vrun-78913c7b-6ee1-49da-b422-1f94d9e6f26c`; real-Git join-runner green `vrun-f4d6e3e1-422d-47aa-b31b-7bd96b066b0a`; resumed live execution |
| An unassigned downstream loop member authored on a join source lane could make its prerequisite join wait forever | Exclude only unassigned members in the join target's projection-resolved downstream dependency cone from source-lane quiescence; assigned, halted, and independent future members still hold the lane open | Scheduler red `vrun-7a990ce8-2233-460f-8fcb-62a40740b4c2`; focused unit red `vrun-c9e07303-b0a2-4b7f-9041-2daa071e8c64`; architecture red `vrun-d58fa30c-6fac-4a96-b22f-aa62977d6bd0`; combined greens `vrun-21def5e0-bf4e-4f28-8fce-792667083fec` and `vrun-1f39c336-037d-421a-b65b-44a7ab13d41b` |

All production remediations include structured events through the project's logging system where a new operational transition was introduced, including source/target index resynchronization.

## Provider compatibility boundary

The Codex remediation is intentionally narrow. It proves const-only primitive schemas by adding the provider-required type at the SDK boundary without mutating the authored schema. It does **not** claim that every JSON Schema feature is accepted by every provider; broader combinations such as provider-specific `oneOf` or optional-property restrictions remain outside this proof. Canonical validation after the model response remains authoritative.

## Browser and runtime verification

The final Next.js MCP pass reported:

- project path equal to this assigned worktree;
- no compilation issues;
- `configErrors: []` and `sessionErrors: []`;
- the workflow-builder route resolved through `app/projects/[name]/workflows/page.tsx`.

Chrome loaded both the session graph-workflow controls and the visual workflow builder. The builder displayed all four capacity-one contexts, their edges, agent settings, lane-merge validation, and execution policy. All 62 observed document, chunk, API, config, workflow, and SSE requests returned HTTP 200 or 304. There were no console errors or warnings. Chrome emitted one advisory issue: six workflow form fields lack `id` or `name` metadata. This does not affect D5 scheduling or execution and was not introduced by the D5 remediation, so it is recorded rather than folded into the parallelism change.

### Final-validation harness correction

The first registered pre-merge run reached 5,937 passing assertions, then failed ten Claude cases in `validator-prompt-authority.adversarial.test.ts`. Those cases use the real restricted task runner but their scripted provider helper intentionally supplied no server identity; the new fail-closed network envelope therefore stopped before provider capture with `the trusted Command Center server URL is unavailable`. The harness now supplies an explicit inert loopback server URL, as production does, without weakening the fail-closed path. Red: `vrun-91495664-8d50-48e5-9b2e-e24019d9359e`; focused green: `vrun-b507123a-cc90-4c11-a5e0-c3cf0ac761df`.

The next pre-merge run exposed a loop-specific scheduler deadlock after 6,607 passing assertions. The D5 source-lane quiescence check correctly counted authored future lane members, but it also counted an unassigned member downstream of the context merge that would make that member runnable. The join therefore waited on work that could not start until the join completed. The dependency-cone exclusion described above repaired this without weakening the independent delayed-member barrier. Pre-merge red: `vrun-7a990ce8-2233-460f-8fcb-62a40740b4c2`; focused red: `vrun-c9e07303-b0a2-4b7f-9041-2daa071e8c64`; combined green: `vrun-21def5e0-bf4e-4f28-8fce-792667083fec`.

The third pre-merge run reached 21,962 passing assertions and exposed nine remaining integration issues. The downstream-cone implementation read authored edges directly, violating the route-projection boundary used for guards and loop retargeting; it now walks non-omitted projection edges through their effective source. A builder test assumed the generic context-cycle error was always first even though the new, more specific lane-cycle error is also valid, so it now asserts error membership. Finally, the second restricted-Claude integration harness needed the same explicit inert server identity as the adversarial harness. Production fail-closed behavior remains unchanged. Red: `vrun-d58fa30c-6fac-4a96-b22f-aa62977d6bd0`; focused green: `vrun-1f39c336-037d-421a-b65b-44a7ab13d41b`.

## Deterministic validation evidence

Focused red-green runs covered lane placement, delayed admission, lane quiescence, join replay, shared/private-index parity, dynamic drift ownership, output capture, provider schema projection, filesystem envelopes, proxy behavior, runtime edits, and legacy compatibility. Representative completed runs include:

| Validation | Result |
|---|---|
| Execution-loop scheduler/regression suite | 92/92 PASS (`vrun-722900c9-5eb5-49db-ae5f-069f33dcf5bf`) |
| Managed-skill and lane-drift ownership | PASS (`vrun-80f420d8-6951-4dd5-90af-4faddd65a8bb`) |
| Loop quiescence and execution-loop integration | PASS (`vrun-21def5e0-bf4e-4f28-8fce-792667083fec`) |
| Real-Git source/target join index resynchronization | PASS (`vrun-f4d6e3e1-422d-47aa-b31b-7bd96b066b0a`) |
| Restricted validator authority harness | PASS (`vrun-b507123a-cc90-4c11-a5e0-c3cf0ac761df`) |
| Consolidated D5/graph matrix before final pre-merge | PASS (`vrun-c4f16b45-2103-45e7-ab8e-3da5d42718f4`) |
| Final post-remediation graph/loop/authority matrix | PASS (`vrun-3619ed04-22f9-49c5-8e3c-9c39c0b82cc1`) |
| Projection/builder/validator integration regressions | PASS (`vrun-1f39c336-037d-421a-b65b-44a7ab13d41b`) |
| Final lint and structural seams | PASS (`vrun-e397c623-ff7a-4c73-b9ad-3743592d1795`) |
| Final full-scope TypeScript/build checks | PASS (`vrun-31509e5b-b646-46b4-b1da-2730fc70a4a0`) |

The registered pre-merge validation is run after this report is written so its terminal result covers the final report content; that run ID is recorded in the handoff summary.

## Cleanup

All four disposable workflow definitions were deleted. The fixture session deletion returned `worktreeRemoved: true`; the project state entry and scratch repository were then removed, and project discovery no longer returned `d5-live-scratch`. No fixture worktree remained registered. The original global raw configuration was restored and deep-equality checked. Test plans, debug logs, temporary exports, and the isolated dev server were removed or stopped after evidence collection.

The disposable fixture deletion is permanent; its durable state is represented only by this report's execution IDs, event sequences, validation IDs, and exact artifact markers.
