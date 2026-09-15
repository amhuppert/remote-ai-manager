# Graph workflow defect fixes

Date: 2026-09-15. Branch: `csm/graph-workflow-bug-hunt-8beaf6`.

## Scope and result

Implemented O1–O10 from [the implementation review](2026-09-15-graph-workflow-implementation-review.md), following the resolved design. F1–F4 remain intact. Ordinary workflows and Native SDD use the same execution mechanisms; implementer self-commits remain supported.

| Findings | Root cause | Implemented behavior |
| --- | --- | --- |
| O1, O10 | Historical joins were a second, timeless authority for branch contents. | Lane membership records confirmed contributions. Forks capture membership at reservation; joins transfer frozen membership with progress. Scheduling and final publication use that model. Outstanding contributions prevent completion, including when no eligible carrier exists. |
| O2, O3, O5 | Preparation, recovery, and kickoff did not consistently own a generation. | Ordinary launches reserve `running`; approval-required launches reserve `pending`. The promotion write is gone. Recovery runs before runtime admission, under sole process ownership. Status, execution reads, and resume do not normalize. Registry admission, recovery writes, and failure handling check execution identity and epoch. |
| O4 | Reset side effects preceded authoritative admission. | Reset state and the pre-reset event boundary commit in one SQLite transaction. Cleanup runs afterward against captured server identities and preserves servers still needed by other contexts. Refused resets change neither history nor resources. |
| O6 | External loop edges and their policy used different source identities. | One source view supplies effective source, settlement, and routing policy. Cardinality evaluates logical sources, including concluded loop exits; skipped and unconcluded loops retain their existing semantics. |
| O7 | Guard compatibility duplicated primitive type semantics. | The supported schema subset owns the type-overlap predicate, including `integer`/`number` overlap in both directions. Guards and loop predicates use it. |
| O8 | HEAD-relative diffs omitted self-commits; attempt state was too short-lived. | A context stores its review origin, lane, and frozen scope. It survives retained-code resets and redispatch. Validators and approval snapshots compare the candidate with that origin. Missing or mismatched evidence is unavailable, never described as an empty change. New landing attempts receive unique tokens. |
| O9 | Registration metadata, stored bytes, and delivery were independently mutable. | Registrations reference immutable content objects. Failed capture cannot alter an existing publication. Every advertised document must materialize before dispatch. One shared publication queue orders canonical writes; generation checks and exact pending-record settlement prevent stale repair from overwriting or clearing a successor's preparation. |

### Design assessment

Applied the `software-design-philosophy` principles of one owner per decision, information hiding, and removing invalid states. The main simplifications are deleting historical reachability, launch promotion, read-triggered recovery, and the standalone pre-reset history mutation. Existing validation results retain their own tested-context evidence; transfer coverage does not replace that evidence.

The necessary additions are a durable review origin, content identity, one publication queue, process ownership, and migration logic. This is a correctness-oriented simplification of authority and lifecycle, not a claim that total line count decreased. The many fixture edits remove obsolete repository methods and supply the stricter document/approval contracts.

Assessment: **7.5/10** against the skill's diagnostic. Responsibilities and ownership are clearer, with behavioral regressions and documented boundaries. The large manager/loop modules and cross-module generation knowledge remain the two main limits; splitting them further is outside these fixes.

## Existing executions and restart behavior

Three ledgered migrations perform the cutover:

- **0047:** Back up active runtime records, reconstruct only independently supported own-lane membership, and invalidate unverified in-flight join progress. Subsequent transfers use the existing merge engine to establish current contents. Old succeeded join snapshots do not confer visibility. The migration reads definition and runtime tiers separately and writes only runtime state.
- **0048:** Convert existing document bytes to content objects and persist their hashes. Missing bytes remain explicitly unavailable. There is no runtime fallback to mutable path-keyed storage.
- **0049:** Preserve already-recorded review origins and mark previously worked contexts without a trustworthy origin unavailable, including contexts whose reset history proves retained work.

Schema compatibility advances to version **17**, preventing older builds from driving the changed state. One process owns graph recovery and execution for a data directory. A second live owner is refused; a restart can reclaim ownership after the recorded process is dead.

Conservative coverage reconstruction can require extra merges and validation for active executions. If a necessary source is gone, the run halts recoverably instead of claiming that publication completed. Completed history is preserved. File I/O remains outside SQLite transactions.

## Focused verification

Regressions exercise production logic, actual SQLite persistence, real Git repositories, and controlled asynchronous boundaries. Internal modules are injected rather than mocked. Representative evidence:

| Behavior | Failing regression | Passing verification |
| --- | --- | --- |
| Lane contribution coverage | `vrun-b2fe0951-1f71-46e2-9ac4-054cb76fb163` | `vrun-ccbafb33-7563-434e-a66a-4eededd69cd0` |
| Reciprocal transfer and final publication with Git and reload | — | `vrun-e4cd0792-507c-480d-ab51-2db1d032a7cb` |
| Fork membership frozen before asynchronous provisioning | — | `vrun-cfd117aa-3abe-467b-9f8d-349311440cae` |
| Coverage migration through the real split-storage codec | `vrun-329ea7b3-e3fc-44c6-a984-65830261d11d` | `vrun-51050627-93f6-4f5e-8425-12a626caf724` |
| Launch/reset ownership and orphaned ordinary pending recovery | `vrun-0b1dc61c-766b-4b3e-9764-e9cb9727044f` | `vrun-2d6f6298-e881-4a29-b51d-896fe07e41b4` |
| Startup admission, failure, and recovery ordering | `vrun-476e57c7-9a3c-41cd-815b-17786e9d1022` | `vrun-7727ebf1-b6b3-48ab-ae26-6767766c10cb` |
| Process ownership refusal and reclaim | `vrun-5c044b1b-ba75-453d-89d9-2cab40c884f1` | `vrun-1b614316-b033-49b3-8df1-370c204c2c50` |
| Captured server cleanup against replacement processes | `vrun-4d9c4fcc-4935-45b6-8318-1b0778873205` | `vrun-4bd1803f-9524-4d69-abc6-0bb623c1bc0b` |
| Loop-exit routing cardinality | `vrun-b3e74a16-a8af-4b4d-ade8-0cc5cc189baa` | `vrun-bb052442-f287-420a-8573-53676fbe7cc9` |
| Numeric schema overlap | `vrun-f5e2509e-ebdc-4fce-a13b-93aaf571aec1` | `vrun-5638d0d2-9f5e-47f4-8a9c-50dbdee057c3` |
| Retained review origin and self-committed work with Git | — | `vrun-40977159-0014-49a9-b981-882aaa62e609` |
| Stale publication, delivered prompt snapshot, and pending-debt settlement | `vrun-5c2d8c5a-3e9b-46cd-845e-34256aaefc54`, `vrun-9f8bf624-8e08-4824-bec5-88374372c635`, `vrun-db8c6636-e419-45a4-a509-1fa8d473b54b` | `vrun-45c9f7e7-1883-4100-828a-277a7898dcbf` |

Final review also exposed bundle-local async fencing after the runtime became a process singleton. Fence storage and error identities now share the same process lifetime. Tests cover reloads, stale kickoff, duplicate kickoff, recovery probes, and configuration-read failure: `vrun-4aafe43c-c321-4b0f-8730-702730f842ca`.

The changed-wide run also exposed a compatibility harness that returned no HEAD, making review evidence correctly unavailable. Its deterministic Git adapter now provides the same HEAD as its candidate adapter. The reviewed recordings retain their context/validation assertions and reflect immediate ordinary launch admission plus publication through the carrier of all required contributions. Both compatibility test files pass: `vrun-15629459-2a3f-491a-9992-32cfcc15a40a`.

The migration-equivalence and cohort fixtures also construct mid-run state directly. They now capture the synthetic candidate origin before advancing the iteration counter. The migration-equivalence test passes (`vrun-91aa05a8-38b0-4070-aad1-8d971ae3d84e`), as do all 15 dependent cohort/validation test files (`vrun-5666ca46-9b32-4cf9-90a5-506f22c3b281`).

The Native SDD spine fixture now reserves ordinary runs in their admitted state and initializes the lifecycle snapshot consistently with the production repository. All seven integration files using that fixture pass, including abandon/retire and approval reachability: `vrun-fc486e0a-66c6-4088-9b7e-2e3640b65796`.

Active/archived/session persistence contracts, storage lifecycle, and the persisted-collection bounds gate pass together: `vrun-0f024612-f355-4834-97a9-8dfb0c61526d`. The archive maximal fixture covers review origins and content hashes; the stored review scope enforces the authored ownership limit of 100 paths.

All seven direct iteration-fixture consumers pass after capturing their synthetic review origins before validation: `vrun-5edebf7a-61fa-486d-bec1-e41e9c5606f9`. Owned-scope fixtures set placement before origin capture so their assertions exercise the frozen scope.

The scheduler admission fixture now checks that historical join status does not confer visibility before confirmed membership is recorded. The migration registry assertion includes all three cutovers. Both files pass: `vrun-48f851fd-b211-4ea5-a331-c9cb698f9126`.

## Live verification

Used the session's dev instance at `http://localhost:3001`, with its isolated `.config/command-center.db`. The scratch Git project lived entirely inside this worktree. The managing instance was not used for test workflows.

One real Claude Sonnet workflow, execution `4d7e6b43-67dd-421f-8ad9-24bdcae3eb71`, exercised document delivery, self-commit review, restart, resume, approval, landing, and final publication:

1. The agent read a seeded document containing `graph-origin-317`, wrote `result.txt`, and committed it as `bf54a93d921e122114dce120c64dd76afc18d23e` before review. The working tree was clean.
2. Status and execution polling left its running generation unchanged. The approval API and browser showed the committed file as one insertion against review origin `606807ca0954f72184b5582cce0b0feae3677748`.
3. Stopped and restarted the dev server. The ordinary execution recovered to `paused` at epoch 1. A separate definition-approval execution stayed `pending` with zero iterations. Process ownership changed from the stopped process to PID 42337.
4. The same review origin, frozen candidate, and patch survived restart. Explicit resume returned the run to `running`; the browser approval action succeeded.
5. The engine adopted the existing commit, performed the final join, and completed at `2026-09-15T20:18:52.272Z`. An independent SQLite read found the archived completed execution, a succeeded final join, no artifact debt, and `implement` in the session lane's confirmed membership.
6. The actual session branch contained exactly `graph-origin-317\n` in `result.txt`, committed by final publication as `2b2a0dd035bc081738fd1e61e9d6326454d52f75`. The context had only one agent iteration across restart and resume.

Approval stories were also inspected at desktop and 390px widths for whole-tree changes, owned changes, and unavailable evidence. Approve/reject controls, keyboard rejection, and disabled approval for unavailable evidence behaved correctly. Next.js reported no configuration or browser-session errors.

Evidence is retained locally under `.cc/verification/`: before/after restart API snapshots, the archived execution, `live-verification-facts.json`, and approval/completion screenshots. Both fixture sessions were deleted, Playwright closed, and the session Next.js/Storybook servers stopped.

This live scenario used Claude. Backend-neutral concurrency, reset, reciprocal-loop publication, migration, and error cases are covered by the focused production tests rather than separate live model runs for every scenario or backend.

## Final checks

All commands use the registered validation scheduler. Exact output is saved locally under `.cc/verification/final-*.txt`.

| Check | Scope | Result / run |
| --- | --- | --- |
| Format | Changed files | Passed — `vrun-67bf6311-47bc-4f22-8423-b9a1bb413555` |
| Typecheck | Full project | Passed — `vrun-60de3964-3086-4031-ac5a-2c41fc19f2a7` |
| Lint | Changed files | Passed — `vrun-b4169428-c12d-4df9-972b-7e32bad76026` |
| Architecture seams | Full project | Passed — `vrun-aa2eedf5-ee3f-4711-84f9-72f6287ce63d` |
| Tests | Full suite | 30,357 passed, 4 fixture failures, 8 skipped — `vrun-601dbcaf-37de-4cfe-8e55-91599f8f921e` |
| Tests | All three failing files after fixture corrections | Passed — `vrun-4c795e1b-687f-4f69-9d46-4af509c3bb15` |
| Whitespace | Working diff | `git diff --check` passed |

The full run completed all 2,060 test files. Its four failures were confined to three test files: CLI document registration needed captured-content input, graph publication displays needed confirmed session membership, and the reset expectation needed explicit unavailable review evidence. Only those test files changed afterward; all three pass on rerun. The publication display test also verifies that historical joins cannot substitute for confirmed membership. The full suite was not repeated after these fixture-only corrections. Format, typecheck, and lint were repeated and passed. No unexpected generated files or dependency changes appeared.

No application deployment or commit was performed.
