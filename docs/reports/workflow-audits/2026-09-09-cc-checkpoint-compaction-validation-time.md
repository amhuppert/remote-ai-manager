# Validation time breakdown — CC checkpoint compaction

Supplement to the [execution audit](2026-09-09-cc-checkpoint-compaction.md), based on execution `66d46f3f-ee11-4c6a-82d6-7931886cc950`. All figures describe that completed run, excluding later follow-up work.

## Answer

Validation was the largest measured command-time expense. At least one implementer-launched validation job was executing during **17h 51m 03s of the 32h 29m 19s implementer timeline: 54.9%**. That establishes validation activity, not 54.9% idle agents: several jobs ran in the background while implementers edited code, read sources or drove browsers.

**Scheduler queue delay was negligible: 3.725 seconds summed across all 907 implementer validation runs.** The longest individual delay was 115ms. Including automatic script gates and landing validation brings the total to 3.883 seconds across 988 runs. The time concentration was execution of broad tests, not scheduler admission.

The earlier audit's six-hour background-wait figure covered explicitly recorded post-turn waiting only. It did not include every synchronous validation call or wait inside an ongoing agent turn, so it was not a total for validation.

## Implementer command execution

These are per-run **execution sums** from durable `validation_runs.exec_ms`. They include startup, filesystem work, OS scheduling and execution, and can overlap when multiple jobs run concurrently. They are not CPU time or a sum of idle-agent time.

| Command | Runs | Cumulative execution | Mean per run | Cumulative scheduler delay |
| --- | ---: | ---: | ---: | ---: |
| `test` | 546 | 16h 51m 15s | 1m 51s | 2.026s |
| `typecheck` | 143 | 1h 16m 55s | 32s | 0.741s |
| `lint` | 77 | 0h 20m 22s | 16s | 0.333s |
| `format` | 66 | 0h 11m 13s | 10s | 0.328s |
| `seams` | 75 | 0h 06m 48s | 5s | 0.297s |
| **Total** | **907** | **18h 46m 33s** | — | **3.725s** |

Removing overlaps gives **17h 51m 09s** of calendar time with an implementer validation running, almost entirely inside the implementer timeline. Approximately 55m 23s of the raw execution sum is overlapping job time and cannot be counted twice against the clock.

### The expensive distinction was test scope

| Test scope | Runs | Cumulative execution | Mean per run |
| --- | ---: | ---: | ---: |
| Explicitly narrowed tests | 484 | 1h 04m 23s | 8s |
| Broad `--scope changed` | 57 | 13h 27m 27s | 14m 10s |
| Full suite | 5 | 2h 19m 25s | 27m 53s |

The **62 broad runs**—57 changed-scope runs without explicit path narrowing and five full suites—consumed **15h 46m 52s**, or **84.1% of all implementer validation runtime**. The 484 explicitly narrowed runs together took 1h 04m 23s. Narrowed does not necessarily mean exactly one test file; this classification uses `scoped_path_count > 0`, not an assumption about the runner's matched test count.

The longest implementer validation was a broad changed-scope UI test run at **43m 21s** (`vrun-95cd564b-cfb2-4ea6-9d88-b2b1228c6aa7`). The baseline full suite took **38m 53s** (`vrun-292c4e94-2e6d-4e95-b18a-ca67456e017a`). Scope choice and repeated broad execution explain the long tail; the average across all 546 test runs conceals it.

These counts include intended failing tests in the red/green loop, genuine regression failures, cancellations and infrastructure timeouts. A failed run is not automatically waste. This evidence supports preserving fast targeted tests while reducing unnecessary overlapping or repeated broad runs, with full checks at meaningful integration boundaries.

## Where the implementer timeline overlapped validation

Each row intersects that context's actual prompt/follow-up-to-completion intervals with its validation job start/finish intervals. A job launched by that implementer is counted once at each instant even if several checks overlap. The percentage is **validation running**, not a measurement that the agent was inactive.

| Context | Implementer timeline | Validation executing within it | Share | Broad test runs |
| --- | ---: | ---: | ---: | ---: |
| `checkpoint-storage` | 2h 34m 17s | 1h 36m 17s | 62.4% | 9 |
| `checkpoint-seed` | 1h 22m 23s | 0h 42m 37s | 51.7% | 4 |
| `checkpoint-maintenance` | 3h 11m 23s | 1h 30m 14s | 47.1% | 8 |
| `checkpoint-restart` | 2h 37m 00s | 1h 15m 28s | 48.1% | 4 |
| `checkpoint-delivery` | 2h 41m 08s | 1h 21m 30s | 50.6% | 5 |
| `checkpoint-history` | 1h 39m 44s | 1h 01m 10s | 61.3% | 4 |
| `checkpoint-http` | 1h 43m 15s | 0h 49m 21s | 47.8% | 3 |
| `checkpoint-cli` | 3h 45m 51s | 2h 29m 20s | 66.1% | 8 |
| `checkpoint-ui` | 5h 27m 37s | 3h 52m 26s | 70.9% | 10 |
| `backend-continuation-probes` | 5h 07m 36s | 2h 22m 35s | 46.4% | 5 |
| `release-verification` | 2h 19m 04s | 0h 50m 05s | 36.0% | 2 |

UI was most affected, with validation executing during roughly 71% of its implementer timeline. CLI was next at 66%. Release verification spent a smaller share on registered checks because substantial time went to real browser journeys, integration fixes and provider-backed activity.

The existing workflow logs separately record **6h 03m 00s of explicit background waiting**. Of that, **5h 29m 29s coincided with implementer validation execution**. The other roughly 33m 30s had no recorded validation job running; it must not be labeled validation compute. It includes other background work and monitor settlement, with the backend-probe context accounting for most of that difference. Background waits are already inside the implementer timeline and must not be added on top of the 17h 51m overlap figure.

## Automatic checks after implementation

The workflow also launched 75 script-gate commands and six landing commands. These are separate from the 907 implementer commands above.

| Automatic command | Runs | Cumulative execution | Cumulative scheduler delay |
| --- | ---: | ---: | ---: |
| `test` | 9 | 1h 42m 30s | 0.017s |
| `typecheck` | 35 | 0h 09m 27s | 0.075s |
| `lint` | 1 | 0h 00m 04s | 0.002s |
| `format` | 1 | 0h 00m 08s | 0.003s |
| `seams` | 35 | 0h 02m 23s | 0.061s |
| **Total** | **81** | **1h 54m 32s** | **0.158s** |

Script gates account for **1h 18m 31s**, and landing commands account for **36m 01s**. Their enclosing workflow phases are slightly longer because they also contain dispatch, reporting and bookkeeping. Across all sources, validation consumed **20h 41m 05s of summed job execution** or **19h 45m 41s of elapsed time with any validation running**. The latter is about 53.7% of the full 36h 47m execution wall clock.

Agent validators—the models issuing GO/NO-GO—are separate again. Their attempt envelopes took **2h 16m 10s**, including approximately 43m 27s in two failed infrastructure attempts. They are not included in the command tables.

## What the queue numbers do and do not mean

For every one of the 988 selected rows:

- `queue_ms` exactly equals `started_at - submitted_at`.
- `exec_ms` exactly equals `finished_at - started_at`.
- Start, finish and duration fields are present; none of the selected runs remains queued/running.

Apparent tool-call waiting can occur **before submission**. In transcript `4eba42e7-52c1-42b8-8d25-00dcabd9b5f5`, tool calls 108/109/111/112 request typecheck/lint/seams/format around 07:05 UTC, but the corresponding jobs only start around 07:33. For example, `vrun-8d2e80c6-1945-4652-a2d6-603727fc8621` starts at 07:33:08.082, runs for 26.244s, and records only 6ms of scheduler delay. The tools were pending behind earlier work; counting their entire apparent 28-minute residence as either typecheck execution or validation-queue delay would be wrong. Compound commands, asynchronous launches and batch-delivered tool results prevent a reliable exhaustive split of active coding versus idle tool waiting from transcript timestamps alone.

No selected job waited even one second for scheduler admission. The scheduler's recorded queue therefore did not cause the hours of waiting in this run. A command can still run slowly because of competing workers, filesystem activity or memory pressure after admission; that time is included in execution duration. The prior audit found examples of memory contention, but this supplement does not attribute all slow test time to that cause.

## Sources and reproduction

The [timing companion](2026-09-09-cc-checkpoint-compaction.validation-time.json) records source and command aggregates, per-context interval intersections, the slowest runs, and exact method limits. The complete extracted row set is retained in `.cc/temp/checkpoint-audit/validation-runs.json`; the durable primary source is the live instance's SQLite table, opened read-only.

```sql
SELECT source, command_name, COUNT(*) AS runs,
       SUM(exec_ms) AS execution_ms,
       SUM(queue_ms) AS queue_ms,
       MAX(queue_ms) AS longest_queue_ms
FROM validation_runs
WHERE workflow_execution_id = '66d46f3f-ee11-4c6a-82d6-7931886cc950'
GROUP BY source, command_name;
```

The source partition is `agent_cli`, `graph_script_validator`, and `graph_lane_merge`. All implementer conversation IDs match the execution audit's 36 conversations. Interval unions use each row's timestamps; implementer intervals come from the recorded `iteration.prompt_sent` / `iteration.follow_up_sent` and `iteration.agent_turn_completed` pairs under the execution's workflow logs. Values are rounded only for display.

The practical optimization target is the frequency and cost of broad test runs, followed by dependable background-job completion. The registered scheduler queue needs no latency fix on the strength of this execution.
