# Live proof of concept and resolved unknowns

Executed on 2026-09-16 with the installed **Codex CLI/SDK 0.153.3**, model **gpt-5.6-sol**, and macOS arm64. These are real model and subprocess calls. The client sends JSON-RPC directly over stdio; no mocked Codex backend and no CC production adapter are involved.

The executable harness is [codex-app-server-poc.mjs](../../../scripts/spikes/codex-app-server-poc.mjs). Its small [MCP fixture](../../../scripts/spikes/codex-app-server-mcp-fixture.mjs) supplies a deterministic read-only tool and an elicitation request. [evidence.json](evidence.json) preserves summarized assertions, the primary steering timeline, run locations, and SHA-256 hashes of raw evidence. Full protocol/stderr/rollout evidence remains in the ignored `.cc/temp/codex-app-server-poc/` directory.

## Reproduce

Run from this worktree with dependencies installed and working Codex authentication:

```bash
node scripts/spikes/codex-app-server-poc.mjs --scenario steer
node scripts/spikes/codex-app-server-poc.mjs --scenario all
```

`--help` lists individual scenarios. Optional `--out` must name a **new** directory under the worktree's `.cc/temp`; an existing evidence directory is refused. `--model` defaults to the model tested above. Calls incur normal model usage.

The harness creates a fresh Codex home and workspace for every run. It copies only `auth.json` into the private scratch home, removes that copy in `finally`, and does not print credentials. It removes ambient CC session credentials/identity from the child environment. It leaves scratch rollouts and controlled files as research evidence; there were **zero scratch auth copies remaining** after the completed runs. It does not create CC production conversations, edit the shared CC database, or mutate the user's Codex config. Platform-injected tools/configuration may still be visible to Codex; prompts restrict the probes to their specified operations. This is isolated state, not a claim of a hermetic model prompt.

Test-first was skipped under the repository's throwaway-spike exception. Every claim below is backed by executable assertions against real protocol responses, model outputs, scratch files, or OS process observations. The original steering token is absent from the replacement instruction; the new unique token reaches the model only through `turn/steer`.

## Demonstration: message delivered while work is in progress

Run: `steer-01`. Thread: `01a0aafb-6de6-7782-941b-a00dd5d9374a`. Turn: `01a0aafb-6e28-7a52-8f48-640d6634585d`.

| Elapsed time | Observed event |
| --- | --- |
| 8,006 ms | Provider reports shell command execution started (`sleep 8`). |
| 8,008 ms | A deliberately wrong expected turn ID is rejected; the harness sends the valid replacement instruction. |
| 8,009 ms | `turn/steer` acknowledges the same active turn ID. |
| 15,919 ms | The command completes; it was not cancelled by steering. |
| Later in that same turn | Final answer is exactly `REDIRECTED_847633c5`, replacing the original requested answer. |

There is **one `turn/started` event**, one final completion, and no replacement turn. After EOF shutdown, a new app-server process resumes that thread and recalls `REDIRECTED_847633c5` without the token being included in its new prompt. The saved `thread/read` response also contains the accepted user input. This proves model consumption and persistence, not merely transport acknowledgement.

## Scenario results

All eleven final scenario runs below completed successfully. A final `--scenario all` replay of the finished harness also passed **all 23 checks in 169 seconds** (`final-all`, recorded separately in `evidence.json`). `observed` means the harness established a limitation, not that the limitation is desirable behavior.

| Run | Question and result | Design consequence |
| --- | --- | --- |
| `steer-01` | **PASS:** steering during command execution changes the same turn's answer; restart preserves it. Wrong expected ID and ended turn both reject with code `-32600`, with distinct messages. | Use expected-turn precondition; preserve definite refusal versus uncertainty. |
| `compat-01` | **PASS:** a real `Codex.startThread().run()` SDK thread resumes through app-server and recalls a unique prior token. | Existing thread IDs/history can be retained on this pinned runtime. |
| `cancel-01` | **PASS:** native interrupt produces `interrupted` in 16 ms; a new process resumes and answers `RECOVERED`. | Await the terminal event; an interrupt RPC response alone is not completion. |
| `burst-01` | **PASS:** several inputs during one command retain one turn and the final instruction wins. Real U+2028/U+2029 survive LF framing. **Observed:** identical `clientUserMessageId` sent twice becomes two persisted user messages. | Client IDs correlate only; no automatic retry after ambiguous delivery. |
| `instructions-03` | **PASS:** new-thread developer instructions override conflicting user input. **Observed:** different developer instructions supplied to resume are ignored. **PASS:** `thread/inject_items` appends an effective new developer instruction that survives another process restart. | Use privileged start/injection and latest hash/unresolved state; never rely on resume override. Duplicate-block and lost-ack recovery behavior remain untested. |
| `policy-01` | **PASS:** a real shell child reads the injected environment marker, writes an allowed file, and receives `EPERM` attempting a sibling write excluded by the native sandbox. | Existing filesystem/environment composition can be carried over; explicitly set temp-root exclusions. |
| `image-01` | **PASS:** a mid-command steer with text and a local red PNG changes the same turn's final answer to `COLOR:red`. | Live input need not be text-only; retain CC image support. |
| `lost-ack-01` | **PASS:** the client deliberately drops the successful steer response; its request times out, yet the real model returns the unique steered token. No retry occurs. | Timeout after write is uncertain, never proof of rejection. This is deliberate transport fault injection with a real server/model. |
| `crash-01` | **Observed:** abrupt SIGKILL of app-server leaves the independently identified OS tool child running; the harness kills it and verifies it is gone. **PASS:** the thread subsequently resumes. | Hard app-server death is not proof of workspace release. Keep typed failure/live ownership and notification; decide deferred durability after CC-parent-death and escalation probes. Never confuse protocol tool handles with OS PIDs. |
| `mcp-03` | **PASS:** configured MCP transport/env reaches a real fixture tool. Under `never`, its elicitation is automatically declined without a client request. With `on-request` in a separate test thread, the server forwards it and the harness's explicit decline unblocks the call, still with experimental API disabled. | Preserve approval policy and implement server-request responses. Experimental opt-out does not remove the need to handle requests. |
| `eof-active-01` | **PASS/observed:** closing stdin during an active command exits with code 0 in about 357 ms, with the observed child gone. | EOF can shut down this runtime cleanly; explicit interruption remains primary because it provides terminal lifecycle evidence. |

The `on-request` MCP subcase exists only to exercise a synthetic request/decline; it does not change the proposed production approval policy. The fixture has no external side effects.

The persisted native session metadata in the steering, sandbox, and both MCP threads also records `memory_mode: "disabled"`, consistent with the launch overrides. This is evidence for that native session setting, not certification of CC's entire managed-memory integration.

## Accounting findings

The same steered turn produced these two usage notifications:

| Field | First model call | Second model call |
| --- | ---: | ---: |
| `total.totalTokens` | 12,283 | 24,660 |
| `last.totalTokens` | 12,283 | 12,377 |

After a new process resumed the same thread, its one response reported both `total` and `last` as **12,411**. The SDK→app-server case independently showed the reset: SDK usage was input 12,129/output 5, while app-server reported input 12,155/output 12, rather than their sum.

Therefore `last` is not the admitted CC turn total, and `total` is not a durable lifetime-thread counter across these process resumes. One process per admitted turn lets CC use final process-local totals for that turn and add its cost to CC's own persisted lineage baseline. The evidence records full input/cache/output categories. Counter meaning under real context-pressure compaction was not exercised; production accounting must not infer compaction from a reset or reset CC's cumulative ledger.

## Failed assumptions retained as findings

- `instructions-01` failed its original assertion that resume replaces developer instructions. `instructions-02` reproduced the failure and proved injection; `instructions-03` also verified injection persistence. The design changed because the initial expectation was wrong.
- `mcp-01` used a tool with no safety annotations. Codex refused the call under `approvalPolicy:"never"`; that policy does not mean unrestricted automatic approval. `mcp-02` added accurate read-only annotations and the call succeeded, but the test expected an elicitation request that the runtime had already auto-declined. `mcp-03` separates those policy cases and verifies both. The harness did not loosen production policy to hide either finding.
- `crash-01` deliberately established that parent exit and descendant exit differ. A successful resume alone would have hidden the surviving tool process.
- The original accounting assumption inherited from the SDK adapter was not portable to app-server. The technical design uses the observed counter scope rather than copying the existing subtraction formula.

## Evidence limits and acceptance boundary

The eleven scenarios establish the reported protocol behaviors on one runtime/model/platform. They do not certify the finished CC integration, UI ordering, queue persistence, checkpoint lifecycle, every MCP/plugin, the complete memory-tool/generation suppression contract, or every model's message phases. They also do not establish lost-ack instruction reapplication, CC-parent death/full escalation, compaction parity with exec, actual RAM parity, or Linux behavior. The [revised design](README.md#required-live-evidence-before-enablement) names the remaining probes and decisions. Linux is a deployed host, not optional portability work; equal process counts do not establish equal memory consumption.

Unhandled requests, unknown phases/counters, ambiguous user delivery, and live cleanup failures have explicit policies in the design. Cleanup columns/admission guards/acknowledgement APIs are deferred pending lifecycle probes; retained live ownership ends at restart, and notification does not close that gap. The instruction-reapplication and comparative compaction policies still need their named evidence. Native-memory, managed-skill and plugin policy composition must also be re-proven against the implemented launch path. The POC does not change production capabilities.

The envelope review additionally ran a side-effect-free reader probe: it instantiated the existing POC reader with in-memory stream doubles, supplied a valid 17 MiB JSON payload without LF, then supplied LF. The reader accepted it without a size error. No child process, model call, or file write was involved. This establishes that the research reader has no framing cap; it is not a failing production test or evidence that the proposed bound already exists. Production requirements now separately bound incoming records, queued payload, and stderr. This review probe is separate from the eleven real-model scenarios and their unchanged evidence hashes.

Validation: all final scenario summaries have no failure; Node syntax checks passed for both harness files; registered changed-scope lint passed (`vrun-d41a3cf7-a54c-4bc5-9800-95bed9407b5f`). No production code was changed, so the full application suite was not run for this design/research branch.

## Design-review dispositions

- **Accept:** inspect the latest instruction state, not any old matching hash. A→B→A must restore A, and later uncertainty cannot be bypassed by finding an older success. Both persistence cases remain acceptance requirements.
- **Accept-reduced:** replace the instruction-operation journal and mandatory checkpoint recovery with latest hash/unresolved state and one acknowledged reapplication of the current block on the next admitted attempt. Its duplicate-block/lost-ack behavior requires a new live probe; uncertain user input is never automatically replayed.
- **Accept-reduced:** keep typed cleanup failure, retained live ownership, blocked reuse, and visible/best-effort phone notification. Defer the durable field, admission guards, and acknowledgement API/CLI until parent-death and escalation probes justify their cost; if needed, deliver shared lifecycle work for affected backends. Restart loss of protection remains explicit. CC has a best-effort shutdown hook; Cursor's recorded cleanup failure alone does not establish retained ownership.
- **Accept:** add independent framing, queued-payload, and stderr bounds. The acceptance barrier alone did not bound allocations before parsing or diagnostic retention.
- **Reject:** do not replace the queued-payload cap with a warning. Individually valid frames can accumulate without bound behind a slow consumer; threshold calibration does not remove the need for a hard limit.
- **Accept-reduced:** let the current turn finish when image/user-entry archival is confirmed but queue settlement fails; retain the claim/review outcome and prohibit redelivery. Failed or unconfirmed archival still causes bounded stop. This distinction needs shared queue tests, not a new claim about the POC.
- **Accept-reduced:** compare exec and both app-server instruction paths under matching automatic-compaction workloads, block demonstrated migration regressions, and disclose baseline weaknesses. Keep authoritative context-loss/memory-index handling. macOS/Linux and parent-death/escalation verification remain required; an old instruction acknowledgement or unknown accounting is not proof of retention.
- **Accept:** land callback/failure semantics and dispatch ordering separately with Claude/Cursor coverage while Codex remains next-turn-only, before the app-server migration.
- **Accept:** centralize both transports' upgrade work in the [main design](README.md#sdk-and-runtime-upgrade-procedure), leave exec retirement to separate evaluation, and re-estimate shared queue, transport/host verification, and any justified durable cleanup work separately. The earlier 6–9 days is provisional, not a validated total. Reject RAM parity inferred from process count.
- **Accept:** diagnose decreasing/invalid cumulative counters and report accounting unknown. The final lower counter cannot be trusted as complete usage; this bounds untested compaction behavior without inventing its semantics.
- **Accept-reduced:** generate provider message correlation IDs inside the runtime. The queue-row ID remains private to its settlement callback; a new public provider-correlation field is unnecessary.

The independent protocol review verified all 31 raw-evidence hashes for the eleven individual runs and found no other protocol/evidence inconsistency. The design, integration map, and protocol appendix now agree on the revised recovery policies and distinguish measured behavior from the outstanding live gates. This documentation revision adds no new real-model or Linux results.

## Implementation-gate extension: 2026-09-16

The preceding eleven-scenario record and its hashes remain historical evidence. The additional runs below resolve several of its open questions without reclassifying those original results. The extension ran on **macOS x86_64, MacBookPro16,1**, with **Codex CLI/SDK 0.153.3** and **gpt-5.6-sol**. The original record identifies its host as arm64; these new observations are explicitly x86_64. The extension is stored separately under `implementationGateProbes` in [evidence.json](evidence.json).

The harness still isolates Codex home/workspace and removes its private auth copy. The new [parent fixture](../../../scripts/spikes/codex-app-server-parent-fixture.mjs) is a supervised foreground process standing in for CC; the outer harness observes both its app-server child and an independently identified ordinary Node tool child. No detached job, production conversation, shared CC database mutation, or remote host is involved. Successful assertions for lifecycle scenarios mean the observation and cleanup completed; they do **not** mean all descendants exited unaided.

Exact new scenario commands, each with its own new output directory:

```bash
node scripts/spikes/codex-app-server-poc.mjs --scenario instruction-recovery --out .cc/temp/codex-app-server-poc/instruction-recovery-01
node scripts/spikes/codex-app-server-poc.mjs --scenario parent-lifecycle --out .cc/temp/codex-app-server-poc/parent-lifecycle-01
node scripts/spikes/codex-app-server-poc.mjs --scenario parent-kill-escalation --out .cc/temp/codex-app-server-poc/parent-kill-escalation-01
node scripts/spikes/codex-app-server-poc.mjs --scenario compaction --out .cc/temp/codex-app-server-poc/compaction-01
node scripts/spikes/codex-app-server-poc.mjs --scenario parent-kill-escalation --out .cc/temp/codex-app-server-poc/parent-kill-escalation-02
```

`--scenario all` deliberately retains the original eleven scenarios; these additional, more expensive gates are explicitly selected. The last lifecycle replay verifies the final harness's identity-checked cleanup of its tracked probe processes. The harness now refuses a runtime version other than `codex-cli 0.153.3` before copying authentication. Syntax checks passed for the research harness and parent fixture. The throwaway-spike exception still applies; these probes do not replace production adapter tests.

### Instruction reapplication

`instruction-recovery-01` passed three assertions in 24.3 seconds. A first process established governing block A. A second process successfully injected B, deliberately discarded the matching successful response, timed out, and closed without starting a user turn. A third process resumed, reapplied the exact B block once with acknowledgement, and the model answered the B token despite conflicting user input. Injecting A again restored A; another process restart still answered A. This measures lost-ack recovery, identical duplicate blocks, A→B→A, and persistence. It does not make native injection idempotent or authorize replay of uncertain user input.

### Parent death and escalation

`parent-lifecycle-01` completed in 42.2 seconds. The observed ordinary tool child had its own OS process group, distinct from app-server's group.

| Scenario | Server and ordinary tool outcome | Observation |
| --- | --- | --- |
| SIGKILL the CC-like parent | Both exited; no harness cleanup needed. | About 344 ms through observation. Parent pipe closure allowed app-server's EOF cleanup. |
| SIGTERM the CC-like parent, with its shutdown hook | Native interrupt, then EOF; both exited. | About 452 ms through observation. |
| Freeze app-server with SIGSTOP, then gracefully stop the parent | Interrupt timed out after 5 seconds; EOF timed out after another 5; SIGTERM exited the server. The tool survived under PID 1. | Harness killed the independently identified tool and verified disappearance. |
| Freeze app-server and deliberately inherit ignored SIGTERM | The ladder reached interrupt → EOF → TERM → KILL. KILL exited the server; the ordinary tool again survived under PID 1. | The deliberate ignore-TERM fault exercises the KILL branch. Both runs cleaned the survivor and verified disappearance. |

These are live process observations, with fault injection only for the frozen/ignored-signal cases. The SIGKILL parent case does not establish behavior when app-server is itself frozen or for arbitrary detached descendants. Server exit and successful thread resume still do not prove workspace release.

**Cleanup decision:** retain typed `cleanup_unverified`, failed live ownership, blocked runtime reuse, and visible error notification including the restart limitation and the need to inspect/stop surviving commands. Defer restart-persistent hold columns/admission guards/acknowledgement machinery. Ordinary parent death passed this bounded probe; the escalation survivor is an explicit manual-recovery condition. A durable hold could preserve an already recorded failure but could not record one retrospectively after the parent has died. This decision accepts restart-limited protection; it does not claim the escalation survivor was automatically contained. Linux lifecycle evidence remains required before enablement.

### Comparative automatic compaction

`compaction-01` completed in 86.7 seconds. All three arms used the same pinned runtime/model, the same scratch output generator and task, and `model_auto_compact_token_limit: 15000`. The fixture printed 2,800 neutral synthetic records; no manual compact RPC was sent. Each native rollout recorded **one actual automatic compaction**, between the tool result and the final answer. Exec received its governing block in the first user prompt; fresh app-server used `developerInstructions`; the injected arm resumed a previously used thread before receiving a developer item through `thread/inject_items`.

| Transport/instruction path | Governing token after automatic compaction, within the active turn | Governing token after process resume |
| --- | --- | --- |
| SDK/exec, first-user governing block | Preserved | Preserved |
| App-server, fresh developer instructions | Preserved | Preserved |
| App-server, resumed/injected developer instructions | Preserved | Preserved |

The original token was omitted from the later resume prompt. Neither app-server resume performed an instruction reinjection, so this directly measures retention through the tested compaction. Both app-server arms emitted `item/completed` with `item.type: "contextCompaction"`; this is authoritative input for CC's invalidation handling. Their observed cumulative total counters stayed monotonic (fresh: 11,907 → 11,907 → 24,413; injected: 11,926 → 11,926 → 24,438). Counter reset handling remains necessary for untested cases.

This workload showed **no migration regression** against exec. It establishes neither universal instruction retention nor parity across other models, repeated compactions, different prompts, or Linux. The lower trigger makes the actual automatic-compaction workload bounded; it does not simulate compaction or replace the stored native evidence.

### Memory and supported-host limits

`ps` snapshots observed app-server RSS of roughly **28–29 MiB after initialize**, **104–113 MiB while an ordinary tool ran**, and **143–147 MiB after the pressure turn**. These are point observations, not peaks, a capacity model, or an exec comparison. The injected arm's resumed process was about 102 MiB after thread loading/injection. Tool and parent memory are recorded separately in raw observations. **No RAM-parity claim is made.**

Docker, Colima, and Lima executables exist, but Docker's configured daemon socket is absent, `colima status` reports no running VM, and `limactl list --json` reports no instance. No VM was created or started and no remote Linux host was accessed. Linux steering/resume, write envelope, cancellation/EOF, parent death, escalation, and memory observations remain open. These research results also do not certify CC's production integration, queue/transcript semantics, instruction-state persistence races, or effective CC managed-skill/memory/plugin configuration.
