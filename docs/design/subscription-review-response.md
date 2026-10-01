# Subscription review response — October 1, 2026

This follow-up addresses the static review of the subscriptions consolidation on `csm/notifications-7f75af` (also merged as `bc68be7d9`). Review IDs below match `.cc/temp/notifications-review.md`. Earlier migration-review findings are mapped at the end. Production deployment is separate from these worktree changes.

## Accepted fixes

| Finding | Disposition and remedy |
| --- | --- |
| A1 — system actors stall spec follows | **Accept.** Durable spec events legitimately carry a system actor. The source reader accepts it without inventing a conversation author, advances its cursor, and continues to later events. |
| A2 — ordinary opens perform the v27 cutover | **Accept.** Existing-database evidence rebuilds and compatibility barriers belong to ordered startup migrations. Plain opens of v23/v25 retain their prior version and constraints; fresh databases still get current DDL. The wait-generation change follows the same ordered-only rule. |
| A3 — waits suppress all workflow notices and cannot re-arm | **Accept.** A finite wait reserves its terminal delivery, not the whole workflow source. Passive workflow boundaries continue alongside the wait. Explicit re-arm creates a new wait generation; only a consumed resumable boundary becomes its baseline. Consumed final outcomes are refused and undelivered outcomes remain obtainable. |
| A4 — invalid notepad comment command | **Accept.** Both source notices and injected notepad context use `cctl notepad comment list --status=open`. |
| A5 — legacy automatic validation backlog | **Accept.** Ordered migration 0064 retires the exact legacy automatic passive validation follows with no wait attached, preventing their backlog from entering further briefings while preserving inbox evidence. Explicit waits and delivery evidence are preserved. Cleanup runs after the old producer is stopped at deployment, not by editing the running production database. |
| B1 — lost background tasks miss role/generated turns | **Accept.** A narrow internal operation records own-conversation runtime loss in the durable inbox for every durable role. The next newly created runtime receives bounded, quoted recovery instructions even on generated turns; ordinary feedback controls and eligibility stay separate. Retirement finishes before the recovery snapshot is claimed, so task losses reported during close are included. A real input acknowledgement owns acceptance, and an unaccepted replacement is closed so warmed runtimes cannot hide the pending recovery context. Authenticated lane/role callers may read their exact own recovery receipt; general subscriptions and inbox history remain ordinary-only. |
| B2 — failed wakes block human input and expose transport payloads | **Accept.** Composer and server admission use the wake-aware ordinary-input predicate. Queued/review wake UI uses structured presentation, with no raw subscription transport payload. |
| B3 — pending/attention states cannot be cleared | **Accept.** Inbox review controls and count predicates distinguish outstanding actionable delivery from history. Wake-linked ambiguity remains guarded by queue evidence rather than a blind retry. |
| B7 — nonexistent sources are accepted | **Accept.** Source validation precedes create/refollow writes; a missing or inaccessible source is refused instead of creating a permanently broken follow. |
| B8 — active wait updates misreport success or reject retained expiry | **Accept.** Existing wait controls retain their actual expiry, and paused/passive waits cannot report an active wake registration as successful without becoming active. |
| B9 — ticket start lacks status provenance | **Accept.** Linking a started session records the actual transition to in-progress in the same transaction. A repeated in-progress value creates no new transition. |
| C1 — ready waits can be stranded | **Accept.** Wait reconciliation accounts for the linked receipt state instead of assuming every ready row can be batched. |
| C2 — held wakes repeatedly touch activity | **Accept.** Queue drain can observe an existing actor without treating an inspection as fresh conversation activity. |
| C3 — resulting-turn links are not reactive | **Accept.** Conversation navigation responds to search-parameter changes, including a link to a turn in the currently open conversation. |
| C4 — list offsets become invalid | **Accept.** Filter/clear changes reset paging and shrinking result sets clamp the visible page. |
| C6 — context receipt failures hide accepted input | **Accept.** Once runtime acceptance is proven, archive the supplied input before required context receipts can fail. Failed receipt persistence retains queue ownership/uncertainty and can repair the receipt without another dispatch; it cannot erase the accepted input from the transcript. |
| C7 — git job times and retrieval handles | **Accept-reduced.** Passive and active job facts share UTC normalization and retain the job result as inbox evidence. The existing inbox commands and exact rendered detail handle replace a non-executable `git-job:` marker; no new job CLI family is needed. |
| C9 — cancelling is indistinguishable from unfollowing | **Accept.** Cancelling the finite wait stops that wake; unfollow remains the explicit opt-out from source awareness. |
| C10 — explicit refollow replays the opt-out period | **Accept.** Refollow starts from the current source baseline while preserving existing delivery history for inspection. |
| C11 — an oversized quoted line starves forever | **Accept.** Rendering bounds the actual escaped line and substitutes an exact inbox detail command. Full evidence remains in the saved receipt; acceptance records the metadata actually supplied. |
| C12 — small control and presentation defects | **Accept.** Source-kind changes clear incompatible identifiers, wake labels distinguish failed/uncertain states, pending links preserve filters, and narrow-screen inspection responds to the selected item. |
| C13 — obsolete workflow claim APIs | **Accept.** Remove unused claim/settle/release/recover setters and repository helpers now that inbox receipts own agent delivery. Lifecycle-effect and missing-origin fallback receipts remain. |

## Smaller remedies and boundaries

| Finding | Disposition and reason |
| --- | --- |
| B4 — sweep isolation and unbounded work | **Accept-reduced.** Isolate failed recipients/stages, avoid rediscovering historical involvement every five seconds, and remove full notepad revision-content scans. Ordinary user input must not fail because an advisory reconciliation failed. Required acceptance writes retain their own failure handling. No new scheduling subsystem is warranted by the measured workload. |
| B5 — duplicated full notepad revisions | **Accept-reduced.** Read the latest revision metadata when the head changes and coalesce unseen revision history. Documents remain in the canonical revision store. Saved comment feedback remains evidence; there is no indiscriminate pruning of user-authored feedback or accepted receipts. |
| B6 — first sync replays history | **Accept-reduced.** Newly discovered spec/ticket follows baseline at the current head. Workflow discovery preserves only an outstanding launcher-result obligation as its initial cursor; a canonical accepted/superseded receipt does not become new work. Exact accepted notepad references remain authoritative baselines. Existing inbox evidence is retained for review rather than silently deleted. |
| B10 — overview reads and SSE invalidation fan out | **Accept-reduced.** Select the addressed owners before reading receipt/wait evidence, bypass global owner scans for conversation badges, and narrow SSE invalidation to the changed recipient/source. Global overview still scales with its actual scope. A generalized indexed owner catalog is deferred absent evidence that the remaining global read is a bottleneck. |
| C5 — legacy comment boundary and reopening | **Accept-reduced.** A later comment no longer re-announces the comment at the legacy timestamp. Aggregate legacy markers cannot identify which equal-time comment was seen; once reconciled, exact IDs govern future additions. Reopening an already-known comment remains a status change, not a new comment occurrence; expanding the event catalog to reopen/reply notices is a separate product decision. |
| C8 — malformed historical rows fail closed | **Accept-reduced.** Retain transactional fail-closed migration behavior and improve row-specific diagnostics. No corrupt row was demonstrated. Skipping unreadable evidence or foreign-key orphans would silently discard durability guarantees; automatic lossy repair is rejected. |

## Earlier migration review

- Finding 1 is A2. Plain-open tests pin the absence of a compatibility barrier and destructive rebuild on older supported shapes.
- Finding 2 is C8. The original non-atomic rebuild suspicion was refuted; keep the transaction boundary.
- Finding 3 is **accept-reduced**: a fallback-settled legacy row with no runtime attempt cannot replace an existing canonical pending inbox receipt with `uncertain`. Enrich its evidence while preserving the existing receipt. Deleted origins remain skipped.
- Finding 4 is C5.

## Complexity assessment

The main new mechanism is a generation for explicitly re-armed finite waits. Other remedies use existing source cursors, queue admission, inbox receipts, query scopes and ordered migrations. They remove database-open cutovers, duplicated document snapshots, duplicate involvement scans and retired workflow claim APIs. One further simplification candidate is sharing ordinary-input admission predicates across every queue UI/server caller so future queue kinds cannot diverge again; the present fix reuses the existing predicate rather than inventing another one.

## Verification

Focused regressions were reproduced before their fixes. Representative durable and integration checks include:

| Coverage | Passed validation run |
| --- | --- |
| Plain opens preserve older schema shapes | `vrun-c7855507-a192-4f80-bdd5-a40fd20903e1` |
| Exact legacy automatic validation cleanup | `vrun-01acc944-0da8-4859-bbf1-ce221c5e7669` |
| Wait generation migration and evidence preservation | `vrun-22a3f369-cb09-4186-ba26-061e8befd937` |
| Session/project workflow awareness during and after a wait | `vrun-78a22463-10e5-4c26-8d2b-39a5f10d8b72` |
| System spec actors and normalized git-job facts | `vrun-02531b4f-d4e3-4581-acd6-5bf0afc9e6fb` |
| Notepad metadata, comment boundary, retrieval flag | `vrun-8aec90b0-7775-4430-858e-af806b22c0a3` |
| Captured content persists while its notice contains revision metadata | `vrun-df98d9c2-1123-4a9f-8dce-038233b1d93b` |
| Passive reconciliation isolation and oversized briefing | `vrun-84db8800-2246-442a-9161-c3d1019db142` |
| Owed launcher results without historical replay | `vrun-de266440-a4be-4d11-abeb-947f6e81703b` |
| Ticket-start status durability | `vrun-dc37fc04-70df-40be-86fe-576e29e7ca9a` |
| Runtime recovery across roles/scopes, retirement and failure paths | `vrun-11053aca-e73a-4da6-b092-9d350264a9de` |
| Narrow authenticated recovery detail route | `vrun-df0d7c55-488e-439d-aefd-5bba4581e1b3` |
| Queue input archive survives required receipt failure | `vrun-900aa448-4ffc-48aa-8299-70da1bd2159a` |
| Lifecycle receipt failure preserves accepted input | `vrun-0a4f0c67-30ef-4bef-a12a-b6d4266c387d` |

Live checks use only this worktree's isolated dev datastore. Real Codex turns in both a session conversation and a project conversation received one notepad revision and one comment. The document was 100 KB; the revision inbox fact was 959 bytes and contained metadata rather than document content. The comment notice carried `--status=open`, and that exact CLI command succeeded. A CLI request to subscribe to a nonexistent notepad failed with a source-not-found error instead of creating a follow.

After stopping and restarting the dev server, ordered startup reached schema 28. Both conversations received another real Codex turn and reported no new subscription briefing. All four original receipts retained one acceptance attempt and their prior acceptance timestamp. Evidence: `.cc/temp/review-live-restart-evidence.json`, `.cc/temp/review-live-*-passive.sse`, `.cc/temp/review-live-*-restart.sse`, `.cc/temp/review-live-comment-cli.txt` and `.cc/temp/review-live-missing-cli.json`.

Desktop (1440×900) and mobile (390×844) browser checks showed structured wake receipts with no raw XML/JSON payload. A real GPT-6 Sol turn returned `HUMAN_SEND_REMAINS_AVAILABLE` while the earlier wake stayed failed in durable queue state. Dismissing an unrelated uncertain passive receipt changed it to superseded without fabricating acceptance. Opening a resulting turn in the same conversation moved immediately from transcript position 21 to 5. Source-kind changes cleared incompatible IDs; the mobile form and inbox had no horizontal overflow. Evidence: `.cc/temp/review-ui-evidence.json` and `review-ui-*.png`.

All scratch UI rows and the queued fixture wake were removed, the scratch session/worktree and notepad were deleted, the project conversation was archived, and the isolated dev server was stopped. Production data and the production server were not changed.

Registered full typecheck passed (`vrun-90a781de-4e37-48b4-80b8-9159e9e4a8c9`), as did lint (`vrun-0bc2a50f-c3f2-448b-b0de-9ecb1da4ab65`), architecture seams (`vrun-66e93cab-e690-434a-bf0a-2fc2464f3580`) and formatting (`vrun-60935b16-087d-4c0b-822d-6e1858dfdaad`). The typecheck required regenerating malformed local Next route artifacts after stopping the dev server; no compiler or route checks were disabled. Broad changed-dependency runs exposed stale fixture expectations for wait causation, runtime recovery, the corrected comment flag, passive feedback and captured-revision evidence, plus a missing navigation hook in an older conversation UI mock. Their focused corrections passed.

The final broad changed-dependency suite passed with `--require-match` (`vrun-83a0cbc3-4a13-4daa-b377-958a1428eefa`). This is the complete selected dependency set, not a separately requested full-repository suite. Independent source-delivery review found no additional concrete regressions. The final diff check was clean, with no snapshot drift or tracked changes to generated Next declarations or TypeScript configuration.


## Re-review dispositions — Sol and Fable, October 1

These dispositions cover Sol message 1 (`3992b5ae-ec48-4367-8b5d-c44a0128ce1b`) and Fable message 13 (`8748ea23-61f3-476b-a830-df2e96cba9e3`). The reports are preserved locally as `.cc/temp/notifications-bug-hunt-followup.md` and `.cc/temp/notifications-rereview.md`.

| Finding | Disposition and reason |
| --- | --- |
| Sol 1 / Fable N2 — historical finite waits suppress passive results | **Accept.** Only a live wait that owns terminal ingestion reserves the finite source. Cancellation and an expiry outcome release passive collection. Receipt identity is shared by passive and active delivery, so restoring collection cannot manufacture a second occurrence. |
| Sol 2 — imported task-loss reminders miss operational recovery | **Accept-reduced.** Migration 0061 recognizes the exact former producer template within own-conversation notices and preserves its imported occurrence identity, text and receipt while selecting the operational recovery route. Data-only migration 0066 repairs already-imported matching rows. Arbitrary feedback that merely mentions background tasks remains ordinary feedback. |
| Sol 3 — migration follows replay an old halt after accepted completion | **Accept-reduced.** New 0063 imports baseline automatic follows at the event head and import actual outstanding ledger obligations directly. Migration 0066 advances only untouched deterministic cutover follows to a boundary proven by an original import. The original full cutover head was not recorded, so the repair cannot safely reconstruct it; explicit or subsequently changed follows and already-projected evidence are retained. Later unread boundaries must remain deliverable. |
| Sol 4 — recipient paging submits the form | **Accept.** Both pager buttons explicitly use `type="button"`. The production form regression and desktop/mobile browser checks distinguish paging from deliberate submission. Expired passive follows also render as expired in history; a settled wait is labelled delivered only with matching accepted-batch evidence. |
| Sol 5 — historical handles return the latest wait | **Accept.** `wait-get --wait-id` selects an exact generation under the existing recipient and subscription scope. Wait outlines and wake detail handles include the selector; omitting it deliberately retrieves the latest generation. |
| Fable N1 — final-source re-arm can only expire | **Accept.** Although the prior help prescribed baselining, it promised a wake that could never represent new work. Registration now refuses an already consumed immutable terminal result. Only accepted or superseded receipts count as consumed; a merely observed outcome after cancellation/expiry remains obtainable. A consumed halt may establish the baseline only while the canonical workflow lifecycle classifier says it can resume; recovery-error, aborted and reasonless halts cannot promise another outcome. |
| Fable N3 — spent finite waits inflate Following forever | **Accept-reduced.** Consuming or dismissing a validation/git terminal result ends its follow lifetime using the existing expiry field. Active counts exclude expired passive follows; historical waits, receipts and controls remain inspectable. Data-only migration 0067 applies the same rule to existing consumed finite sources and restores a pre-terminal cursor for legacy wait follows that never recorded one. Cancelling a still-running source keeps collection alive until its eventual result is consumed. No new persistent lifecycle status is needed. |
| Fable N4 — main still contains the unsafe pre-fix open | **Accept as deployment constraint.** Worktree fixes do not change a prebuilt server or another checkout. Land the complete correction before any production build/restart; no production deployment or shared-database repair is performed by this task. |
| Residual — briefing reads can block a human turn | **Accept-reduced.** The entire advisory preparation phase is isolated. A preparation failure returns no briefing and releases only this attempt's proven-unsent claims for retry, retaining corrupt evidence for diagnosis. Input-acceptance callbacks remain required writes and are not swallowed by the preparation guard. |
| Residual — reserved wake consumes briefing budget | **Accept.** Exclude actively reserved delivery IDs before passive selection, grouping and omission counts, while retaining the repository's claim guard. Six available passive updates therefore occupy six slots even when a separate terminal wake is pending. |
| Residual — overview and project invalidation remain broad | **Defer further indexing.** The earlier scoped owner selection and recipient invalidation fixes remain. Global reads and source events still have cost proportional to their scope; neither re-review measured a remaining bottleneck. An indexed cross-owner catalog would add maintenance obligations without current evidence. |
| Residual — legacy equal-time comment ambiguity | **Accept existing limitation.** Aggregate legacy watermarks cannot distinguish old and new comment IDs at an identical timestamp. Preserve the documented strict timestamp boundary; after reconciliation exact IDs govern additions. Guessing would trade a possible missed equal-time addition for a confirmed replay. |
| Residual — refollow restores previously pending facts | **Reject as a new defect.** Those facts were already outstanding before the opt-out. Explicit refollow resumes retained obligations while baselining the source to avoid ingesting events from the opt-out interval. Deleting earlier pending evidence implicitly would change the preservation contract. |

Together these remedies add one optional public generation selector and two data-only repairs, reusing existing receipt states, source cursors and follow expiry. They remove permanent suppression, inert active waits, duplicate terminal identities and accidental form submissions. A further simplification candidate is sharing validation fact projection between active and passive readers, as git-job facts already do, to keep metadata as well as occurrence identity aligned.


### Re-review verification

The re-review regressions failed before their respective fixes. Representative passing runs:

| Coverage | Passed validation run |
| --- | --- |
| Finite wait lifecycle through the production runtime and SQLite (10 cases) | `vrun-a269bcf5-e67e-4744-a2ca-e794164cd6ec` |
| Final-source refusal, preserved receipts and historical baselines (28 tests) | `vrun-70f4d4e3-2a13-4b2d-9711-7f298e0dafbd` |
| Workflow resumability uses the canonical lifecycle policy | `vrun-33cbb7fb-4254-4a08-8114-c8df9a3784dd` |
| Exact legacy task-loss import | `vrun-916b83e1-54dc-4410-a75f-c4505c42a16d` |
| Fresh workflow import avoids unrelated historical replay | `vrun-0ec2060a-7e25-409e-9b9a-1d8cc4b5c963` |
| Data-only imported history repair, preservation and rollback | `vrun-ef0fd55b-e885-4aac-9420-3bf8a9105bd1` |
| Finite-source retirement and legacy cursor repair | `vrun-84e957d7-058a-4a67-b620-85a47f939bfb` |
| Scoped historical wait HTTP selector | `vrun-c4a7dde0-04f0-4ee7-9cc0-e2f0a5a3cdf6` |
| CLI generation handles and lifetime disclosure | `vrun-27b268af-0f88-4fdb-97a4-7dd52f148437` |
| Advisory preparation failures and reserved briefing budget | `vrun-e0b5d683-d718-456e-a320-5b7ec2844723` |
| Recipient paging does not submit the production form | `vrun-6cbc697b-292b-4e61-ae3c-af11eedd45b2` |

Independent review of 0061/0063/0066 found no additional concrete defects and confirmed the repair's stated historical-information limit. Review of the root changes caught the status-only resumability mistake; recorded-boundary and fallback regressions then reproduced and verified its correction with the existing lifecycle classifier.


Live API verification used only the isolated dev datastore. The first probe exposed a stale retained service singleton, so the dev server was restarted before assessing current behavior. Fresh startup applied both 0066 and 0067. Historical HTTP and branch CLI reads selected the exact old generation; cancelling a running validation still allowed one canonical terminal occurrence to enter passive briefing; consumed immutable sources returned HTTP 409 with `ACTIVE_WAIT_SOURCE_FINAL`; and a query scoped to the consumed finite subscription retained its history in All while Following returned zero rows/count. Accepted receipts in this API fixture were explicitly seeded to exercise controls; no new model turn or runtime-acceptance proof is claimed by these probes. Evidence: `.cc/temp/rereview-api-evidence.json` and `.cc/temp/rereview-api-durable-readback.json`.

The live refusal probe also caught a retained-runtime error constructor mismatch causing HTTP 500. The route now preserves domain error status/code by their semantic contract, as the controls route already does. Both-scope regressions passed (`vrun-e93f6c7e-8214-4eb4-9ed8-d60025121f88`), followed by the successful live 409 retry.


Desktop (1440×900) and mobile (390×844) checks verified that recipient paging kept the form open without submitting; deliberate Submit created exactly one subscription for the newly selected recipient. Expired passive history displays Expired, its Lifetime is the actual follow expiry, and the differing cancelled deadline is separately labelled Prior wait deadline. A settled row cannot claim Delivered without a matching accepted batch. Evidence: `.cc/temp/s4-live-evidence.json`, `.cc/temp/expiry-label-live-evidence.json` and the corresponding screenshots. Final rendering regression: `vrun-be78528c-52c0-426c-9f07-ebcdc9beef16` (one file, six tests).

Owned live fixtures were removed and their remaining subscription/wait/inbox/preference/batch counts verified as zero. Browser and isolated dev server were closed before aggregate typecheck. Production and its shared datastore were not modified. Cleanup evidence: `.cc/temp/rereview-api-cleanup-readback.json`.

The final registered changed-dependency suite passed with `--require-match` (`vrun-c3f85748-dee5-4794-9076-5eb4e454e996`). This covers the complete selected dependency set, not a separate full-repository suite. The preceding broad run found two stale session/project consolidation assertions that expected re-registration of an already consumed final result to succeed; those now assert `ACTIVE_WAIT_SOURCE_FINAL`, no new wait, and preservation of the existing receipt. Their focused correction passed (`vrun-6df0a1b7-4286-4123-9a8c-334df09597c3`) before the final broad run.

Full typecheck passed (`vrun-b89a0c0d-f1b9-4734-b6d5-013cc3c3bc48`), along with lint (`vrun-753f3e1e-cb0d-4ef1-b3d9-2cfe08176ee7`), architecture seams (`vrun-8a2b3d39-8065-433b-99b2-3392eaf1697d`) and formatting (`vrun-44f762ea-4e30-4ecb-aa9d-4b2a490fdf90`). Initial typecheck findings were test-only: an unsupported Testing Library query option and an unused fixture binding; both were corrected without weakening assertions. Hashes of all 127 changed files remained unchanged throughout the final broad run. The diff check was clean, with no snapshot drift or tracked changes to generated Next declarations, TypeScript configuration or repository instructions.
