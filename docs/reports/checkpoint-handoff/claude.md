# Claude handoff live evidence

Status: both-scope cycle and bounded failure/control experiments completed. Semantic grades still fail; natural provider-authored overflow remains unproven. This report does not approve release.

## Method and authority

These explicit operator-run probes exercise the integrated production conversation manager and actual Claude adapter in isolated scratch stores. The route cases use authenticated session/project endpoints on the worktree dev instance obtained through `cctl dev ensure` and `cctl dev doctor`. They do not use the managing instance datastore. Design revision 7 and the live-claude workflow acceptance contract govern the evidence.

Source HEAD: `d2624a38b6dd10c372171132e6caf743690c874c`, with uncommitted probe changes identified by each report's executable SHA-256. Runtime Node: `v24.16.0`; installed Claude SDK: `0.3.257`. Requested model: `sonnet`; observed capture native initialization: `claude-sonnet-5`. The alias alone is not model evidence. Per-run protected evidence contains raw references at mode 0600; public reports contain digests.

The corpus expectations were authored before provider output: original continuity facts plus `HANDOFF-MIG-731`, `ACCT-4902`, the rejected archive rewrite, an explicitly unconfirmed stale-cache hypothesis, and an unfinished file action. Assertions retain the original image, tool-log, queue, memory, identity, seed-delivery and archive checks. Provider answers cannot establish process or database facts.

## Completed observations

| Run | Result | Evidence |
| --- | --- | --- |
| `claude-routes-session-v1-session` | Passed authenticated source → included tool-disabled handoff → fresh applied continuation; canary absent; dev process tree collected | `.cc/temp/checkpoint-probes/claude/claude-routes-session-v1-session/evidence/public-report.json` |
| `claude-routes-project-v1-project` | Passed authenticated source → included tool-disabled handoff → fresh applied continuation; canary absent; dev process tree collected | `.cc/temp/checkpoint-probes/claude/claude-routes-project-v1-project/evidence/public-report.json` |
| `claude-session-off-v2-session` | All three checkpoints applied; fact retention failed; immediate SessionEnd observations were premature | `.cc/temp/checkpoint-probes/claude/claude-session-off-v2-session/evidence/public-report.json` |
| `claude-session-on-v2-session` | Incomplete: cycle 3 could not complete within six generation submissions; cycle 1 capture timed out and cycle 2 included a handoff | `.cc/temp/checkpoint-probes/claude/claude-session-on-v2-session/evidence/public-report.json` |

The baseline v2 saved seeds omit `ACCT-4902` and `shard-07`. The fresh agent reported the customer identifier unavailable in all three cycles and could not report the failed shard in cycle three. These are observed losses, not passing continuity claims. The pending action remained absent; ordinary explicitly authorized tool work succeeded. The independent review is `.cc/temp/claude-live-evidence-review.md`; its settled hook supplement is `.cc/temp/claude-live-hook-supplement.json`.

The ordinary SessionEnd hook processes append asynchronously after the manager's close returns. The final hook log contains the positive controls that the immediate snapshots missed. The probe observation window was corrected and verified by the final runs; original reports remain unchanged. Source-correlated SessionEnd timestamps were 296/263/348 ms after `checkpoint.ready` in baseline cycles 1/2/3. Production ordinary `close()` returns after synchronous `query.close()` rather than awaited child settlement. This is a separate readiness/cleanup ordering finding for release review; delayed observation must not be represented as proof that readiness waited for native hooks. Capture suppression must still cover the complete source-correlated window, excluding separately correlated generator hooks.

## Bounds and accounting

Cycles permit at most 12 ordinary, 6 generation and 0/3 capture submissions. Separate failure cases permit at most 16/12/8. The counter is admitted before provider dispatch; remote route cases reserve a finite upper bound and report observed durable generation counts separately. Capture has zero repair or automatic retry. Shipped 60-second execution and 6,144-byte accepted-output limits remain unchanged. Native inference retries and unavailable generation costs are unavailable, not zero.

The two route runs used executable digest `9a4d5b8ea71f61f76669b8dcd53b9c6b4344b382d808f1d6515aa6d1f9c5e18d`. Protected evidence digests: session `62d794a0fdb43ad88fa81470f49aa19297700d42a37e8fd0c0ece19c579dbd9a`; project `d95cb47bfd6e2c79072a7be19a6121ada665d34ad91ab297d05ec2c6adeee744`.

The committed [evidence index](claude-evidence.json) records each terminal run's executable digest, protected/public report hashes, operation/seed/provider-reference digests, bounded submission totals, capture source coverage and observed usage. Raw source-reference entry IDs remain in the hashed original public reports; the index records their count and digest. Protected raw references remain local at mode0600.

## Commands

```sh
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario failures --case routes --model sonnet --run-id claude-routes-session-v1
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope project --scenario failures --case routes --model sonnet --run-id claude-routes-project-v1
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario cycles --capture off --model sonnet --run-id claude-session-off-v2
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario cycles --capture on --model sonnet --run-id claude-session-on-v2
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope project --scenario cycles --capture off --model sonnet --run-id claude-project-off-v2
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope project --scenario cycles --capture on --model sonnet --run-id claude-project-on-v2
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario cycles --capture on --model sonnet --reasoning low --run-id claude-session-on-low-v3
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario cycles --capture off --model sonnet --run-id claude-session-off-v4
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario cycles --capture on --model sonnet --run-id claude-session-on-v4
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope project --scenario failures --case artifact --from-run .cc/temp/checkpoint-probes/claude/claude-project-on-v2-project/evidence/protected-evidence.json --run-id claude-project-artifact-v1
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario failures --case artifact --from-run .cc/temp/checkpoint-probes/claude/claude-session-on-v4-session/evidence/protected-evidence.json --run-id claude-session-artifact-v1
```

Session artifact refresh `claude-session-artifact-v1` passed all five durable checks: new artifact completed, exact seeds unchanged, receipts unchanged, reference unchanged, identity unchanged. Its evidence is under `.cc/temp/checkpoint-probes/claude/claude-session-on-v4-session/evidence/artifact-claude-session-artifact-v1/`.

## Final session comparison

`claude-session-off-v4-session` and `claude-session-on-v4-session` each completed three applied checkpoints, 11 ordinary and six generation submissions. On submitted three captures: invalid output omitted, included, included. Both have zero lifecycle assertion failures and zero corrected hook-observation failures. All five added handoff expectations passed all three cycles in both variants; the pending files remained absent and ordinary authorized tool work succeeded.

Both overall reports remain **failed**, preserving original-corpus semantic findings. On could not recover the scheduler identifier in cycle one or the shard in cycle three. Off lost the shard and later `--since`; bucket/library answers were correct outside the requested wrapper, and the image answer correctly read 812 ms while mentioning a rejected 500 ms distractor and disputing its prior identity. Full original answers were inspected; these are not all equivalent to missing facts. Logged full memory delivery passed even when following-turn self-report said `MEMORY-WITNESS: none`, because normal later memory delivery can be a delta.

On capture costs were $0.1492658 / $0.0992398 / $0.1130098 (total $0.3615154), execution 36,640 / 17,377 / 13,674 ms, settlement 200 / 335 / 281 ms. Ordinary on cost was $0.5102554; six generation costs are unavailable. Native init and receipt records, rather than model statements, establish mode and provider-reference correlation.

The earlier session on-v2 and low-effort v3 runs remain incomplete; they are not silently replaced by v4. Their six-generation caps stopped a needed repair before dispatch. Lower effort did not remove that failure.

## Project comparison and semantic adjudication

Both project variants traversed three applied checkpoints, including queued delivery, distinct fresh references, one exact seed acceptance, following-turn seed omission, full-index memory delivery, archive/image retention and fixed CC/worktree identity. Both automated verdicts remain failed. Capture-on outcomes were `invalid_output`, `included`, `included`; correlated native initialization established tool-disabled mode and empty inventories in each capture attempt.

The independent semantic review (`.cc/temp/claude-project-semantic-review.md`) distinguishes real losses from grader limitations:

- Off: customer ID and shard lost. Cycle-two bucket/library answers were correct outside the requested wrapper, producing format-based failures.
- On: identifiers were repeated but demoted as possibly illegitimate work; archive rewrite was confused with CSV writer rejection and the cache hypothesis was denied. Some facts existed in the seed but were misread. The scheduler ID string appeared while its recorded scheduler relationship was denied, a string-grader false positive.
- Both selected the correct 250 ms threshold but mentioned rejected 500 ms in explanation, producing forbidden-string failures. The image pixels yielded 812 ms, although the agent questioned the image's recorded historical identity despite verified byte equality.
- Off explicitly treated the `.handoff` worktree name as proof that temporary capture restrictions still applied during ordinary turns. This is observed prose leakage, not proof of blocked ordinary tools: the later authorized tool-positive control succeeded in both variants. Baseline leakage means capture cannot be assigned sole causation.

The settled project hook supplement (`.cc/temp/claude-project-hook-supplement.json`, SHA-256 `cf1870a966ec6c01e1841438c555f0ebeb4658a14067b34a8f86950b0d364cce`) verifies all source-correlated suppression windows and final ordinary tool/hook positives. Ordinary off SessionEnd events occurred 337/258/124 ms after readiness.

Project artifact refresh `claude-project-artifact-v1` passed: all three seed bytes/hashes, receipts, provider reference and conversation identity were unchanged after a new production reading artifact completed. Evidence: `.cc/temp/checkpoint-probes/claude/claude-project-on-v2-project/evidence/artifact-claude-project-artifact-v1/public-report.json`.

Ordinary reported costs: off $0.5733206, on $0.5965136 (11 ordinary submissions each). Six generation submissions each have unavailable cost. Three on captures add $0.3970414; their execution times were 46,591 / 29,268 / 21,591 ms, settlement 728 / 2,253 / 181 ms. These are observed components, not complete total-cost estimates.

## Capture rejection example

In `claude-session-on-low-v3-session`, cycle one returned `reported_observation` claims with zero-valued source coordinates and some empty observation references. The durable capture was omitted as `invalid_output`; the source agent was not asked to repair it. The source identifiers existed in the raw answer, so this omission must not be presented as a successful accepted advisory handoff. Later-cycle output also supplied unverifiable coordinates and was rejected.

## Failure/control observations

| Case | Observed result | Evidence run |
| --- | --- | --- |
| Skip handoff | Submitted real capture stopped/settled, omitted `skipped`, baseline checkpoint ready and ordinary continuation completed; canary absent | `claude-controls-v1-session` |
| Whole checkpoint cancel | Submitted real capture stopped/settled, checkpoint cancelled with no payload, ordinary continuation completed; canary absent | `claude-controls-v1-session` |
| Setup control rejection | Explicit fault at real Query control-call boundary returned rejection before dispatch; capture unsubmitted/mode unestablished, source close count zero at capture return; later baseline checkpoint and fresh ordinary continuation succeeded; both owned children exited | `claude-setup-rejection-v2-session` |
| Provider interruption | Observed capture-child PID with probe PPID received SIGTERM via its actual SDK process handle; native exit observed; omitted `capture_failed`, baseline readiness and fresh ordinary continuation succeeded, all three observed children collected | `claude-provider-interruption-v2-session` |
| Execution deadline | Dedicated owned capture child suspended after native init; unchanged 60,000 ms timer expired at 60,003 ms, child resumed and settled in 1,495 ms; omitted `execution_limit`, baseline readiness and fresh continuation succeeded; all three children collected. Earlier natural expiry was 60,006 ms | `claude-execution-expiry-v2-session`; `claude-session-on-v2-session` |
| Provider-authored raw answer byte overflow | Not observed. Sonnet ASCII, Haiku ASCII and Haiku Unicode challenges returned 2,430, 1,736 and 2,014 UTF-8 bytes respectively, all below 6,144; omitted `invalid_output`. These cases remain incomplete | `claude-controls-v1-session`, `claude-overflow-haiku-v2-session`, `claude-overflow-unicode-v3-session` |
| Fault-injected raw terminal overflow | After a real successful capture result, appended whitespace expanded its 1,342-byte answer to exactly 6,145 bytes. Production adapter omitted `output_limit`, settled the real child and continued from a baseline checkpoint; canary absent, all three children exited | `claude-output-boundary-v1-session` |
| Daemon loss/restart | Passed actual daemon loss during initialized capture, six observed processes collected, queue held through restart and explicit test-operator acknowledgement, separate baseline recovery applied to the same queued input; no capture replay, archive prefix unchanged, config restored and final processes collected | `claude-daemon-restart-v5-session` |

Setup rejection is **explicit transport-boundary fault injection around a real SDK Query**, not a claim that the provider spontaneously rejected hook suppression. Provider interruption uses SIGTERM through the retained SDK process handle after checking that the observed child belongs to this probe. The dedicated execution-deadline case deliberately SIGSTOPs that same owned capture child after native initialization and SIGCONTs it after the unchanged deadline; it proves the real timer/settlement path under a process fault, not naturally slow inference. Shipped capture limits are unchanged. The helper records source/continuation reference digests, PID/PPID, signal success, SDK exit, usage and lifecycle outcome.

The terminal-overflow case is explicitly **fault-injected bytes, not provider-authored oversized output**. It first saves the complete original SDK success frame at mode0600, then forwards a copy with only answer whitespace added plus `cc_probe_fault` provenance. Original model, usage, cost and correlation fields remain unchanged. The preserved frame is 3,307 bytes with SHA-256 `209e450869b263b9bb172b0821e9d7caefda9357843deddac61b508b922f3016`; its original answer hash is `054c1eaf3535c245bf654f8e066066e3c5ed6f5ec1a54e4f7c9a0f12c09efea1`, and the forwarded 6,145-byte answer hash is `153ee2add8ec7c4bcd8e9504bc90d169983967b427381aed933bb89fb78c58b8`. File mode, byte count and original frame hash were independently reread. The protected result hash is `d38f947489d70efca40da12b23fee6270f39a8b9ac48674a3e1898d04c73cc6b`; paths and correlation records are in the run’s `evidence/public-report.json`.

The setup, interruption, expiry and injected-overflow runs each recorded a different source and following provider-reference digest, baseline readiness, an ordinary continuation and observed cleanup. Setup consumed two ordinary and two generation calls, plus one reserved capture attempt that was **not submitted**. Interruption, expiry and overflow each consumed two ordinary, three generation and one submitted capture call. All remain within 16 ordinary / 12 generation / 8 capture slots; native inference retry counts are unavailable.

| Capture case | Execution / settlement ms | Input / output / cached tokens | Provider-reported USD |
| --- | --- | --- | --- |
| Setup rejection v2 | unavailable / unavailable | unavailable | unavailable |
| Provider interruption v2 | 1,758 / 0 | unavailable | unavailable |
| Execution expiry v2 | 60,003 / 1,495 | unavailable | unavailable |
| Natural Haiku ASCII challenge v2 | 13,331 / 292 | 10 / 955 / 0 | 0.045047 |
| Natural Haiku Unicode challenge v3 | 15,821 / 567 | 10 / 1,692 / 0 | 0.040182 |
| Injected terminal overflow v1 | 12,765 / 382 | 10 / 955 / 0 | 0.024751 |

These are capture receipt measurements, not whole-scenario totals. Unavailable tokens/costs are null, not zero estimates. The injected bytes incur no invented token charge. Activity receipts report transport coverage complete but native inspection unavailable and prohibited activity `not_observed`; this is not a universal absence-of-effects claim.

The initial control run charged every task submission, including unintended automatic naming. It used 11/12 generation slots, so the next execution-limit case was correctly unrun because it required two reserved slots. New isolated configs disable naming. Earlier Sonnet `--reasoning none` attempts and the Haiku attempt with unsupported high effort failed before provider allocation and are not control evidence. Corrected Haiku runs use `--reasoning none` (no effort parameter sent); corrected Sonnet runs use supported high effort.

Reproduction commands matching the recorded failure-run arguments (including explicit default high effort) are:

```sh
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario failures --model sonnet --reasoning high --run-id claude-controls-v1
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario failures --case setup-control-rejection --model sonnet --reasoning high --run-id claude-setup-rejection-v2
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario failures --case provider-interruption --model sonnet --reasoning high --run-id claude-provider-interruption-v2
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario failures --case execution-limit --model sonnet --reasoning high --run-id claude-execution-expiry-v2
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario failures --case output-limit --model haiku --reasoning none --run-id claude-overflow-haiku-v2
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario failures --case output-limit --model haiku --reasoning none --run-id claude-overflow-unicode-v3
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario failures --case output-limit-injected --model haiku --reasoning none --run-id claude-output-boundary-v1
scripts/probes/run-checkpoint-handoff.sh --backend claude --scope session --scenario failures --case daemon-restart --model sonnet --run-id claude-daemon-restart-v5
```

Run IDs above identify existing immutable evidence; use a fresh run ID to repeat. Source fixtures changed between the natural ASCII and Unicode attempts, and automatic naming was disabled after the initial control run. Each report records its executable digest; replaying the current source does not reproduce the historical executable.

## Restart evidence and release limitations

The authenticated restart run recorded one native capture initialization, then killed only the observed isolated dev daemon and collected six PID/start-identity-correlated processes. Restart deterministically retained `needs_reconciliation` with capture `interrupted` and the original queued message pending. Only after observed process cleanup did the probe submit the production stopped-execution acknowledgement as **explicit test-operator testimony**, source `api`. This is not Alex's approval or CC-observed cleanup. Both reconcile responses remained HTTP409 because separate recovery was still required. A separate baseline request, without handoff, subsequently applied and accepted the exact retained queue ID. Original archive prefix SHA-256 remained `afdd3600d556535ad0b098938878619692e2894f1a261962fa8e89e5585c7beb`; the capture ID and native-init count were unchanged. Protected `restart-evidence.json` records config restoration, final cleanup and no cleanup errors; the evidence index binds its hash.

Earlier restart attempts remain incomplete: v1 rejected the strict queue request before interruption; v2 killed and collected five processes but failed on initial post-restart transport; v3 missed the running capture window; v4 hit an empty405 body during read-only route compilation. No acknowledgement was sent in those attempts. The corrected probe distinguishes POST-only module compilation from a successful, schema-checked supported GET and never retries a mutation.

The bounded failure/control experiments are complete, including explicitly injected setup/output boundary faults. Natural provider-authored oversized answers were not obtained and remain unproven. Successful included captures in both route scopes and the final cycle runs kept unfinished ordinary file actions absent; the first standalone pending-action fixture returned invalid output and is not promoted to an included-capture pass.

Three-cycle mechanics are observed in both scopes for off/on, with semantic failures explicitly retained; this is **not release approval**. Release verification must resolve fact loss/status demotion, temporary-control prose leakage and ordinary SessionEnd events after readiness. Earlier generation-cap exhaustion stays incomplete; no unrun case is passed and no cap was raised. The independent fault audit is `.cc/temp/claude-final-fault-audit.md`. It verified the exact accepted recovery seed against SQLite and the first 11 archive frames (16,724 bytes) against the pre-kill hash; all 13 final native frames contain only one capture ID and one empty-inventory init. The interrupted receipt retains `submitted=false` and `auditDurable=false` because process loss cut off bookkeeping despite the recorded native init; these fields must not be interpreted as proof that no capture was submitted. Four replacement-server processes were also collected.

## Deterministic checks and evidence legality

The hook timing regression was reproduced before repair (`vrun-f17f7ae6-85d0-4bf8-84d7-735f48f0f246`) and seven observer/fixture tests then passed (`vrun-1cd99810-8934-454d-b302-522a5fecfce2`). Full typecheck passed after the asynchronous callback change. Latest changed lint: `vrun-2807f8ac-9392-4014-8788-8a4ca5b555f2`; full seams: `vrun-d014c23b-4d1c-484f-abde-a1de46c4f711`. Earlier scoped evidence-parser, budget, route-target/cleanup and continuation-log regressions passed as recorded in the shared harness document. These deterministic passes do not override live failed/incomplete results.

The owned-process helper was reproduced red (`vrun-534e8d10-cad4-45a0-987e-7319cd3ca001`) then green (`vrun-7ed93248-8ed5-41c6-a818-c99917f4d6ce`); an actual disposable-child stop/resume/terminate test passed (`vrun-34f93b4f-5869-4d51-8692-bfeb0da03c25`). Setup-rejection boundary assertions went red (`vrun-c73250ce-3edf-47e8-97f3-ddd667e6a71b`) then green (`vrun-98c796cd-11a5-4f0b-b20b-edd9f7175308`). Terminal transformation tests went red (`vrun-ee2e4100-9de7-46dc-9867-fce8a7bd43a6`) then passed both cases (`vrun-77dc61c4-e4b9-4c64-97c4-c28d54a3592d`), checking unchanged original input, exact 6,145-byte result, explicit provenance and success/capture-only selection. Full typecheck after integration passed (`vrun-61387bc8-22e3-42e0-93a0-a1a219d778b3`). These helper tests are separate from the real production-manager evidence above.

A source audit of the new probe files confirms HTTP authorization comes from the doctor-verified worktree dev token; protected output mode0600 is explicit; stopped-execution acknowledgement is confined to the explicit restart scenario after observed cleanup and is labelled test-operator testimony. A concrete source search covered authorization, acknowledgement, provenance markers and mode0600 writes; all 32 checked private evidence/original-frame files had mode0600. Durable receipts and original native init frames supply process/model evidence. No human approval state or observed cleanup was fabricated.

The empty-response regression failed for the expected JSON parse error (`vrun-7ca5c5d6-f0a6-45f6-840e-d40a0e3d4019`) and three decoder tests passed after repair (`vrun-8d9873f9-b91e-4a35-8503-1dfbf55e1c91`). Final integrated full typecheck passed `vrun-3a527d32-03ad-40fe-ae36-8da79df357d0`. The earlier eleven-file probe regression passed `vrun-63ba6407-51c8-4e5c-85cd-eff38d6e1834`; later terminal-transform and decoder tests cover the subsequent behavior additions. No registered test sends model requests.
