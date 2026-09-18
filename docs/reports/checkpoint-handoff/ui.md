# Optional checkpoint handoff UI verification

Verified 2026-09-18 in the ui-controls worktree. This report covers UI and command-surface behavior; four-cell backend certification remains with live-claude/live-codex and release-verification.

## Identity and evidence boundaries

- HEAD: `5e2d30b786dde4ef81b75c458763a0cfffb3e438`, with this context's uncommitted UI changes served by hot reload.
- `cctl dev ensure nextjs`: `http://localhost:3003`; dev doctor authenticated build `5e2d30b78-2026-09-18T09:08:22.323Z` and the exact `.handoff` worktree/config directory. Managing instance remains port 3000; no live state was written there.
- `cctl dev ensure storybook`: `http://localhost:6008`; dev registry resolves the same worktree. Storybook has no CC handshake API, so `dev doctor storybook` returns HTTP 404; it is not a token/build-authentication claim. Newly added stories were rendered directly.
- Session was created with `cctl fixture session create plc-test-lab --dev nextjs`; project conversation was created through an authenticated production POST using the worktree instance's token. No database rows, approvals or attestations were manufactured.
- JSON files beside this report are public receipt GET snapshots. Only the potentially long `entryIds` arrays are replaced by `entryCount`; all other receipt fields are retained. Full responses remain in `.cc/temp/handoff-ui-*-receipts.json`.

## Production journeys

Session route: `http://localhost:3003/conversations?c=c4793979-c4b2-43b9-af8a-05b52b1f4660` (`plc-test-lab/handoff-ui-check`).

1. A real ordinary Claude turn recorded `UI-HANDOFF-947` and returned `ACK-947`.
2. Actions → Compact with agent handoff opened preparation without submission. It disclosed `claude · opus`, tool-disabled mode, one extra call, 60 seconds, 8192 added-input bytes and 6144 accepted-output bytes, with baseline alternative and honest cost/source-context limits.
3. Capture handoff and compact admitted operation `c0b7362e-7f20-4172-a0f7-7080be9bdebe`. UI showed capture progress and separate skip/cancel controls. Panel close/reopen sent no stop; the operation continued.
4. Authoritative GET reached `ready`, handoff `included`, mode established, execution settled. Actual counts: plan 3, next step 1, other categories 0. Capture was 1318 bytes; final checkpoint 4282 bytes. Activity reported complete transport and unavailable native coverage. Capture cost was provider-reported $0.187165, separately from generation. These are receipt facts, not independent mechanical tool-suppression certification.
5. Expanded advisory audit, outlined original seq 5–213, scrolled the 209-entry capture range to the last seq 213 and opened its complete entry. Original coordinate links remained usable. Opened retained fork form without creating a fork or sending model input.
6. Reloaded page, reopened checkpoint, and recovered included receipt. Toggled browser offline then online; observed a new checkpoint GET and retained included receipt. Keyboard Escape from Close returned focus to the checkpoint chip (`title=View context checkpoint`) with no remaining dialog.

Project route: `http://localhost:3003/projects/plc-test-lab?focus=84f86e47-1c86-4474-a98d-adffe40b3945`.

1. Real source turn returned `ACK-948` for `PROJECT-HANDOFF-948`.
2. Project checkpoint menu opened the same preparation and mode disclosure. Capture start, Skip handoff, then Cancel checkpoint were driven through actual buttons.
3. GET recorded operation `19476ff3-31cc-4c16-aea5-7ec94b0378e4` as `cancelled`, handoff omitted/cancelled, `stopIntent=cancel`, `executionSettled=true`. The screenshot named stopping captures submitted intents before the query had advanced; the durable receipt establishes settlement.
4. The direct Compact context now menu item started baseline operation `41b3e315-f7be-4cc1-b52d-d74341afab35` with `handoff=null`; it reached ready. No capture was inferred from the prior opt-in.
5. Opened retained checkpoint fork form, then reloaded and recovered baseline receipt. Inspected ready panel at 390×844: actions and scrollable history remained reachable, no horizontal clipping.

## Screenshot index

All linked images were opened for visual inspection. The modal uses one scrollable body and reachable footer; narrow actions stack and provenance wraps. A real 209-ID capture exposed excessive audit length, corrected by collapsing IDs behind a count and limiting that list's scroll height. This visual disclosure change preserves every ID.

| Production state | Screenshot |
| --- | --- |
| Session preparation | [preparation](screenshots/handoff-session-preparation.png) |
| Session capturing | [capture](screenshots/handoff-session-capture.png) |
| Session included audit | [included](screenshots/handoff-session-included.png) |
| Last original capture entry | [last audit](screenshots/handoff-session-last-audit.png) |
| Session fork form | [fork](screenshots/handoff-session-fork.png) |
| Project preparation | [preparation](screenshots/handoff-project-preparation.png) |
| Project stop intents | [stop intents](screenshots/handoff-project-stopping.png) |
| Project fork form | [fork](screenshots/handoff-project-fork.png) |
| Project baseline ready, narrow | [ready](screenshots/handoff-project-ready-narrow.png) |

Storybook URL prefix: `http://localhost:6008/iframe.html?id=components-checkpointpanel--` (append state and `&viewMode=story`). Fixture evidence is explicitly distinct from production receipts.

| Story state | Inspected screenshot |
| --- | --- |
| prepare-tool-disabled | [Claude preparation](screenshots/handoff-story-prepare-tool-disabled-expanded.png) |
| prepare-instruction-only | [Codex narrow preparation](screenshots/handoff-story-prepare-instruction-only-narrow.png) |
| capture-unavailable | [unavailable](screenshots/handoff-story-capture-unavailable.png) |
| capturing-handoff | [capturing](screenshots/handoff-story-capturing-handoff.png) |
| stopping-handoff | [stopping narrow](screenshots/handoff-story-stopping-handoff-narrow.png) |
| handoff-included | [included expanded](screenshots/handoff-story-handoff-included-expanded.png) |
| handoff-seed-budget-omission | [budget omission expanded](screenshots/handoff-story-handoff-seed-budget-omission-expanded.png) |
| capture-cleanup-hold | [cleanup narrow](screenshots/handoff-story-capture-cleanup-hold-narrow.png) |
| opened-from-chip | [focus return](screenshots/handoff-story-focus-return.png) |
| repeated-checkpoints | [last history item](screenshots/handoff-story-history-last-narrow.png) |
| Omitted-output original entry | [entry narrow](screenshots/handoff-story-audit-entry-narrow.png) |
| MessageRow maintenance output | [audit transcript](screenshots/handoff-story-handoff-audit-output-narrow.png) |

Storybook verified Skip disabled / Cancel enabled while settling, keyboard activation, advisory category and usage disclosure, explicit cleanup testimony wording, original seq411 entry opening, and focus return. A focused close-button tooltip can consume the first Escape; after tooltip dismissal Escape closes the modal. No production cleanup acknowledgement was submitted.

## CLI parity

Used the dev-published `.config/bin/cctl` with the dev instance URL/token, never the ambient prebuilt CLI as feature evidence. `conversation checkpoint check` reported the actual ready operation blocking a second start, including the same capability/receipt fields. `checkpoint get` began `Handoff included; mode=tool-disabled; established=true` and retained canonical counts, source coverage and usage. New `skip-handoff --help` is present. Raw evidence: `.cc/temp/handoff-cli-check.json`, `handoff-cli-receipt.txt`, `handoff-cli-help.txt`. Check's blocked result is expected, not a validation success claim.

## Validation and limits

Seven-file component/hook/state regression: `vrun-f98c38ef-871e-4d24-8466-ac113ca42c34` (7 matched). GET-only capture archive integration: `vrun-c2a87f6e-9c05-4807-81d8-ee3e5ded21f6`. Cleanup testimony separation: `vrun-0faa9c39-0d5e-4155-91b9-bec61ec97e73`. Audit after collapsed IDs: `vrun-09c78778-33a0-4b49-a689-43339425dc04` (1 matched). Tests cover mode defaults/binding, unavailable fallback, skip/cancel, remount/query behavior, null counters and legacy checkpoints without style assertions.

Untaken live branches: Codex provider capture, forced seed-budget omission, interrupted-process cleanup acknowledgement, actual fork creation/first delivery, queued-message acceptance, and byte-level image verification. Their UI states were exercised in Storybook where described; backend certification and baseline delivery/fork integration retain their declared owners. This context does not claim fixture output proves provider behavior or a user attestation proves CC-observed cleanup.


## Long history and cleanup

`http://localhost:6008/iframe.html?id=components-checkpointfork--long-history-last-checkpoint&viewMode=story` exercised 30 loaded receipts at 1280×960 and 390×844. Keyboard selection of the last #1 row opened the #1 / seq10 fork form, with an explicit story identity assertion. [Oldest row](screenshots/handoff-story-long-history-last-narrow.png), [desktop fork](screenshots/handoff-story-long-history-fork-desktop.png), [narrow fork](screenshots/handoff-story-long-history-fork-narrow.png). All were opened and inspected; no horizontal clipping. Together with the actual 209-entry session audit and both production fork forms, this covers last-item reachability without generating unnecessary provider checkpoints.

Disposable session deletion returned `worktreeRemoved=true`; project conversation was archived through its production PATCH route. Only named verification browser sessions were closed. Captured report artifacts remain; the deleted session route is historical evidence, not a still-live fixture link.

Final full typecheck passed `vrun-867324f0-656d-45f7-aa91-5fc9e1ae69d6`. Final validation receipts below supplement the behavioral regression above.

Final changed lint: `vrun-971adb9b-61e0-4316-826f-20da5bb99dd1`; full seams: `vrun-8d1e16d7-6661-4500-a0ae-1061df50cfca`; format: `vrun-01491b47-d474-4c5a-8c91-f08cddba85bf`. All passed. Final source audit confirms baseline sends `{}`, opt-in forwards only the disclosed mode, capture audit has no mutations, and acknowledgement remains an explicit button behind the unsettled cleanup predicate. Every screenshot link resolves.
