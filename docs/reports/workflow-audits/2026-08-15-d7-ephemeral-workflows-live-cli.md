# D7 ephemeral workflows live CLI verification

Date: 2026-08-15  
Project: `plc-test-lab-b`  
Session: `d7-live-ephemeral-0814`  
Origin conversation: `b6a13ee8-04b9-4b7d-916c-96163e7c390f` (ordinary Codex conversation)

All mutations below were issued either by that ordinary conversation through the real `cctl` binary or by the normal human workflow UI at `http://localhost:3001`. Reads used the same production routes. No service-level fixture shortcut launched, approved, rejected, abandoned, or edited an execution.

## Positive lifecycle and result evidence

| Check | Execution | Evidence |
| --- | --- | --- |
| Detached launch, required/default inputs, declared output | `0a5deb21-bd14-4021-a101-688f7977a7f5` | One-off `D7 declared result 0814-A`; required input `REQ-D7-0814-A`; omitted default materialized as `DEFAULT-D7-0814-A`; terminal cursor `17`; declared `emit-markers` output preserved both values. |
| Wait, needs-attention cursor, approve | `4b4e9eb6-61e2-4f93-bee0-0ae2be69167a` | Wait returned `awaiting_definition_approval`, boundary `definition_approval`, cursor `23`; a 100 ms reattach returned the exact continuation command; human UI POSTed `/approve-definition` with this execution id; reattach completed at cursor `35` with `APPROVED-D7-0814-B`. |
| Reject by id | `7ca6e5a3-802a-483e-848d-e1c4824a83b0` | Wait parked at cursor `41`; human UI POSTed `/reject-definition` with this execution id; reattach reached terminal cursor `43`, `definition_rejected`, with no context start. |
| Resumable halt and explicit abandon | `f99d81e7-d42e-420f-a7f4-81cf5d384a2a` | Cursor `64` carried `loop_limit_reached`, pass/max `1/1`, unsatisfied verdict, and resume action. The origin conversation ran `workflow abandon` with reason `D7 live resumable halt cleanup 0814-D`; the archived record retains the actor and reason. |
| No declared result | `df686993-d193-4e57-96d1-c8960992da02` | Terminal cursor `98` projected `no_declared_structured_result`; the isolated lane completed normally. |
| Oversized output | `8b006993-cdd3-4bf6-933b-81d2e1bf1d4a` | Terminal projection replaced the 70,000-character blob with a scoped `output_reference` and retained marker `OVERSIZED-D7-0814-F`; the by-id production API recovered the full 70,000 lowercase `x` characters. |

Execution A completed while the origin conversation was awaiting and did not wake an agent turn. The next ordinary prompt received the transient result block and both markers; the following prompt did not receive it again. The durable delivery row is `delivered`, has `attempt_count=1`, and uses boundary cursor `17`, which is also durable event id `17`.

## Negative and isolation evidence

- Lane nesting: outer execution `a6a7b627-06d6-48f7-9c99-99da7f3068e9` attempted a nested one-off launch from its workflow lane. The inner command exited `1` with `workflow_nesting_refused`; no nested execution row was created.
- Concurrent lease loser: while `c3761c43-f5a5-4f4d-87bf-44fe90733f6c` held the session lease at definition approval, non-origin conversation `44687f09-df88-4bf9-868b-31ff3f2e4e0a` received `lease_held` with the incumbent id, origin conversation, remedy, and deep link.
- Non-origin mutation: the same non-origin conversation attempted `workflow live abort --reason ...` and received exit `1`, `non_origin_principal`, naming the origin conversation as the authorized CLI actor.
- Merge gate: the normal human session route POSTed `/api/projects/plc-test-lab-b/sessions/d7-live-ephemeral-0814/merge` while `c3761c43-f5a5-4f4d-87bf-44fe90733f6c` held the lease. It returned HTTP `409`, `GRAPH_WORKFLOW_ACTIVE`, the exact execution id and status, and remedy `approve_or_abort`. The execution was then explicitly rejected through the human UI.
- Dirty read-only admission: with only untracked `d7-dirty-marker.txt`, execution `93e328c4-82d6-4fea-84f6-d120a8f7da3a` launched and parked. Its by-id record reports `liveSessionReadOnlyPinned: true`; both launch and working snapshots resolve to `{ lane: "session", mode: "readOnly" }` and runtime lane `__session__`. A write-capable live-edit attempt was refused while the definition was parked. The human UI then explicitly rejected the execution.
- Dirty write-capable refusal: with that same single dirty path, launching the isolated/full-access no-result plan exited `1` with `uncommitted_changes`, `totalCount: 1`, and path `d7-dirty-marker.txt`. History remained at nine rows and Current remained empty, proving no refused row. The marker was then explicitly removed with `apply_patch`; targeted `git status` returned no line.
- Project scope: targeting real execution A as project `plc-test-lab` instead of `plc-test-lab-b` exited `2` with `Session not found`; the equivalent production by-id route returned HTTP `404`. The record was not resolved across the project boundary.

## Restart and durable store evidence

The managed Next.js server was stopped and restarted with `cctl dev stop nextjs` and `cctl dev ensure nextjs`; the returned URL remained `http://localhost:3001`. After restart:

- real `cctl workflow status <id> --json` recovered execution A as completed with its one-off origin, authored launch document, and owner conversation;
- it recovered execution D as halted with its durable abandonment actor and reason;
- it recovered dirty-pinned execution I as aborted with `liveSessionReadOnlyPinned: true`;
- the browser reloaded A's explicit deep link and rendered all nine History rows, both launch inputs, and the declared result.

Read-only SQLite queries against `.config/command-center.db` found:

- `9` archived rows and `0` active rows for the scratch session;
- every row has `origin.kind = one_off`, a self-contained `launchDocument`, and the server-recorded owner conversation;
- the D7 saved-workflow directory is absent and no D7 authored plan appears in scoped definition storage;
- `14` boundary delivery rows, all `delivered` with `attempt_count = 1`, and `0` rows with more than one attempt;
- execution A's delivery `boundary_seq = 17` joins exactly to `graph_workflow_events.id = 17` with event type `graph-workflow-boundary`.

All scratch leases were released only through explicit reject or abandon actions. No template, refused-launch row, synthetic definition, or hidden temporary definition was persisted.
