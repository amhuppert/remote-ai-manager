# Checkpoint compaction production review

Candidate base revision: `77771844328f44f6a3e738d93a5f9793c5bb4ec0`, plus the release-verification working diff. Workflow baseline: `154e8a46422d60d6acc54814d44e8f589543a456`. Native candidate `67da08cf-e13f-46ab-8f16-43e5348f4e78`, pinned revision `ebb3d57c-9b7a-4348-af35-1c585640391d`.

Scope: ticket 129 items 1–2, production reachability and bounded remediation. Browser/agent journeys and full release gates are separate pending tasks; this document does not claim them.

## Governing sources

The pinned full native spec and release excerpt (charter source entries 11–12) govern requirements. The delivery contract (entry 16) governs isolation and verification. The implementation plan P8 (entry 18) governs packaging. The older UI evidence document incorrectly says outline/range HTTP destinations do not exist; the current scoped `/read` routes and `CheckpointEvidence.ArchiveRange` are the authority for implemented behavior. The probe document's enablement verdict is checked against actual artifacts and descriptors below.

## Production consumers

The following inventory was taken at the candidate base; line numbers are base-revision coordinates. The remediation section describes the final wiring where this table identified a gap.

| Area | Production links and observations |
| --- | --- |
| Storage and upgrade | `src/lib/state-store/state-db.ts:164` sets schema compatibility 15. `migrations/0044-add-conversation-checkpoints.ts:39` publishes the barrier, reapplies the shared IF NOT EXISTS DDL and records version 15 transactionally; `migrations/index.ts` registers it. `state-db.ts:2353` owns immutable payload table, FK cascade, and update-refusal trigger (`:2381`). Parent deletion triggers at `:2395`/`:2402` delete scoped operations for session/project conversation deletion, including parent FK cascades; payload deletion follows FK cascade. Archive updates do not invoke DELETE triggers. |
| Canonical repository | `src/lib/state-store/store.ts:567` builds the continuation gateway over the live cached conversation repos. `src/lib/conversation-checkpoints/service-factory.ts:32` composes one singleton repository over that gateway and write queue, wrapped with publication. `continuation.ts:90` dispatches clearBackendRef to the proper scope. `repo.ts:1044` commits readiness plus the reference clear in one transaction. |
| Admission and generation | Both scoped route handlers call the manager through `route-handlers.ts:94` and `:293`. `manager.ts:2140` reserves synchronously before its first await (`:2216`), reuses UUIDs, enforces shared eligibility, settles receipts before capture, rechecks hosted state, admits durably (`:2313`) then calls owned maintenance (`:2357`). `production.ts:490` supplies the real repository, transcript reader, compaction configuration, ordinary task executor, background registry and generator. |
| Retirement | `checkpoint-maintenance.ts:451` freezes immutable payload under a recapture/lifecycle fence, then closes the manager-owned runtime (`:486`). The host delegates to `closeHostedRuntime` (`manager.ts:2510`), retaining existing ownership of close/drain work. Readiness commits at `checkpoint-maintenance.ts:501`; required host receipts settle at `:527`. See readiness publication gap below. |
| Hydration and recovery | `production.ts:318` composes `hydrateCheckpointAuthority` over the same repository, and both actor input loading and startup rehydration consume it (`:363`, `:459`; `rehydration.ts:416`, `:519`). `actor-input-loader.ts:193` reads authority before constructing actor input. `rehydration.ts:157` overlays checkpoint authority and row-owned retired continuation over stale snapshots; `persisted-snapshot-codec.ts:95` excludes checkpoint projection from snapshot authority. `checkpoint-restart.ts:198` completes interrupted retirement from durable payload; generation interruption fails before drain. |
| Seed delivery and queue acceptance | `pre-turn/continuation-seed.ts:59` chooses a ready checkpoint ahead of fork continuity and suppresses prior fork seeding after acceptance. `turn-context.ts:63` places exact frozen seed before current context/user text; full memory redelivery consumes `runtimeCreatedWithoutResume` at `:206`. `actor-implementations.ts:1387` binds operation/seed to attempt and exact assembled/submitted fingerprints before provider dispatch (`:1410`). Neutral input acceptance and backend init call the prepared context (`:1200`, `:1211`); `pre-turn/checkpoint-seed.ts:195` requires both facts in either order before recording acceptance. `checkpoint-queue-repair.ts:76` repairs only correlated queued receipts; production startup and manager queue reads consume it (`production.ts:367`; `manager.ts:1694`). |
| HTTP and event publication | Session and project `checkpoints` route files export the scoped shells from `route-handlers.ts:591`–`:614`; mutation handlers invoke manager APIs, returning 202 after admitted receipt (`:293`–`:317`). History entry/image route shells exist for both scopes (`history-route-handlers.ts:347`–`:350`) and call shared full-entry/image readers. `service-factory.ts:34` decorates every writer; `publication.ts:100` rereads public receipts after durable writes; `events.ts:27` defines a strict scoped receipt event. `NotificationListener.tsx:124` installs reactions and `events/sse-reconnect.ts:100` invalidates checkpoint GET queries after reconnect. |
| CLI/help/disclosure | `src/cli/commands/conversation.ts:160`, `:172`–`:174` dispatch compact-context, checkpoint, entry, image. `conversation/checkpoint.ts:299` resolves mutation identity, then directly POSTs at `:316`; cancel/reconcile also use direct scoped transport. Read-only operations use `withScopeResolution` (`:709`); `conversation/target.ts` is the shared target owner. `help-registry.ts:235` registers checkpoint/evidence leaf help from `conversation/checkpoint.help.ts`. Checkpoint responses use receipt/seed disclosure and existing bounded spill mechanisms. Existing `conversation compact` remains the rolling artifact API path (`conversation.ts:473`). See read-boundary text gap below. |
| Session UI | `SessionInfoStrip.tsx:177` derives the actual session target, uses one checkpoint query surface (`:181`), feeds distinct menu action/chip (`:305`, `:321`), and renders saved panel with transcript navigation and rolling artifact comparison (`:344`). `SessionActionsMenu.tsx:240` contains separate checkpoint menu items; artifact generation remains `ArtifactMenuItems`. |
| Project UI | `ProjectCockpit.tsx:743` mounts `ConversationCheckpointControls` with the project target and transcript navigation; `ConversationPane.tsx:154` renders the slot. `ConversationCheckpointControls.tsx:61` uses the same query/mutation surface and panel. Maintenance hold is included in project busy/queue behavior (`ProjectCockpit.tsx:552`) and session submission hook/composer behavior. |
| Evidence navigation | `CheckpointEvidence.tsx:218` implements ArchiveRange: scoped outline with inclusive seq range, all raw entry coordinates within each merged unit, full entry/image navigation and omitted-range continuation. `history-queries.ts:265` builds scoped `/read` URLs; existing session/project `/read/route.ts` exports reach `read-route-handlers.ts`. `CheckpointEvidence.tsx:443` renders saved boundary, and `:491` distinguishes a rolling artifact covering later history. This exists in current code despite older UI artifact wording saying outline HTTP destinations were unavailable. |
| Backend capability gates | `production.ts:538` obtains `conversationCapabilitiesForBackend(...).checkpoint`; catalog and registry schemas carry that boolean. `claude/descriptor.ts:87` enables checkpoint with certification rationale. `codex/descriptor.ts:102` and `cursor/descriptor.ts:95` stay false. Parent independently reviews real certification evidence. |


## Remediation delivered in this review

- **Saved history boundaries:** Both scoped `/read` handlers now load receipt pages through the canonical checkpoint repository, derive boundaries only for frozen payloads, and supply them to the existing range projection. Real SQLite route tests place ten saved checkpoints behind 101 cancelled builds, verify pagination, keep the newest eight in-range boundaries, preserve all four logical messages, and exclude wrong-scope metadata, seed bodies and provider references. Plain CLI and Markdown reads render the same coordinates, omission count and checkpoint-list continuation command as JSON.
- **Readiness durability:** Maintenance and hosted reconcile now settle the projected row and snapshot before committing durable ready. Tests compose the real manager/repository/publication decorator and hold snapshot persistence: both GET receipts and SSE remain unready in session and project scope, for ordinary start and reconcile. A failed snapshot keeps retirement held; explicit reconcile repairs the failed receipt before publishing ready and draining preserved queued input.
- **Restart authority:** A reconciliation hold gives the current conversation row authority over a stale snapshot, including a hold during retirement. Both-scope restart reproductions confirm that a cleared row cannot reacquire its previous provider reference after the readiness snapshot failed.
- **Style registration:** The ten checkpoint component/story files are registered consistently in the existing utility-first collision guard, ESLint and Prettier configuration. The prior 44 reported collisions were intentional utility usage missing this registration. No component style or legacy CSS rule was changed.

## Independent provider artifact audit

The bounded audit script and results remain under `.cc/temp/audit-checkpoint-probes.py` and `.cc/temp/release-probe-audit.json`. It reopened the cert4 SQLite databases read-only, verified applied rows and exact frozen seed hashes/bytes, compared protected references with public digests, checked mode 0600, verified no raw references in ordinary logs, and compared retained image bytes. The original corpus text supplies the expected constraint, identifier, rejected library, superseded bucket, blocker and next action; the actual chart displays p99 **812 ms**. Claude answer excerpts were also matched to its recorded assistant transcript, accounting for the report's labeled excerpt limit.

| Backend | Scope | Independently graded outcomes | Frozen seed bytes, cycles 1/2/3 | Enabled |
| --- | --- | --- | --- | --- |
| Claude | Session | 9/9 | 8381 / 8475 / 10608 | Yes |
| Claude | Project | 9/9 | 8823 / 8940 / 10148 | Yes |
| Codex | Session | 8/9: export-job identifier missed | 7051 / 8086 / 10763 | No |
| Codex | Project | 9/9 | 8350 / 8759 / 10231 | No |

Each report records three distinct fresh accepted continuations, one accepted seed event per cycle, later seed omission, and a cycle-two queued case. The audit corroborates durable acceptance/hash evidence; the probe harness supplies the live event-order and no-resume observations. This review made no provider request and does not replace the production browser journey. Cursor remains unsupported and unprobed. Codex's failed quality outcome is retained, not retried to select a passing sample.

Protected evidence: `.cc/temp/checkpoint-probes/<backend>/cert4-<scope>/evidence/protected-evidence.json`. Public companion: `public-report.json` in the same directory, with SHA-256 recorded in the audit result. Compaction call cost remains unavailable; ordinary Claude cost is provider-reported and Codex cost is CC-estimated. Full per-call provenance and the 12 ordinary/6 compaction call ceiling are in the provider evidence document.

## Charter invariant checks

- `archive-is-evidence`: The workflow diff adds no transcript rewrite or image deletion to checkpoint/history consumers. Real stored boundary tests preserve logical-message counts and coordinates; cert4 archive/image checks and the independent image hash comparison preserve original evidence. The readiness change touches lifecycle ordering only.
- `public-receipts-only`: The read path consumes receipt metadata and projects only operation IDs, ordinals and source coordinates. Route assertions exclude frozen seed text and provider references; the provider audit confirms public digest/protected-reference separation and log redaction.
- `single-lifecycle-owner`: The only production checkpoint start consumer remains the explicit scoped HTTP mutation entering the conversation manager. Retirement/reconcile still close the manager-owned runtime and await its durable persistence adapter. Searches of the workflow diff found no automatic trigger, second scheduler, native manual compaction endpoint, or raw provider frames introduced in feature/manager/API/CLI layers.
- `backend-evidence-gate`: The actual descriptors read Claude `checkpoint: true`, Codex and Cursor `false`; the independent cert4 audit supports only the enabled Claude verdict. No capability or provider setting changed in this review.

The schema diff from baseline has no added DROP/TRUNCATE/reset. Its only deletion additions are owning-conversation cleanup triggers and the checkpoint payload cascade. The preserving compatibility migration remains registered. No provider SDK upgrade, automatic checkpoint, lane-rotation change or ticket items 3/5/7 were introduced.

## Verification

Settled registered checks and regression run IDs are recorded below. All test runs use `--require-match --json`; failures below are intentional reproductions or the stated expectation updates, not waived gates.

| Check | Verdict | Run ID | Matched files |
| --- | --- | --- | --- |
| Tailwind reproduction | failed | `vrun-130285cc-786b-476a-9197-4a1049a5a05c` | — |
| Tailwind registration | passed | `vrun-df9315ed-7451-4943-9a93-38e5b2b602b4` | 1 |
| Scoped boundary reproduction | failed | `vrun-7d21386c-4a63-42a6-af9e-4e914cdb9214` | — |
| CLI boundary reproduction | failed | `vrun-c59318a6-ffaa-4108-b24e-dbea2356f2d3` | — |
| CLI boundary fix | passed | `vrun-e6e85887-6b07-4062-a120-0c40d314efc1` | 1 |
| Markdown boundary reproduction | failed | `vrun-1c44f584-1b0c-4f06-801b-63b580af2826` | — |
| Scoped and Markdown boundary fix | passed | `vrun-a06b9fd3-0a1d-4105-922b-2ddff19e355b` | 1 |
| Premature readiness reproduction | failed | `vrun-95f0eeea-5d7a-411a-a608-166dfea05215` | — |
| Readiness and receipt repair | passed | `vrun-3fbfdbad-e838-4a83-83f5-5f9a46e0622c` | 1 |
| Stale-reference restart reproduction | failed | `vrun-b4305ae4-bfac-4d39-85a6-9e0349a671d3` | — |
| Both-scope restart fix | passed | `vrun-de67b1ef-61db-4c5e-9e82-56c076e54807` | 1 |
| Recovery expectation alignment | passed | `vrun-0a0bbd34-4da2-48fd-9f7d-4b52a0dfb360` | 1 |
| Format | passed | `vrun-1b3407c8-98b8-44c5-97f7-a6bad0b5367f` | — |
| Lint | passed | `vrun-778939bb-5262-4585-bcd8-5fd134011fe9` | — |
| Typecheck | passed | `vrun-c24665b6-b44d-461a-89e8-9ccb9e46de70` | — |
| Seams | passed | `vrun-df0b5244-e3de-42b5-bee0-60898e6db7d3` | — |
| Integrated lifecycle/history/CLI regressions | passed | `vrun-6d2892cb-464f-4465-a415-0637ac05301a` | 11 |

The first integrated run (`vrun-a700db79-f99e-40da-9aa0-4b1fc122f3f9`) stopped on two recovery tests that expected ready to have committed before failed snapshot persistence. Their assertions now require the held retirement phase and unchanged durable hold; the subsequent single-file and 11-file runs passed. These failures follow the intentional durability-order correction and are not attributed to the baseline. The baseline's two full-suite timeout failures remain documented in `baseline.md`; the final full suite is still required and no check has been waived.
