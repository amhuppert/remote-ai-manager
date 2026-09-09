# Ticket 129 — checkpoint compaction and history zoom verification

Date: 2026-09-09. Scope: native `cc-checkpoint-compaction` items **1–2**. Ticket items **3, 5 and 7 remain open**; this report does not close the broader ticket.

Follow-up: [Codex enablement](codex-enablement.md) records subsequent certification and activation. This report preserves the original release verdict.

Release verdict: **all five required full-project checks passed, and the enabled Claude session/project production journeys passed**. Codex and Cursor remain disabled and unfinished backend obligations. This verifies the enabled items 1–2 delivery; it does not claim certification of those disabled adapters or closure of the broader ticket. No failing gate is waived.

## Revision and authority

- Workflow baseline: `154e8a46422d60d6acc54814d44e8f589543a456`.
- Implementing candidate: `77771844328f44f6a3e738d93a5f9793c5bb4ec0` plus the release-verification working diff. The workflow owns the eventual landing commit; this report does not claim a commit that has not been created.
- Final production/config patch SHA-256: `75ddcd1a9bf5fa0a90b2509031361b3fcc90497475e5544b8cdaf71a3d51af40`, computed over `git diff HEAD -- .prettierrc eslint.config.mjs src`. Report-only edits are excluded to avoid a self-referential hash.
- Native candidate: `67da08cf-e13f-46ab-8f16-43e5348f4e78`; immutable pinned revision: `ebb3d57c-9b7a-4348-af35-1c585640391d` (spec revision 3).
- Governing sources: pinned release excerpt/full native spec (charter entries 11–12), delivery contract (16), and P8 implementation package (18). R9.4 and D9 permit only independently verified backend capabilities. The older UI evidence's claim that outline HTTP destinations were unavailable yields to the current production routes and the pinned requirement.
- The isolated managed server and source-built CLI matched build `777718443-2026-09-09T05:21:16.524Z`. Next MCP identified this exact delivery worktree. Final client changes were verified through its HMR-served source. The server used its own token, `.cc/temp/checkpoint-release/config/command-center.db`, and scratch project/worktree. It was stopped and the temporary `CommandCenter.json` entry restored exactly.

Detailed inventory: [production-review.md](production-review.md). Actual browser/CLI actions, operation IDs, limitations and supporting regression runs: [live-verification.md](live-verification.md). Pre-feature failures: [baseline.md](baseline.md).

## Required registered checks

Every required command uses `cctl validate run <name> --scope full --queue-if-busy --json`. Verdicts are read from the JSON envelope, not inferred from shell exit. Scoped supporting runs use `--require-match`; their actual matched counts are recorded in the linked evidence documents.

| Check | Settled verdict | Run ID |
| --- | --- | --- |
| Format | Passed | `vrun-75cbc048-56b6-4fcc-82ba-7c0359e8482a` |
| Lint | Passed | `vrun-4b8ace1c-1b8a-4562-9909-5168618a9830` |
| Typecheck | Passed | `vrun-eb0481f2-b0d5-482e-8029-dd814c7de73a` |
| Seams | Passed | `vrun-25968390-4126-44ed-acd6-7795f6ba5081` |
| Test | Passed | `vrun-79ebdeb2-f4d1-4412-b862-1f120b53de41` |

The initial full lint failure `vrun-51dadc7d-2449-4f37-88ca-015ed990095d` contains eleven errors exclusively in generated bundles and fixture scripts under `.cc/temp/`. The designated, git-ignored scratch directory is now excluded by the existing ESLint global-ignore configuration. No product source or test directory was excluded and no lint rule was weakened. This is a configuration correction; no behavior test was added for it. The subsequent full lint and format verdicts passed.

The baseline full test run `vrun-292c4e94-2e6d-4e95-b18a-ca67456e017a` failed on a 10-second hook timeout in `scripts/pre-merge-hermetic.test.ts` and a 15-second test timeout in `scripts/validation-scope-wrappers.test.ts`. Both passed together at the same baseline revision in `vrun-45b654c8-54b8-45dc-a82b-016d52863f33`. Those exact timeouts are the only baseline attribution established; they do not waive the final gate.

The first release full suite (`vrun-073ead77-a462-4822-b1d0-d7e4ddbdcebf`) finished in 1280.96 seconds: **1 failed / 1983 passed / 3 skipped files; 2 failed / 29,693 passed / 8 skipped tests**. The baseline timeouts did not recur. Both failures were in `src/lib/prompt/queue-route-spans.test.ts`: its type-asserted fixture omitted the required `checkpointAcceptsQueuedInput` dependency introduced by this release diff. This is attributed to the workflow, not the baseline. The fixture now supplies the ordinary non-maintenance predicate; its existing timing/refusal assertions passed in registered single-file rerun `vrun-85a13f76-8a6c-4ec5-9d66-507d85c228dd` (1 matched file). This is mechanical test wiring, with no production behavior change. The subsequent full suite passed as recorded above. Its success wrapper omits test totals, so the earlier failed run's totals are not represented as final-run counts.

After the final full run, `git diff --check` passed, the production/config patch hash still matched the recorded candidate, and `git status` showed no snapshot/recording rewrites or temporary dev-server configuration. All launched registered runs settled; no required check remains unresolved.

Intentional red reproductions found workflow defects in saved history-boundary wiring, premature ready publication, stale snapshot reference restoration, maintenance queue admission, query ownership/notification timing and queue-review eligibility refresh. Their passing production regressions are listed in the two supporting reports. Style registration, local badge contrast and unavailable-duration formatting were corrected within the checkpoint surface. The changes do not expand into later ticket items.

## Production reachability and release matrix

| Obligation | Observed result |
| --- | --- |
| Storage, retention and cleanup | Preserving schema-15 migration is registered; immutable payload trigger and scoped parent-delete/FK cleanup are active. Archive updates and rolling artifacts do not delete checkpoints. Real SQLite lifecycle, isolation, rollback and cleanup tests exercise these owners. |
| Admission, retirement and hydration | Scoped HTTP mutations enter the canonical conversation manager. Reservation precedes competing turn admission; captured-source fences, owned close/drain and durable host receipts precede ready publication. Hydration overlays repository authority and cannot revive a retired reference from stale snapshots. |
| Attempt and queue acceptance | Production turn assembly binds exact seed/input/queue correlations before dispatch. Matching acceptance plus fresh reference is required. A failed required receipt holds release. Queued input during maintenance is durable and dispatches only after readiness. |
| Routes/events/CLI | Both scoped checkpoint/read/entry/image route families are active; durable writes publish public receipts. The shared event listener and reconnect invalidation recover through GET. Registry-dispatched branch CLI uses explicit mutation scope and bounded receipt/seed/file disclosure. |
| Session and project UI | Both hosts expose distinct checkpoint and artifact actions, typed temporary refusals, durable progress, original evidence navigation and operation-addressed recovery. Both completed real Claude journeys, remount and native SSE reconnect. |
| Enabled provider journey | Three checkpoints per scope applied exactly once, each on a different fresh continuation with no resume reference. The next ordinary turn after the final application omitted the seed. Both scopes accepted input queued during building. Six actual ordinary turns remain in each original conversation archive. |
| Read-only evidence | Original outline/range/tool/image reads and saved seed viewing made no ordinary provider turn. A newer rolling artifact left all six frozen checkpoints unchanged. Both original tool and image exports matched their hashes. |
| Keyboard and recovery | Both scopes support keyboard action/evidence activation, readable disabled reasons, Escape focus restoration, queue review/discard and deterministic reconcile refusal. Recovery names the operation and explains no undo of prior effects. Synthetic unknown delivery remains blocked without replay. |
| Accessibility | Applied panels: zero axe violations, 17 passes, no incomplete checks in both scopes. Expanded recovery/archive views with hovered rows: zero violations, 17 passes. One session description contrast check was manually resolved: unobscured at nine points, 5.01:1 computed contrast. Final browser/Next diagnostics show no application errors. |

## Independent continuity outcomes and backend gate

The cert4 artifacts were independently checked against original fixture facts, real SQLite payload/acceptance rows, protected reference digests, retained image bytes and recorded answers. The nine expectations cover an excluded column, exact export-job identifier, superseded destination bucket, rejected row writer, failing shard, finance blocker, alert threshold, image-only p99 and next-action CLI flag. Claude passes all nine in both scopes. Codex's session answer misses the export-job identifier; its structural continuation success does not override this failed quality outcome. The failed sample was retained rather than retried to select a passing result.

| Backend / scope | Independent facts | Three-cycle seed bytes | Capability |
| --- | --- | --- | --- |
| Claude / session | 9/9 | 8381 / 8475 / 10608 | Enabled |
| Claude / project | 9/9 | 8823 / 8940 / 10148 | Enabled |
| Codex / session | 8/9; RCN-4417 missing | 7051 / 8086 / 10763 | Disabled; unfinished |
| Codex / project | 9/9 | 8350 / 8759 / 10231 | Disabled; session verdict blocks enablement |
| Cursor | Not probed | Unavailable | Disabled; unfinished |

Each cert4 fixture has three accepted fresh continuations, a queued cycle, seed omission afterward, full memory redelivery, original archive/image retention and independent artifact generation. The protected probe stream supplies exact assembled-input and no-fork evidence; the repository audit independently corroborates seed hashes, accepted references and immutable state. Ordinary browser observations are not presented as a substitute for those adapter-boundary observations.

The additional production browser corpus independently established DELTA-681, `/v2/ledger/export`, RCN-4417, ACK-902, no publishing before Alex approves, rejected nightly replacement/lost audit history, CSV superseded by JSONL, and chart p99 812 ms. Both first post-checkpoint answers retained the requested facts. Later narrow prompts answered DELTA-681/ACK-902 correctly. The browser pass did not separately ask the next action; that expectation is covered by cert4.

Original tool evidence: 50,439 UTF-8 bytes, SHA-256 `b64eca0f8e337030f5165bc0b403c093aca7eef2d7a547a5fe1c824c8e8e991f`, raw sequence session 19/project 26. Original image: 818 bytes, SHA-256 `a2e0297531a6b95def14138c3da1423fe966082089cc0ed30fa09b468668b695`, original sequence 0/block 2, decoded 300×140. Both scopes recovered the exact bytes through production navigation and CLI export. Separate oversized fixtures exported complete 512,415-byte JSON artifacts behind 571-byte stdout manifests, including Unicode and the final evidence marker.

## Bytes, usage, cost and timing

The production browser checkpoint seeds were session **5902 / 6876 / 6498 bytes** and project **5326 / 6176 / 6380 bytes**. Exact UTF-8 total/section sizes and hashes were checked against SQLite. Every seed stays within 32,768 total, 18,432 working-state, 10,240 dialogue and 4,096 framing bytes. Each used two compaction passes. The two rolling artifact generations add one pass each: this browser verification used **14 compaction-model calls and 12 ordinary Claude turns**. These are separate from cert4's per-fixture ten ordinary/six compaction calls.

| Browser ordinary Claude usage | Session (6 turns) | Project (6 turns) |
| --- | --- | --- |
| Provider-reported cost, summing per-turn deltas | $0.834229 | $0.818726 |
| Uncached input tokens | 14 | 14 |
| Cache creation input tokens | 73,575 | 72,017 |
| Cache read input tokens | 135,670 | 134,552 |
| Output tokens | 811 | 852 |
| Sum of provider result durations | 19,696 ms | 21,412 ms |

Token columns sum the provider's per-result usage fields; cache creation/read are separate from uncached input. Raw provider cost can be cumulative within a runtime, so the cost row uses the adapter's per-turn deltas rather than adding cumulative totals. These are fixture observations, not a cache-preservation or savings claim. Ordinary input also contains standard instructions/context, so seed byte reduction is not a provider occupancy percentage.

Cert4 ordinary Claude cost was provider-reported $0.7421365 session/$0.7449175 project. Codex ordinary cost was CC-estimated $0.499846/$0.593498 using `cc:estimateCodexCostUsd`. Each cert4 fixture used six actual Claude compaction calls; their per-call cost remains unavailable. Compaction cost/usage and backend occupancy are null/unavailable in checkpoint receipts, not zero. The six-call cert4 compaction ceiling leaves no repair headroom after three two-pass builds. No unsupported metric is inferred from byte size.

## Evidence locations and unfinished work

Protected raw references and seed snapshots remain under `.cc/temp/` at mode 0600; public reports contain hashes and operation handles. They are not included in this ticket attachment.

- Cert4: `.cc/temp/checkpoint-probes/<backend>/cert4-<scope>/evidence/{public-report.json,protected-evidence.json}`. Independent audit: `.cc/temp/release-probe-audit.json`.
- Public cert4 report SHA-256: Claude session `c5612868c4b0ea7ac75b137c4fc287a55c43b60d4109bac1ff65b9b0538e7b9a`; Claude project `4da82407063468c7cad2d8f3f1bc5dc2e7f984bb577eb001f8e939c4ff7c2812`; Codex session `f8d5f14445e4885389010bfa7ab58946734863d752357b3cb9daab7b322f336d`; Codex project `d8179bc3635bd8c81e73bbd76723adda971e3fa0653fca7da5a2c649a42d6e94`. Rechecked unchanged after full formatting.
- Browser/CLI: `.cc/temp/checkpoint-release/evidence/`, including `branch-cli-doctor-final.json`, `browser-*-SSE-reconnect.json`, `browser-*-recovery*.json`, `browser-expanded-axe-final.json`, `artifact-audit.json`, `lifecycle-audit.json`, `ordinary-usage.json` and registered verdict envelopes.
- Immutability comparison: `before-artifacts.json == after-artifacts.json == final-browsing.json`; private counterparts retain rows/references/seeds for controlled inspection. Both normal fixtures still have six user messages and three applied operations. Neither synthetic recovery fixture allocated a runtime.

Untaken branches are explicit: synthetic recovery buttons were focused but not activated; queue retry was not selected; no real crash was induced in the browser. Production integration tests cover recovery generation, cancellation, uncertain delivery and persistence/crash boundaries. Browser memory was empty; nonempty memory/notepad redelivery relies on cert4 and integration evidence. The broader CLI option matrix is tested deterministically rather than exhaustively clicked in this pass.

Codex's failed independent outcome and Cursor's missing certification remain unfinished backend obligations, with admission disabled under D9. Ticket items 3 (current-work refresh), 5 (checkpoint forks) and 7 (optional agent handoff) remain open. No automatic checkpoint, native manual compaction endpoint, workflow advancement, provider rollback, destructive schema reset or provider auto-compaction setting change was introduced.
