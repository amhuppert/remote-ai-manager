# Ticket #127 verification

Scope: the Rare Earth audit follow-ups in command-center#127. The archived launch definition (SHA-256 `baac39e5c89ff9b3c0f2b9113a414570524aa439c04e021aee27c2131ec2317d`) is the reproduction source; the mutable saved definition and the Artemis product are outside this change.

## Implemented contracts

| Audit finding | Result and regression evidence |
| --- | --- |
| Adjacent loop dependencies | Edges between distinct owners retain logical exits and target pass-one entries. `adjacent-loops.test.ts` conserves every archived edge, exercises all three serial loops with rejection before approval, and skips the chain on an untaken prerequisite. |
| Stable review inputs | Capturing read-only contexts exclude writers on their lane, including completed writers awaiting landing. Their review identity covers the input tree. Candidate changes reject stale results before task reopening. Shared-document and charter publication use atomic file replacement. |
| Captured handoffs | Capture precedes the configured validation cohort. Review sees the exact staged JSON; schema/value hashes join task/tree identity. Only the accepted candidate is published. Durable validation events retain reviewed payloads and revision identity, including rejected findings. Infrastructure resume retains the same candidate; advisory response recaptures before recertification. |
| Infrastructure budgets | Explicit infrastructure script gates require a warning-free ready JSON report, retry at most three times, retain command logs, and halt resumably without reopening tasks or spending semantic failures. Authoring rejects these gates inside loops and on placements that would skip them. Provider review exhaustion likewise spends no semantic failure. A breaker-triggering rejection counts once and closes its round as failed. |
| Recovery | An unchanged loop-limit resume is refused before restarting. A cap or predicate amendment must change the decision. Repair prompts enumerate editable targets, and rejected operations retain the same proposal count in runtime and durable events. |
| Route settlement | Scheduling settles route, landing, and loop facts to a fixpoint. Durable route events include logical/effective source, captured iteration and edge evaluations. `loop-routing.integration.test.ts` exercises optional routes and SQLite readback. |
| Reliability and telemetry | Exact benign Codex skill-budget warnings remain warnings; actual errors still fail. Private lease-file write failure keeps the accepted validation lease in memory. Timeout reports use elapsed time. Audit extraction loads iteration-only conversation IDs before costs, reads Codex error results and literal Bash rereads, reconciles rotations, and derives clean completion from lifecycle history. Current and archived lane metrics preserve Codex's unknown occupancy semantics. |
| Launch readiness | The real session branch ref is checked before execution reservation. A missing branch produces an actionable start guard and no started execution. The regression uses a real scratch git repository. |

Portable graph-planning guidance covers topology choice, adjacent-loop deployment caveats, durable issue IDs and artifact revisions, explicit artifact ownership, infrastructure budgets, executable recovery, and composed-route acceptance including companion behavior and last-row reachability.

## Automated verification

Behavior changes were developed with failing scoped reproductions and passing registered checks. Schema additions were checked through durability suites. Atomic materialization and shared-document writes each had an open-file-descriptor regression; charter publication then adopted that same existing primitive as mechanical wiring. Logging field/refusal-placement refactors added no separate tests.

Focused evidence includes:

- Archived edge conservation and engine routing: `adjacent-loops.test.ts`, `loop-routing.integration.test.ts`.
- Exact handoff acceptance: `captured-handoff.integration.test.ts`, `captured-candidate.test.ts`, `advisory-recertification.test.ts`.
- Production halt accounting: red `vrun-838bebde-e509-4a5d-a49c-ff0f7221dbc4`, green `vrun-9a1781f3-afd7-448b-a1ce-0c5cbd34308a`.
- Current lane metric parsing: red `vrun-775bd238-963f-43a2-b7b0-550854867129`, green `vrun-6c10f332-0892-4800-9596-dc290442f8a2`.
- Active execution durability: `vrun-76c5ee0b-acf0-469e-9052-8c1647806227`; archived execution durability: `vrun-a6b9b6f8-c6c5-433f-bc16-9b75bac29e6e`; definition storage and planning guidance: `vrun-7920eb4b-1946-4bc9-bd09-776b1dedbc87`.

Registered final full-project TypeScript passed as `vrun-cef95f1d-feca-415f-8fe7-6916d6383fe0`, lint as `vrun-42d707b3-58a6-4370-b7bd-8f996dc3261c`, and architecture seams as `vrun-0e0dbfef-5b1d-446d-8064-cbb17c64d223`.

Broad selection exposed stale contracts for capture ordering, unchanged loop resume, maximal persistence fixtures, and the fake-branch setup in the caller-ownership test. Those were corrected while retaining their original ownership, publication, and recovery assertions. The focused pattern suites passed as `vrun-47445651-3e5c-490c-b7d3-8996870ee12b`; caller ownership passed as `vrun-9268c3db-05d9-4f51-ba90-d2e3178071d1`.

The registered changed-scope regression selection passed as `vrun-32a03c58-3910-4565-b405-11a834ddf929` with `--require-match` (1,112 matching test files). The runner suppresses successful per-test output, so no assertion count is inferred from that selection.

Final formatting passed as `vrun-3246ed51-0d18-4871-a5ae-50fa22444a96`; `git diff --check` also passed.

## Live verification

The session dev server uses the worktree-local `.config/command-center.db`. The scratch `graph-probe` repository and all its worktrees are under `.cc/temp/live-projects/`. No production datastore or external repository was used.

Execution: `2e7ab213-5e2f-41ac-a756-e32eefef6910`, scratch session `copper-harbor`. The prepared unmanaged plan has a readiness context followed by two adjacent loops. The first loop deliberately rejects pass one and approves pass two; independent Claude reviewers inspect revision-bound captures. The second loop must consume the approved payload.

Observed:

- Real Claude startup returned `437` for `23 × 19`, preserved in transcript `5a091cf9-c443-4eea-beaa-9a5d526a2e9d`.
- Initial scratch command registration incorrectly supplied a shell command where the registry expects a script path. Three recorded failures produced `infrastructure_blocked`; both loops remained pending with zero iterations, and readiness retained zero semantic failures. The browser displayed the specific block and resume action.
- After correcting registration, the dev build-stamp mismatch refused resume before mutation. Restarting the dev server synchronized its published CLI and routes. The same execution resumed; readiness completed without rerunning its implementer task, and the first loop started while the second remained pending.
- Readiness run `vrun-c8a79ffc-b5e1-48f8-995b-d4b6c978c60a` returned exit 0 with `CC127 transient discovery warning`; the engine retried, and warning-free run `vrun-8f279f8a-b8df-4f09-87c7-afafa889bdc0` admitted the loops.
- Loop A concluded at `01:00:50.451Z`; loop B activated at `01:00:50.473Z`. Loop B's boundary input and published payload exactly equal A's approved pass-two payload. All three captures match their durable review events, including tree/task/output hashes.
- Final publication caught the uncommitted scratch registration correction in the target session. After that correction was committed, resume completed the join without rerunning tasks. Execution completed and archived at `01:02:43.112Z`, with two A passes, one B pass, and zero semantic failures. The browser displayed the archived result; Next.js reported no compilation/runtime errors.
- A fresh real Codex conversation (`0102b81b-6bc5-4e0d-8852-474220c797fd`) returned `527` for `31 × 17`.
- The audit extractor read the archived run, attributed all four workflow conversations, and correctly omitted the `completed_clean` positive because lifecycle history contains recovery. Its validator-cost output marks three unpriced usage events; no fully reconciled total cost is claimed.

A second live execution, `d3cd7666-3a89-40f3-bedb-85bceb6a98f7`, exercises exhausted-loop recovery and a conditional edge from the logical loop exit. An unchanged resume was refused with `workflow_transition_conflict`; the execution remained halted at pass 1, live revision 1, epoch 1. A `raise-loop-max-passes` live edit raised the cap to two and resume completed the same execution. Durable event 133 records logical source `a`, effective source `loop-a__p2__a`, capture iteration 1, and edge `a-b: active`. The route settled before downstream activation. The archived execution retains the same settlement. A separate deterministic regression proves this resume guard also inspects secondary halt reasons (`vrun-46ceebb6-7798-4bec-a464-38094e752e62`).

Local raw evidence is under `.cc/temp/cc127-live-*` and bundled in `.cc/temp/cc127-live-evidence.zip`: archived execution, durable events, validation ledger projection without private lease tokens, readiness logs, and audit output. The scratch session was deleted, its worktree removal confirmed, the browser tab closed, the original empty dev configuration restored, and the dev server stopped. The worktree-local evidence and scratch repository are retained for review.

## Verification limits

The scratch readiness command exercises the warning protocol without calling Figma. Real provider warnings are nondeterministic; their severity classification is pinned by backend-stream regression tests. Race schedules, malformed captures, stale findings, interrupted-conversation billing, and absent branch refs are covered by deterministic reproductions rather than claims about every live interleaving. Untaken Artemis conditional paths and the possible clipped Artemis table viewport remain unverified.
