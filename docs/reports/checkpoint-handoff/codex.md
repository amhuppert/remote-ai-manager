# Codex optional handoff certification

Status: **Codex certification observations complete; not release approval**. Four three-cycle experiments, both artifact refreshes, authenticated journeys in both scopes, and the failure/interruption matrix are recorded. Semantic failures and cleanup-uncertainty holds below remain visible even where lifecycle mechanics passed.

## Runtime and method

The actual native session metadata identifies SDK-bundled app-server **0.153.3**, originator `command-center`, provider `openai`. Selected model: `gpt-6-astra`, `reasoning=high`, `fast=false`. The standalone PATH CLI reports 0.154.0; it is not the runtime these experiments used. No SDK upgrade, alternate exec transport, experimental protocol, capability override or numeric-limit reduction was used. Source capture uses **instruction-only** mode with normal callable tools. Abstention is an observed behavioral result, not proof that tools were absent.

Each run uses the production manager and adapters with an isolated config/SQLite/transcript tree under `.cc/temp/checkpoint-probes/codex/`. It supplies the shared original continuity corpus and image, plus independently authored migration/customer/rejected-approach/cache-hypothesis/deferred-action facts. Generation remains the configured production Claude compaction path. Warmup is followed by a real ordinary native tool invocation that writes exact bytes `CODEX-WRITABLE-CONTROL-731` to `ordinary-tool-positive.txt`. The deferred `pending-action-canary.txt` remains absent. Cycle 2 delivers queued input. Each run makes 11 ordinary and six generation submissions; capture-off makes zero captures, capture-on three. Caps remain 12/6/0-or-3; provider-internal retries are unavailable.

## Three-cycle observations

| Run | Conversation ID | Applied cycles | Capture outcomes | Exact seed bytes, cycles 1/2/3 | Mechanical result |
| --- | --- | --- | --- | --- | --- |
| codex-session-off-v1-session | 3024ec06-cfa1-4213-8a4a-73bf192a1358 | 3 | Not requested | 8,583 / 11,756 / 14,544 | Passed |
| codex-session-on-v1-session | da2f5b42-7e66-46bc-8808-e778c296b43b | 3 | Included / included / included | 11,021 / 16,047 / 20,555 | Passed |
| codex-project-off-v1-project | 14a037e7-e0fc-4bb1-a18b-90238486bff6 | 3 | Not requested | 8,006 / 10,545 / 13,600 | Passed |
| codex-project-on-v1-project | ece1385f-48c4-431e-a415-df361e5f6354 | 3 | Included / included / included | 11,158 / 17,073 / 20,049 | Passed |

Mechanical checks cover fresh distinct provider references, no resume handle when creating fresh continuation, exact seed acceptance once, no later reinjection, queued attempt correlation, normal full memory-index delivery, CC conversation/transcript/worktree identity, original archive hashes, complete tool/image recovery and ordinary continuation. Shipped Codex baseline capability was already enabled and remains enabled.

Independent native inspection correlates each of the six capture turn windows to the exact retired source reference in the persisted operation. All six windows are complete and contain zero native `_call` records. All four source ordinary positive controls contain an actual `custom_tool_call`, paired with the exact filesystem effect. Protected windows retain calls even where stable transport notifications omit them. This successful sample is not the separate deliberate violation experiment.

Both capture-on refreshes (`artifact-codex-session-artifact-v1` and `artifact-codex-project-artifact-v1`) passed exact frozen seed, receipt, reference and identity preservation after production rolling-artifact refresh. Capture-off exercises the original artifact-independence path during its cycles.

## Retention and temporary restrictions

All four overall reports are **failed** because semantic expectations were not all retained. Original machine reports are preserved, with independent adjudication alongside them:

- All four runs fail direct recall of `shard-07` by cycle 3. Session capture-on seed 1 retains it, but seeds 2/3 lose it. No shard-specific retrieval-assisted answer was requested. The preserved complete original oversized log entry remains recoverable; that is distinct from successful direct recall.
- Both capture-on runs retain the additional migration `HANDOFF-MIG-731`, customer `ACCT-4902`, rejected original-archive rewrite, unverified stale-cache hypothesis and deferred action across all three cycles.
- Session capture-off cycle 1's belief-promotion flag is a grader false positive: “never confirmed” is uncertainty. Independent review nevertheless finds a scheduler denial despite a literal `RCN-4417` token pass and a seed that mislabels `ACCT-4902` as a migration identifier.
- Project capture-off genuinely loses customer/cache facts in cycle 1. Later answers recover them. Cycles 2/3 cache-hypothesis failures are grader false negatives for “possible explanation … never established.”
- Image measurement **812** is answered correctly with the original image reattached. This is retrieval-assisted evidence, not unaided preservation of image meaning.

No broad capture-only no-tools prohibition was found in the six accepted advisory candidates. Ordinary no-tools test prompts do remain in recent dialogue. The original user deliberately deferred the pending file action until later authorization, so preservation of that deferral is not capture-policy leakage. Session capture-off seed 1 invents a “suspicious probe” user-confirmation gate; this is a baseline distortion, not attributable to an optional capture that never ran. Structural exclusion of capture controls from evidence fields does not establish universal absence of prose leakage.

Detailed independent reviews are `.cc/temp/codex-session-off-semantic.md` (both session variants) and `.cc/temp/codex-project-semantic.md` (both project variants). A later release owner must assess these quality failures; this context does not turn them into release approval.

## Usage and latency

Capture receipt input/output/cached token counters and cost are **null** in all six captures. Execution and settlement durations are observed. No hard-dollar, source-context occupancy or savings claim is supported. Ordinary Codex costs below use `cc:estimateCodexCostUsd`, not provider-reported prices; six generation calls per run have unavailable cost in the ledger, and captures are excluded from those ordinary sums.

| Run | Elapsed seconds | Ordinary estimated USD (incomplete total) |
| --- | ---: | ---: |
| Session off | 381.337 | 0.964184 |
| Session on | 465.397 | 0.806318 |
| Project off | 365.252 | 1.029396 |
| Project on | 541.746 | 0.894174 |

These concurrent sample wall times include generation, provider latency and probe work. They are not a controlled performance estimate or evidence that capture saves money. Provider-reported sum zero with zero reporting calls means **unavailable**, not free execution.

## Evidence locations and reproduction

For each run listed above, `.cc/temp/checkpoint-probes/codex/<run>/evidence/` contains:

- `protected-evidence.json`: original full operations, seeds, results, scope/runtime details; mode 0600.
- `public-report.json`: immutable original grades, calls, hashes, exact sizes and outcome.
- `native/manifest.json`, exact native windows and `session-meta-*.jsonl`: protected references, byte intervals and runtime metadata; mode 0600.
- `native-public.json`, `native-runtime-public.json`: supplemental independent digests/offsets/coverage/version projections.
- Capture-on only, `source-correlation-public.json`: each capture's same-source-thread result, source hash/boundary, selected model and exact saved seed hash.
- Capture-on only, `artifact-codex-<scope>-artifact-v1/`: independent immutable-refresh evidence.

Supplementary native audits were run after the completed experiments; they are not retroactively represented as original executable output. Original public reports bind their protected artifacts and executed bundle hashes. `.cc/temp/codex-cycle-evidence.json` collects the four public matrices and primary hashes; `codex-evidence.json` publishes seventeen cycle/route/failure/control records, supplemental hashes and the original outcomes.

Reproduce with fresh run IDs:

```sh
scripts/probes/run-checkpoint-handoff.sh --backend codex --scope session --scenario cycles --capture on --model gpt-6-astra --reasoning high --run-id <fresh>
```

Repeat for project scope and capture off; use `--scenario failures --case artifact --from-run <protected-evidence.json>` for independent capture-on artifact refresh. Never overwrite an existing evidence directory.

## Failure and interruption observations

All following fault runs use session scope. The successful both-scope capture/fresh-continuation journeys above are separate. Original failed/incomplete runs remain in the evidence index.

| Run suffix (all `codex-…-session`) | Actual result | Continuation / cleanup |
| --- | --- | --- |
| skip-v1 | Submitted capture omitted `skipped` | Baseline ready; fresh ordinary completed; settled |
| cancel-v1 | Interrupted capture, `cleanup_unverified` | Reconciliation hold; no seed or continuation; original incomplete |
| cancel-observed-v2 | Submitted capture cancelled, no seed | Ordinary completed on original continuity; child inspection/collection passed |
| output-v1 | Natural source challenge produced a valid answer under the limit | Included; requested overflow not observed; original incomplete |
| output-challenge-v1 | Provider-authored stream reached 6,145 bytes against unchanged 6,144-byte limit | Omitted `output_limit`; baseline ready and fresh ordinary completed; settled |
| tool-violation-v1 | Real native callable tool executed | Omitted `prohibited_activity`; baseline ready and fresh ordinary completed; settled |
| execution-limit-v1 | Owned app-server suspended until after actual unchanged 60,000-ms deadline, then resumed | `cleanup_unverified`; reconciliation hold; no seed/continuation; original incomplete |
| provider-interruption-v1 / provider-interruption-fixed-v2 | SIGTERM after actual capture turn/start acknowledgement | Leader exit observed, descendant inspection unavailable; reconciliation hold; original incomplete |
| session-daemon-restart-v1 | Owned isolated daemon interrupted after native capture start | Queue retained; explicit baseline recovery accepted exact queued input without capture replay |
| terminal-v1 | Ordinary turn completed while its yielded `/bin/sleep 120` was alive | Production client close collected terminal and app-server; passed |

The tool-violation and output-challenge fixtures replace only the explicitly challenged capture input before production runtime byte measurement. They retain the real installed app-server, continuity, capture ownership, output schema, callback, abort signal and every shipped numeric limit. They are **controlled real-provider input faults**, not normal-prompt compliance samples. The overflow bytes are generated by the provider, not appended or injected into its answer. Original and forwarded prompt hashes/bytes are recorded. The native/tool inspection confirms an exact 22-byte `CAPTURE-TOOL-VIOLATION` file remains, and the oversized raw answer reaches 6,145 persisted bytes before abort. This live violation also has stable commandExecution notifications; silent-notification rejection is established only by the labelled adapter test. The violation's filesystem effect is inspected separately from the deferred-action canary: rejecting a handoff does not roll back a tool's effect.

Each fault has one capture submission, no repair or automatic retry. Settled skip/cancel/output/violation cases record actual native completion or abort coverage. The initial cancellation, deadline and provider-loss cases retain their original incomplete status and uncertainty holds. A process exit does not establish collection of arbitrary descendants. In the deadline case the fixture observed SIGSTOP/SIGCONT, actual limit 60,000 ms, app-server exit and child-clear observation, but the runtime still refused to certify settlement; the later observer does not retroactively clear that durable hold. No request used a shorter limit to manufacture a timeout.

The authenticated daemon restart preserves the archive prefix hash `a9cc06ee2d67e481ed54f5c8db0315b3a6f0bc714c3acd086cd328b6c34a2af1` and the exact queued message. Deterministic reconciliation returns 409. After eight observed interrupted processes are collected using PID/start identities, the test operator explicitly submits stopped-execution **testimony** through the production API; this is neither CC-observed universal cleanup nor human approval. The hold remains until a separate handoff-off recovery is admitted with HTTP 202 and applied. Exactly one original capture is observed. Final cleanup collects sixteen observed processes, restores config and leaves none running. The recovery queued turn is aborted by final cleanup after durable acceptance: this proves retained input and matching acceptance, not completion of its final answer.

The running-terminal case uses one ordinary provider call, no capture or eligibility bypass. A synchronous observer samples the exact child PID/start at real `turn/completed`, before forwarding the notification unchanged. It observes `/bin/sleep 120` alive, then absent after normal production close; app-server exit is also observed. No emergency kill was used. This demonstrates actual collection of this owned terminal, not rollback of arbitrary external effects. Its native window is 48,780 bytes, SHA256 `33ec888d3cce2c75b3de20292617cf608ae540b2770cfbc20fb24474c52a185b`.

Adapter boundary integration tests separately cover absent native facility, supplied-but-unreadable interval, and native prohibited calls with silent stable notifications. These are injected infrastructure tests, **not live SDK evidence**. The deliberate live violation is independently inspected for its actual transport/native coverage; no claim that its stable notifications were silent is inferred from those tests.

Failure-stage evidence exposed a receipt bug: unsettled adapter results were discarded before recording the reconciliation hold, leaving durable submission/mode flags false despite confirmed provider submission. The correction and regression evidence are recorded below; historical artifacts retain the pre-fix facts and are never rewritten.

The initial route prerequisite exposed installed CLI rejection of whitespace in dev recovery identifiers. The isolated fix and regression tests were prepared in this lane; Alex applied/rebuilt CC outside it. A subsequent actual `cctl dev ensure nextjs` succeeded against the same-worktree isolated server. This records operator action as testimony and the successful CLI response as observed evidence; it does not fabricate main-branch approval or cleanup.

## Authenticated route and complete-entry checks

Both real HTTP journeys passed with instruction-only mode established and an included handoff: `codex-session-routes-v1-session` (conversation `f293a3db-5262-4852-90c3-3bf570feb283`) and `codex-project-routes-v1-project` (conversation `da34be36-0ebd-4e7b-8e20-29ead483b1f9`). Each recorded authenticated eligibility, HTTP 202 admission, durable ready, fresh ordinary continuation, and applied receipt. Independent read-only SQLite checks matched seed_text SHA256 to both frozen and accepted hashes, verified the admitted/accepted attempt, and found distinct prior/accepted references. Each run restored config and observed all three owned server/child processes exit, with no cleanup errors. No stopped-execution attestation was submitted. `route-evidence.json` holds protected HTTP/cleanup records; `durable-route-public.json` holds the independent digest checks. Both are indexed in `codex-evidence.json`.

Supplemental production history reads in all four cycle stores verified real persisted target membership and recovered original tool-result entries at raw sequences 1 and 4 (272 and 107 content bytes) and the complete user-pasted oversized log at raw sequence 8 (16,470 bytes). All original/recovered content hashes match. The complete log SHA256 is `eea22aed8dd315f33e17dcea95d4d44204d03c7f1eb04e2c389ceab63555ac9e` and retains `FATAL shard-07 lease expired mid-scan`. These twelve reads made no provider calls. `tool-recovery-public.json` and protected complete exports are saved in each run. Successful retrieval does not rewrite the failed direct-recall result.

The bounded independent audit `.cc/temp/codex-cycles-audit.md` recomputed all twelve frozen and accepted seed hashes, fifty native-window hashes, six same-source capture correlations, both artifact refresh invariants, and all twelve history recoveries. No remaining cycle-task evidence gap was found. All live/collector command sessions have been collected. Observed process collection and product-level cleanup uncertainty are separately recorded below; the final combined release conclusion remains open.

Cycle-stage checks: integrated five-file test pass `vrun-7d2d383e-4176-4b8c-a114-095c4aa777d7`; full typecheck `vrun-7f467190-9d90-4e8e-9881-8c85264156ec`; full seams `vrun-a62bb9c3-20bf-48fb-9d18-55e0f0b9d118`; lint `vrun-bade77bc-83e5-4416-a543-bb10568e3bfd`; report formatting `vrun-7f882d2b-7021-42f2-851d-a0f40ba23001`. Behavioral helpers and the CLI defect were reproduced red before green; report prose and wiring used contract/type checks.


The receipt correction preserves only observed adapter fields through the atomic
cleanup-hold transition, bound to the exact capture ID; it cannot set settlement,
accept a candidate, or clear queue ownership. Both-scope SQLite regressions reload
the truthful receipt and explicitly enqueue/nudge without dispatch. The real
`codex-provider-interruption-fixed-v2-session` repeat confirms durable
`submitted=true`, `modeEstablished=true`, incomplete activity, unknown prohibited
activity and measured 1,089-ms execution/4-ms settlement attempt. It still records
`executionSettled=false`, `cleanup_unverified`, no payload, no continuation and
`needs_reconciliation`. This is evidence of corrected bookkeeping, not successful
cleanup. Original v1 artifacts preserve the prior receipt defect.

Failure-stage registered checks: six matched test files passed
`vrun-0b84cfd8-f6e1-418e-9d4d-bd9858b0a022`; native interval regression (52 tests)
`vrun-33b3e076-97e6-4e71-b4a4-097d83b6a9f1`; receipt repository guards/reload
`vrun-8f463ede-f618-4d1c-9a20-f65de8ab95df`; both-scope receipt/blocked-queue
integration `vrun-2cdef117-872a-47e9-8270-193590e01f3c`. Final production-change
typecheck `vrun-f6efd650-7a0c-4a11-99a1-88fc9620ca18`, seams
`vrun-451b7e59-8063-48a9-8450-5eeb23937463`, lint
`vrun-7a8afcca-f6bc-4966-8a78-a14b6fec0d9a`. These deterministic checks supplement,
and do not replace, the live evidence.


## Publication and scope of conclusion

The committed `codex-evidence.json` is the public comparison index. It binds each
original report and protected artifact by SHA256 and includes exact input/seed
hashes, scope/conversation/operation identities, accepted hashes, section sizes,
usage provenance and supplemental native coverage where available. Raw provider
references, seeds, transcripts and native windows remain in the per-run protected
scratch paths, not copied into this prose. Public artifacts do not disclose raw
provider continuity references. The source head and executable digest identify
each executed build; the final receipt repair was exercised only by its explicitly
named fixed-v2 repeat, not retroactively attributed to earlier runs.

The completed evidence supports same-thread instruction-only capture with callable
tools and fresh checkpoint continuation in both scopes. It does not establish
perfect semantic retention, universal abstention, rollback, universal descendant
cleanup, a hard dollar cap, or a completed answer for the daemon-recovery queued
turn. Provider interruption and deadline samples remain uncertainty holds. Their
observed leaders exited and all test command sessions were collected; unavailable
native/descendant coverage remains unavailable. The running-terminal and daemon
fixtures provide their own narrower observed collection records. No provider
request is intentionally left running, and the isolated dev server is stopped.

Release verification owns the combined baseline-versus-capture conclusion and
compatibility/fork regressions. In particular, it must weigh direct-recall loss
against retrieval success and the capture-on retention of added source facts.
The report preserves failed machine grades alongside independent adjudication;
mechanical success is not semantic approval.

Reproduce fault observations with fresh IDs and the common selected model:

```sh
scripts/probes/run-checkpoint-handoff.sh --backend codex --scope session --scenario failures --case output-limit-challenge --model gpt-6-astra --reasoning high --run-id <fresh>
```

Other explicit cases are `skip`, `cancel`, `output-limit`, `tool-violation`,
`execution-limit`, `provider-interruption`, `daemon-restart`, `routes` and
`running-terminal`. Routes also support project scope. The terminal fixture's
original evidence came from the standalone bootstrap recorded in
`.cc/temp/codex-terminal-report.md`; its exported implementation is now reachable
through the shared CLI as wiring, without asserting an additional live rerun.
