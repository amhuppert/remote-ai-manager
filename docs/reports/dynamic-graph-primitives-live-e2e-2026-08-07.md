# Dynamic graph primitives — live E2E acceptance

Date: 2026-08-07

Spec reference: `dynamic-graph-primitives`, revision 11

Status: **PASS after remediation**, with one adjacent model-configuration finding still open

This report records a browser-driven acceptance round against the real Command Center server and real Claude lanes. It covers the three D4 primitives through their shipped workflow patterns: guarded conditional routing, agent-authorized graph expansion, and worker/judge loop unrolling. Each pattern completed and published, its dynamic state rendered in the monitor, and its durable state survived a clean server restart.

## Tested target and isolation

The approved recovery target was a hybrid integration of the published D4 implementation with current main:

- Current-main parent: `0c5c5b7c`
- Published D4 parent: `45bcf559`
- Recovery merge: `cb039b5a` (`merge: recover dynamic graph primitives`)
- Live-found remediation: `eb6f06e0` (`fix(workflows): enforce frozen validation command snapshots`)

All work stayed inside the assigned worktree. `cctl dev ensure nextjs` resolved this worktree to `http://localhost:3001`; no shared port was assumed. After the final restart, `cctl doctor --json` reported matching server and CLI builds:

```text
serverBuild = cliBuild = eb6f06e0-2026-08-07T17:48:02.367Z
buildMatch = true
```

The disposable project lives beneath `.cc/temp/d4-live-project`. Its committed fixture tip was `12e66e6`; the test project and all generated sessions are isolated from user repositories.

## User and agent configuration surfaces

### User configuration

The browser configured and persisted the workflow defaults used by every live lane:

| Setting | Effective value |
|---|---|
| Implementer | Claude Sonnet |
| Reasoning effort | Low |
| Context validator | Disabled |
| Agent validation commands | `verify` for implementers, none for context validators |

The page was reloaded and read back with the same values. Evidence: [workflow defaults](assets/dynamic-graph-primitives-live-e2e/01-workflow-defaults.jpg).

The three saved project definitions were then opened in the visual builder, auto-laid out, saved, reloaded, and read back through the CLI/API. Each advanced to revision 2 while preserving the dynamic fields that the ordinary builder does not structurally edit:

| Pattern | Definition ID | Preserved dynamic structure |
|---|---|---|
| Classify-And-Act | `d42983b5-811f-4b90-8200-953a7be7f30c` | `exactlyOne`, two schema guards, one `else` edge |
| Generate-And-Filter | `eabd1f7d-6b8d-4fd9-9aa1-e034ac952f0c` | `allowAgentContextAdd: true` |
| Loop-Until-Done | `ce966dfe-7fb4-4e9c-9b66-018aa861eb84` | body, entry, exit, predicate, and `maxPasses: 3` |

Evidence: [Classify-And-Act in the builder](assets/dynamic-graph-primitives-live-e2e/02-classify-builder.jpg).

Structural forms for guards, expansion, and loop groups are intentionally not part of the browser editor in this spec. The supported split worked as designed: users can inspect, position, and save the graph without erasing those fields; CLI/API and authorized agent commands own structural authoring.

### Agent and CLI configuration

The three bundled plan documents validated and were created through the production `cctl workflow` surface. A malformed plan containing a second `else` edge failed validation with exit 2, located `definition.edges.2`, and created no definition.

The expansion run exercised the agent-only structural command from the real generator lane with the server-injected capability. A root invocation without a lane capability was also denied before mutation. No capability was copied or synthesized by the harness.

## Real-LM execution results

Every row below was launched from the browser's workflow picker and ran real Claude Sonnet lanes. No scripted completion or service-level state shortcut was used.

| Pattern | Session | Execution | Result |
|---|---|---|---|
| Classify-And-Act | `d4-classify-e2e` | `83a8baec-cf2a-445d-b162-fef100a57ec9` | Completed and published |
| Generate-And-Filter | `d4-expand-e2e2` | `2f1cd451-7598-4e50-995f-3422ce326441` | Completed and published |
| Loop-Until-Done | `d4-loop-final` | `d24ae401-ea04-4cf7-bc26-dca263961368` | Completed and published after two passes |

### Classify-And-Act

The classifier captured raw JSON with `severity: "enhancement"`. The engine then resolved the route exactly once:

- `ctx-triage__ctx-hotfix`: schema guard inactive
- `ctx-triage__ctx-repair`: schema guard inactive
- `ctx-triage__ctx-backlog`: `else` guard active
- `ctx-hotfix` and `ctx-repair`: terminal `skipped`, with recorded inactive-edge reasons and no lanes
- `ctx-backlog` and the downstream report: completed

The final publish join was `56cbcb94-db91-46a9-8f35-75d220a7f375`. The session branch contains `e2e-artifacts/backlog-entry.md` with marker `D4-LIVE-20260807-CLASSIFY` and the model's enhancement rationale.

The monitor rendered inactive schema paths, the active `else` path, ghosted skipped nodes with reason chips, route/skip events, and the captured-output state. Evidence: [completed conditional workflow](assets/dynamic-graph-primitives-live-e2e/03-classify-complete.jpg).

### Generate-And-Filter

The real generator submitted `expand-candidates-1`. One atomic receipt added exactly two contexts, two tasks, and their rejoin edges:

- `context-generate-xdca6354e-candidate-table`
- `context-generate-xdca6354e-candidate-narrative`

Both contexts completed with raw-JSON outputs (`decision-table`, score 8; `scored-narrative`, score 7). The static filter consumed both and selected the table candidate.

The same request and canonical payload were submitted a second time. The CLI returned the prior receipt as a replay, and the graph retained one acceptance row and two generated nodes—no duplicate mutation or event. A separate request attempting a protected configuration override was refused with `expansion-protected-config-override`, producing one durable refusal row and no graph change. Generated children inherited the intended runtime and protected blocks while resolving their own expansion authority off.

The accepted receipt retained request ID, invoker, rationale, added IDs, rejoin target, and payload hash `0428e34e05f4a48e60b8c1315829776f02c6af9672840afb01686e386fdaed8c`. The final publish join was `5c0883b4-5813-4f9c-9e62-f98d1f98f3eb`.

The monitor rendered both runtime nodes with provenance badges, one accepted ledger row, one refusal row, and captured outputs on all four contexts. Evidence: [completed expanded workflow](assets/dynamic-graph-primitives-live-e2e/04-expansion-complete.jpg).

### Loop-Until-Done

The post-remediation loop execution ran from `2026-08-07T17:43:19.358Z` to `2026-08-07T17:45:52.150Z` using six distinct real Claude conversations: brief, pass-1 draft, pass-1 judge, pass-2 draft, pass-2 judge, and publish.

The durable decision sequence was:

1. Pass 1 draft created `e2e-artifacts/loop-result.md` but could not cite a preceding verdict.
2. The independent judge returned `revise` with one exact blocking item.
3. The engine recorded `unsatisfied → materialized`, cloned template version 1, and started fresh pass-2 contexts.
4. Loop History reached the pass-2 entry, which quoted and addressed the pass-1 blocking item. Same-pass review continued to receive ordinary upstream input.
5. The pass-2 judge returned `approved` with an empty blocking list.
6. The engine recorded `satisfied → concluded`; the static publish context consumed effective source `refine__p2__context-review` and completed.

The final publish join was `1281a707-38d6-4e66-a333-5141d3c7f354`. The published artifact contains marker `D4-LIVE-20260807-LOOP`, the required headings, the pass-1 blocking item verbatim, and the resolution explanation.

The live config read proved seed-time policy parity across passes:

| Context | Implementer commands | Validator commands | Profile snapshot hash |
|---|---|---|---|
| `refine__p1__context-draft` | `["verify"]` | `[]` | `sha256:66e560…e4b9` |
| `refine__p2__context-draft` | `["verify"]` | `[]` | `sha256:66e560…e4b9` |
| `refine__p2__context-review` | `["verify"]` | `[]` | `sha256:66e560…e4b9` |

The monitor rendered four concluded loop badges (passes 1 and 2), two decision rows, captured outputs on all six contexts, current/max-pass state, and the concluded ledger. Evidence: [completed two-pass loop](assets/dynamic-graph-primitives-live-e2e/05-loop-complete.jpg).

## Defects found during the round

### Fixed: later loop passes lost frozen command snapshots

The first real loop execution (`509883e3-87ee-4f35-bfa7-502a3a6bddfc`) exposed actual persisted data loss: pass 1 stored `commands: ["verify"]` / `[]`, but the frozen loop template and pass 2 omitted both arrays. The UI/CLI projection was not the cause.

Root cause: loop resolution creates pass 1 and the versioned template before selector freezing. `freezeResolvedDefinitionSelections` transformed scheduled contexts only, so later passes faithfully cloned an incomplete template.

Red-green evidence:

- New repository test failed in both Vitest projects: expected the template's explicit command arrays, received `undefined`.
- The freeze boundary now transforms both scheduled and template contexts.
- Focused rerun: 76/76 assertions passed in `execution-repository.test.ts`.
- The fresh real-LM run above materialized pass 2 with exact pass-1 command and profile snapshots.

### Fixed: runtime authorization ignored an existing frozen snapshot

The command caller resolver still expanded the original selector against the current registry even when an execution carried explicit `commands`. This could make prompts show a frozen policy while runtime authorization broadened after a registry edit.

Red-green evidence:

- New resolver test failed with `["typecheck", "test"]` where the execution snapshot allowed only `["typecheck"]`.
- Runtime now uses `rolePolicy.commands` when present and retains selector expansion only for legacy rows where the snapshot is absent.
- Combined focused rerun: 108/108 assertions passed across the repository and resolver suites.

Both fixes are in `eb6f06e0`.

### Open adjacent finding: Haiku retains an unsupported effort value

Selecting Claude Haiku in Workflow Defaults disables the effort control visually but preserves the prior `reasoningEffort: "medium"`. A real launch then fails preflight with HTTP 422 / `implementer-effort-unsupported`. Selecting Sonnet + Low through the same UI produced the successful runs above.

This is not a D4 graph-semantic failure, but it is a genuine user-configuration defect and remains open. The UI should clear or normalize effort when a model does not support it, or refuse saving the invalid pair.

### Harness correction, not a product defect

The scratch project's first validation fixture supplied the shell command text `git diff --check` where Command Center expects a registered script path. This caused recoverable final-publish/fan-in halts. The fixture was corrected to executable `scripts/verify.sh`, committed, and the affected workflows resumed successfully. No production change was attributed to that harness error.

## Restart and cross-surface durability

After all three terminal executions were captured, the managed Next.js server was stopped and started again. The restarted server and CLI matched `eb6f06e0`. Fresh CLI reads and fresh browser navigation returned the same execution IDs and terminal state:

- Classify: completed; two skipped nodes; two inactive schema guards; active `else` guard.
- Expansion: completed; two provenance-bearing runtime nodes; one acceptance and one refusal.
- Loop: completed; pass count 2; four concluded loop badges; two decision rows; final effective source from pass 2.

Next.js diagnostics reported `configErrors: []`, `sessionErrors: []`, and no compilation issues. The final clean browser navigation reported zero console errors; all graph-workflow API requests were HTTP 200. Connection-refused/SSE entries observed while the server was intentionally stopped were restart artifacts and disappeared after navigation to the restarted process.

## Coverage boundary

The live round exercised every unlocked primitive through its canonical pattern, plus the most important agent mutation negatives: invalid duplicate-`else` authoring, capability denial, idempotent expansion replay, protected override refusal, branch skip propagation, and a false-then-true multi-context loop.

Exhaustive combinatorics remain deterministic-test evidence rather than extra real-LM runs: all expansion size/cumulative caps, multi-rejoin rejection combinations, every route cardinality and unevaluable-output halt, loop exhaustion/cap-raise/predicate repair, crash-window reconciliation, structural-edit frontier conflicts, and pre-D4 parse/equivalence permutations. This distinction is intentional: model calls prove the production integration path, while deterministic suites prove the complete state-space contracts without substituting model judgment for exact assertions.

## Final validation

The report commit was the exact validation target; no source or documentation changed after these runs.

| Validation | Result |
|---|---|
| Prettier check | PASS |
| ESLint plus seam-adoption check | PASS |
| TypeScript (`tsc --noEmit`) | PASS |
| Three D4 pattern proofs plus the two remediation suites | PASS |
| Pre-D4 observational equivalence | PASS |
| Registered unscoped `test-full-suite` | PASS |

## Cleanup and retained evidence

The isolated server will be stopped after final validation. The ignored scratch project, its durable dev database rows, and its session worktrees are intentionally retained inside this worktree so the execution IDs, transcripts, receipts, ledgers, and published files remain inspectable. No external project or user data was modified.
