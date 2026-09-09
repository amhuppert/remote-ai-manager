# Checkpoint production journey evidence

Verified 2026-09-09 in the assigned delivery worktree at `77771844328f44f6a3e738d93a5f9793c5bb4ec0` plus the release-verification diff. Governing sources are the pinned release excerpt/full spec (charter entries 11–12), delivery contract (16), and P8 package (18). This pass exercises the enabled Claude adapter. Codex and Cursor remain disabled; their limitations are recorded in the independent production review and release report.

## Implementing system identity

`cctl dev ensure` started the temporary managed `checkpoint-release` server at `http://localhost:3300`. Next MCP returned this exact session worktree as `projectPath`. The source-built `dist/cctl/cctl.mjs` and server doctor matched build `777718443-2026-09-09T05:21:16.524Z`; earlier journeys used the same implementing checkout before its controlled restarts. Final client fixes were served through Next HMR and reverified after navigation. The managing installed CLI was used only for managed-server/validation/workflow actions.

The server used `.cc/temp/checkpoint-release/config/command-center.db`, its own API token, and a scratch `checkpoint-lab` git project entirely inside this worktree. No main/live datastore migration experiment occurred. A temporary `CommandCenter.json` server entry was restored byte-for-byte after `cctl dev stop checkpoint-release` succeeded. Evidence remains in `.cc/temp/checkpoint-release/evidence/`; private snapshots and captured files are mode 0600.

## Real Claude journeys

| Scope | Conversation | Three applied checkpoint operations (ordinal order) | Queued acceptance |
| --- | --- | --- | --- |
| Session `release-session` | `591977f3-4884-45b2-9e60-9e725b36bf6e` | `caffb9cd-7cde-466e-9cae-563864f2524e`, `3c0615c3-30df-4ead-84f7-fff1658fe0d4`, `32241323-a313-432e-b674-74cf0db54e2b` | Third checkpoint; message `6295cba0-4011-4c8f-bab4-e33d72e68b66` |
| Project | `3c57655b-5f34-4898-bb0a-326e6e220a89` | `23a037e0-c71c-4a04-8405-4c9ba14ddd6d`, `9b3e404b-1f59-469a-9235-1bf2baea822e`, `aa6709ba-2ad1-4567-a8e7-79a8f924b176` | Second checkpoint; message `309b4550-720e-4f18-8568-7abd794a1eaf` |

- Keyboard activation of **Compact context now** was exercised in both production hosts, separately from **Generate compaction artifact**. Ready state came from durable GET receipts. Maintenance queue submission returned 200, persisted `next_turn` input, and dispatched it after readiness. The session building race returned a typed 409 `checkpoint_pending` with its actual operation. A project request intended to race instead arrived after readiness and was admitted; its third operation was deliberately completed and is counted above, not reported as a refusal.
- Both conversations retained their identity, worktree, selected Claude profile and original transcript. Each has six actual user messages and six completed ordinary turns. Each checkpoint has a different accepted continuation from its prior reference, matching frozen/accepted seed hashes, one bound attempt, and one acceptance event. The three `checkpoint.fresh_runtime` events per scope correlate with `prompt.runtime_create.hasResumeRef=false`. Later ordinary turns have no extra binding/acceptance; the final ordinary turn uses memory delta. Protected cert4 probes and production integration tests provide the additional exact assembled-input/no-fork observations.
- Building/applied progress survived panel close and reload. A controlled finite first SSE response forced the browser's native EventSource through `open → error → open`; both scopes then issued real checkpoint list/eligibility GETs and recovered applied state. `browser-*-SSE-reconnect.json` records those requests. An earlier offline/online experiment did not close SSE and is not credited as reconnect evidence.
- After all ordinary turns, both rolling artifacts were regenerated. Their source boundaries were newer than checkpoint 1 (session 44 versus 20; project 62 versus 38). Selecting checkpoint 1 showed the explicit newer-artifact distinction and its original frozen handoff. `before-artifacts.json`, `after-artifacts.json`, and `final-browsing.json` are equal across all captured conversation, archive, image and checkpoint fields.

## Independent facts and original evidence

The expected facts were written before generation in `independent-expectations.json` and the initial fixture prompt. The original Read result independently names export job **RCN-4417**, approval **ACK-902**, and the prohibition on publishing before Alex approves. The attached chart displays p99 **812 ms**. Both first post-checkpoint answers correctly retained release **DELTA-681**, `/v2/ledger/export`, RCN-4417, ACK-902, the rejected nightly bulk replacement and lost-audit rationale, CSV superseded by JSONL, and chart p99. Session also volunteered the stored-identifier constraint. The later narrow prompts correctly answered the requested identifier/blocker. The next-action expectation was not asked in these narrow browser turns; the independently audited cert4 corpus covers next actions and the broader nine-fact matrix.

Both browser hosts navigated original outline/ranges, complete tool results and original image bytes under the owning scope. The original tool result is 50,439 UTF-8 bytes with SHA-256 `b64eca0f8e337030f5165bc0b403c093aca7eef2d7a547a5fe1c824c8e8e991f`, including the end-of-file evidence at line 902. Its raw sequence is session 19/project 26. The original image at raw sequence 0, content-block index 2, decodes as 300×140 and is 818 bytes with SHA-256 `a2e0297531a6b95def14138c3da1423fe966082089cc0ed30fa09b468668b695`. Keyboard-opened image links and source CLI exports recovered those bytes in both scopes.

Oversized, Unicode-bearing exports use separate synthetic fixtures. Their correctly normalized raw entry 4 exports as 512,415-byte JSON files, while stdout stays 571 bytes and names the file/hash. Exact file size, manifest hash, Unicode content and final `FIXTURE-481` marker were independently checked. Session file hash is `b56aefc7292ee88c2d7150a2e9db41e95287f425d4e0652900e18d2a0791cc0b`; project is `23108b599bcd2b36171af0dbdf2d2f4737a988de4bcae85afb7caeff52773a7c`. An initial malformed synthetic raw-frame fixture was identified and a correctly shaped entry appended without altering its original prefix; it is not counted as a product failure.

The branch CLI used explicit project/session flags. Supplying a project conversation through the session mutation scope returned 404 rather than posting in a neighboring scope. Receipt lists, explicit seed detail, complete-entry and image exports addressed the matching isolated server. Parser/help/disclosure matrices remain covered by the registered CLI suite; this browser pass did not manually repeat every leaf option.

## Recovery and accessibility

Synthetic recovery fixtures were seeded through the canonical repository/queue service while the server was stopped, with no model call. Session operation `e94ddd16-8eeb-4356-94a8-e00834e5779f` and project operation `f8e3fad4-f66c-425c-aa20-63a08c4af4a0` remain `needs_reconciliation` after an unknown attempt. Both production UIs exposed queue review, keyboard discard, an operation-addressed recovery action, and the explanation that recovery cannot undo tool effects, file changes or prior work. Reconcile returned 409 `recovery_required` with the actual operation, phase and attempt receipt; no runtime was allocated. Neither uncertain input was replayed. Project queue discard refreshed recovery controls without a reload after the scoped SSE fix.

Recovery buttons were focused but not activated; retry was not selected. These fixtures verify unknown-state navigation and refusal, not a real crash or a recovery-generation provider journey. Restart, deterministic repair, explicit recovery generation and cancellation outcomes are covered by the production manager/repository integration tests.

Escape restored focus to the checkpoint chip in both scopes. Enabled actions, temporary-disabled reasons, evidence links and queue review were keyboard-operated. Applied panels passed axe WCAG 2 A/AA, 2.1 AA and 2.2 AA with zero violations, 17 passing rules and no incomplete rules in both scopes. Expanded recovery/archive panels, including hovered rows, also have zero violations and 17 passes. Axe could not resolve one session description background; manual inspection found it unobscured at nine points, with computed text/background colors giving 5.01:1 contrast. Project had no incomplete checks. Final browser console capture and Next MCP had no application errors. Expected 409 reconcile responses are recorded separately.

## Remediation found by the real flows

- The shared queue route rejected an idle conversation held by checkpoint maintenance. It now queries the canonical manager hold, accepts input in building/retiring or the ready race, and forces `next_turn` queue delivery. Both-scope real manager/SQLite tests pin admission and delayed dispatch.
- The passive composer cache reader no longer installs disabled query options over the active checkpoint query. It uses a QueryCache subscription with React Query's batched notifications. Reproductions cover missing-query diagnostics, reconnect refetch and mounting a receipt surface without render-time React updates.
- Checkpoint eligibility now invalidates on scoped `message-queue-updated`, allowing resolved queue review to expose recovery immediately. Real QueryClient tests cover both scopes and exclude sibling invalidation.
- Visual-only fixes use the design system's filled count badge for raw sequence labels so hover retains contrast, and render unavailable duration without an `ms` suffix. These visual changes were verified in the browser; no behavior test was added solely for appearance.

The fixes preserve the existing manager as lifecycle owner and add no checkpoint trigger, provider setting or adapter enablement. Source/seed bodies and raw references are absent from added public logging. Repository tests and unchanged archive/image hashes support the evidence invariant.

## Supporting registered checks

| Behavior | Failing reproduction | Settled pass |
| --- | --- | --- |
| Maintenance queue admission | `vrun-2a9c8418-53f8-482c-9071-12fa515af6fb` | `vrun-29f94a6e-6cb9-47db-a1c7-df98b4ebdfa1` (3 files) |
| Reconnect query ownership | `vrun-b0d89d82-9522-4796-ab84-069aca64fe30` | `vrun-0b32a2ce-f642-42e4-b678-ba6dabe804a4` (1 file) |
| Render-time cache notification | `vrun-37c7b6da-5b48-4ce1-af2f-ad0e33ef7f8c` | `vrun-4d1ac6d0-5f64-4af5-9051-5c41b5afb0ff` (1 file) |
| Recovery eligibility refresh | `vrun-232ca99c-748a-4a97-846a-e40913499fb5` | `vrun-0e55e6c7-f01c-495c-ba7c-d71ad68aedb0` (1 file) |
| Final hold/SSE/evidence/maintenance regression set | — | `vrun-f525bd6b-11a5-4a0b-ae9d-6f7d76a4e2f0` (4 files) |
| Format | — | `vrun-48542664-0ce5-449e-a7df-65a087dd741b` |

Scoped tests used `--require-match --json` and their actual matched counts were read. The final supporting invocation also named a nonexistent `CheckpointPanel.test.tsx`; four actual files matched, and only those four are credited. Full registered release gates are recorded separately in `verification.md`.

## Usage and evidence limits

Session checkpoint seeds were 5,902 / 6,876 / 6,498 bytes; project seeds were 5,326 / 6,176 / 6,380. Exact section sizes/hashes are in `final-browsing.json`; every total and section is below its native byte ceiling. All six checkpoints used two generation passes. Rolling artifact generation used one additional pass per scope: 14 compaction-model calls in this browser pass, separate from 12 ordinary Claude turns. No additional ordinary provider turn resulted from browsing, export, reconcile or queue discard.

The six ordinary Claude turn costs sum to provider-reported $0.834229 session and $0.818726 project. Compaction-model cost and occupancy remain unavailable, not zero. Empty scratch memory produced full/delta delivery events but no substantive memory entries; nonempty memory/notepad redelivery is covered by cert4 and integration evidence. The browser corpus is deliberately smaller than cert4, and its results do not recertify disabled adapters.
