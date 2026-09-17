# Operating-envelope cleanup — ticket #141

This branch removes single-consumer wire shims, global port registration, identity signing, repeated backend checks, and redundant restart/process protocol machinery. It preserves the graph/spec delivery rules, mutation coordination, build parity, and process teardown ladder.

## Disposition for the PR

| Item | Disposition |
| --- | --- |
| 1. Stored-shape readers | Both hosts audited. Removed singular/flat execution repair, lane-less worktree fallbacks, repeated legacy purge, ref decoder arms and snapshot/collaboration read repair. Migration 0051 rewrites remaining archive/snapshot/collaboration shapes once. Current null-lane session landing remains supported. V3 delivery-plan readers are kept: removing them would require rewriting signed historical identities and inventing authored coverage or changing the existing fresh-signoff contract. |
| 2. Consumer compatibility | Removed ticket attachment shim and alias, workflow execution aliases, old-server identity/header tolerance, optional events response shape, and fabricated one-off/spec seed identities. Migration 0050 clears fabricated seeds; actual definition provenance remains. |
| 3. Global port registries | Removed all five register/resolve/reset APIs. A concrete production composition supplies required interfaces to graph and merge callers. Non-participating policy helpers live under testing only. |
| 4. Identity signing | Removed HMAC/key provisioning. Caller identity is generated from injected environment fields independently of target flags; the server still resolves current membership and lane ownership. |
| 5. Cursor preflight | Cached by SDK package realpath and mtime, including failed and concurrent checks. |
| 6. Claude managed policy | Removed managed-policy origin classification; cached readability check of the native-memory flag settings shared by conversation/task launches. |
| 7. Restart-rule loop | One pass; stale-operation refusals throw with their reason. |
| 8. Cursor IPC/process identity | Removed frame version and process start-tick comparison; retained cancellation/shutdown/TERM/KILL and exit confirmation. |
| 8. Windows tolerance | Removed Windows-only directory-fsync error tolerance from atomic JSON write and state DB. |
| 8. Ticket keyset pagination | Kept: explicitly optional in the ticket; stable ordering and bounded ticket disclosure remain useful at the current scale. |
| 8. Debug-log CORS | Kept: probes run inside instrumented project apps on dynamically assigned local/remote dev-server origins; limiting ingestion to two CC origins would break that supported use. |

The CORS source is the instrumented app, not the ingestion URL: see `src/lib/workflows/debug/prompt-policy.ts`, `src/lib/dev-server/service.ts`, and `src/lib/debug-log/service.ts`. There is no fixed pair of source origins in this repository.

`ENVELOPE.md` is unchanged. Workflow steering drops retired registration, archive-decoder and singular/flat-execution rows and seed-filler wording. Origin, placement and edge floors remain: these additive shapes were not established absent by the ticket’s audit.

## Stored-shape evidence

The audit opens SQLite with `mode=ro`; it does not import the application or run schema-floor/migration code. Exact SQL, timestamp, host, and results are in [mac-shapes.json](mac-shapes.json) and [linux-shapes.json](linux-shapes.json). Empty grouped result arrays mean zero matches. Reader probes target current repository inputs. The separate all-storage diagnostic may match retired fields or backups and is not evidence that the listed reader needs its compatibility branch. The pre-assignment probe identifies structural candidates; the Mac candidate also passed the frozen transform and current decoder in the backup check below.

| Shape / evidence | Mac | Linux |
| --- | --- | --- |
| Singular `activeContextId` | 0 | 0 |
| Flat `laneStates` | 0 | 0 |
| Pre-assignment archived execution candidate | 1 archive | 0 |
| Lane-less worktree context | 0 | 0 |
| Legacy purge ledger | Applied 2026-06-14 16:41:10; no pending marker | Applied 2026-07-10 03:13:07; no pending marker |
| Ref migration 0005 ledger | Applied 2026-07-15 19:18:01 | Applied 2026-07-17 23:19:48 |
| Legacy refs requiring direct conversation/fork decoder arms | 0 | 0 |
| Legacy or superset refs normalized in sidecar snapshots | 0 | 0 |
| Exact ref signatures across all storage (diagnostic only) | 14, all in retired `sessions.workflow_lanes[*].backendState` | 1, in `sessions.workflow_lanes` (diagnostic only) |
| Sidecar snapshot active turn missing `kind` | 20 | 21 |
| Active sidecar debug snapshot missing generation ID | 2 | 0 |
| Backend-keyed collaboration model settings | 2 | 2 |
| Collaboration object snapshot missing `origin` | 21 | 3 |
| Unread inline conversation snapshots / session graph blobs | 0 / 0 | 0 / 0 |
| Delivery-plan v3 attempts / snapshots | 6 / 12 | 1 / 1 |
| Delivery-plan v4 attempts / snapshots | 1 / 1 | 0 / 0 |

Both hosts have zero matches in actual direct ref-decoder and sidecar deep-ref inputs. Their migration 0005 ledgers corroborate removal of those reader branches. Both collaboration probes filter `workflowType = "collaboration"`. On this Mac all 21 envelopes are collaboration envelopes, so adding that filter preserves the counts. Snapshot probes read only `conversation_machine_snapshots`; the conversation repositories exclude the old inline `machine_snapshot` columns. The 14 diagnostic refs are in `backendState`, which the current lane schema does not consume; they do not justify retaining `session-ref-codec.ts` legacy arms. Its actual direct decoder and deep snapshot inputs have zero matches on this Mac.

Migration 0039 is recorded on both hosts, but it writes v3 documents itself. Its ledger entry does **not** establish the absence of v3 readers' input. These observed counts supersede that assertion in the ticket.

V3 delivery-plan readers remain necessary even after the second-host audit: v4 derives claims from authored `acceptanceCriteria[].covers`, while v3 claims name contexts without identifying which acceptance criterion provides coverage. A syntactic conversion changes signed candidate bytes/hashes but cannot infer the missing authored coverage. The existing `coverageUpgradeRefusal()` and the behavior test in `src/lib/specs/delivery-plan-service.test.ts` ("requires an unlaunched v3 ... to reopen into v4 while preserving candidate history") require reopening, clearing current approval/prelaunch, and fresh sign-off while preserving historical candidate bytes. Keeping this reader preserves that contract; this cleanup does not rewrite signed snapshot identities or manufacture coverage.

Migration 0051 preserves unknown fields and timestamps, runs in one immediate transaction before actor recovery, and is replay-safe. It persists missing active-turn discriminators, debug generation IDs, collaboration origins and backend-keyed model settings. The current collaboration writer now writes its origin explicitly. The Mac’s one pre-assignment archive also required conversion of its nested collaboration second-agent tuple; the frozen transform preserves its model and effort, and the canonical repository can read the result.

A private SQLite backup of the Mac database was migrated and replayed without changing the live source. [mac-migration-dry-run.json](mac-migration-dry-run.json) records readable archive recovery and byte-identical replay; [mac-shapes-after-migration.json](mac-shapes-after-migration.json) repeats the SQL against that backup: archive candidates, missing active-turn kinds, missing debug generations, backend-keyed settings and missing origins are all zero. The Linux input is Alex’s supplied read-only audit; no Linux migration was run in this session.

Current session-isolated contexts still use a null lane before landing materializes their session lane. Those `context-landing.ts` branches are retained because a current production integration test exercises them. Lane-less worktree resolver, scheduling, readiness, fan-in landing, retry and cleanup paths are removed. Current lane commits and join retries are preserved. Historical landing intent tags and the persisted `pendingMergeRetry` field remain readable for historical row serialization; the latter’s producer and consumer are gone.

## Validation

Behavioral changes used observed assertion-level failing tests before implementation. Port injection and Windows-only branch deletion are wiring/removal changes; existing behavior coverage validates them. Final registered checks after item 1:

- Typecheck (full): `vrun-e7693984-913b-4d25-8be2-dda288e421be` passed.
- Lint (changed): `vrun-1cdf3107-5506-4c83-b286-828a6e2dd752` passed.
- Seams (full): `vrun-652e7605-77a8-4101-96ea-dd6986d191fd` passed.
- Format: `vrun-efa617b9-00ec-45f8-8522-ed9f241facdc` passed.
- Changed-scope tests: `vrun-ec68fa2a-4e9d-4dee-a3e4-1023bf16fe0a` passed. The registered wrapper expanded this to the full suite because the test-profile inventory changed.

The separate-module-graph pause/resume regression loads overlapping module imports sequentially after each reset, preserving independent route graphs and all assertions at the original 15-second timeout. Concurrent imports deadlocked the test loader; the focused check passed (`vrun-65772e59-1d32-4b4a-9564-9ea53f85c520`) before the full gate.

Focused checkpoints also cover the real child-process worker teardown, Claude/Cursor runtime and task wiring, checkpoint persistence, delivery gates, merge association/delivery, CLI identity, and ticket relationships. Five backend behavior changes and the env identity change have observed assertion-level red/green receipts.

Live verification against the worktree's isolated `.config` instance passed; [live-verification.json](live-verification.json) records scenarios, evidence paths, limits and cleanup. A real Claude turn received its own caller identity with retired capability variables empty. The published CLI completed the current handshake, maintained caller identity independently of target flags, persisted a relationship through API/SQLite readback, refused the retired attachment alias, and received event-page envelopes with and without explicit pagination parameters. Fixtures were removed and the dev instance was stopped.

Live limits: Codex/Cursor provider calls were not exercised; events were empty; no workflow execution or final merge was launched. Worker IPC/teardown and spec/merge delivery behavior were covered by registered tests.

Visual verification passed for `OneOffExecution` at desktop and 900px with the inspector expanded: Inline plan and plan-name labels, no source-definition link, no null labels or overlap. The existing `BugReporterExecution` retained its source link. Screenshot: `.cc/temp/one-off-desktop.png`; the browser and Storybook were stopped afterward.

Migration 0050 also passed a real file-backed SQLite regression (`vrun-3782140d-3ed4-421b-b578-e1deb542da30`): barrier 18 exists before row updates, future SQLite/filesystem schema versions refuse writes, and replay remains idempotent. The regression was confirmed red before wiring the established barrier and transaction compatibility checks. Typecheck/lint receipts above include this correction.
