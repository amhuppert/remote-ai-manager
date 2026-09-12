# Cursor task execution and continuity — ticket #115

Date: 2026-09-11. Provider baseline: `@cursor/sdk` 1.0.28 on macOS arm64.

## Delivered behavior

The registered Cursor task facet runs through `CursorConversationRuntime` and the existing supervised worker. It supports nongoverned `standard` and `isolated-one-shot` tasks. Complete model selections are validated against the production catalog before worker startup. Tasks carry images, per-call instructions, portable MCP configuration, projected transcripts, token usage, normalized failures, and cancellation/timeout dispositions.

Standard tasks return an opaque continuation envelope binding the provider agent to a UUID task store, working directory, and optional trusted CC scope. Recovery requires that the caller has persisted a returned envelope; the task interface provides no receipt for recovering an initial call killed before it returns, and this change does not claim exactly-once retry for that case. Recreated runners use the same store and start fresh workers. Isolated tasks ignore supplied continuation, CC scope, managed capabilities and MCP configuration; they pass an empty provider tool allowlist, return no continuation, and remove their task store after verified worker teardown.

Production continuity resolves persisted conversation identity and session cwd through the CC state store. `start`, `validate`, and `resumeOrRecover` use that conversation's owned Cursor store. Task envelopes resolve their separate task stores. Ordinary conversation callers must provide `conversationId` and complete `modelSelection`; task probes must also supply their bound cwd and, for scoped tasks, conversation/session identity. Missing identities fail before worker startup. Probes refuse a live worker slot and bound attachment time.

Cancellation during attachment now settles, including cancellation racing worker startup. Silent attachments time out. A disabled inactivity bound no longer creates an immediate timer. Failed teardown and failed isolated-store deletion are reported as task failures. Malformed task envelopes produce a bounded corrupt-ref verdict without spawning.

Structured output is prompt-based and validated/repaired through the existing agent-call facade. The facet declares `post_validation`, not native schema enforcement. Instructions have user-message priority. Governed execution, privileged instructions, exact filesystem envelopes, and unsupported standard-task sandbox/network/search/approval policies remain refused.

## Behavior-level validation

Registered, file-scoped red/green reproductions cover attachment cancellation, silent attach, inactivity disabling, malformed refs, model refusal, instruction delivery on continuation, image forwarding, startup cleanup races, and isolated-store cleanup errors. Shared backend conformance drives the actual task adapter through injected worker ports, including meaningful output, structured-output prompting, cancellation, and provider failures.

The focused tests also exercise shared structured-output repair through fresh isolated tasks; continuation to the same owned store; rejection of cross-cwd/scope refs; transcript event deduplication; real SQLite conversation/session readback; live-slot protection; and admission before runner resolution. Negative command-admission fixtures explicitly remove the task facet instead of assuming Cursor lacks it.

Key registered runs:

| Check | Evidence |
| --- | --- |
| Task adapter, 24 tests | `vrun-18f2feb8-f4fd-4cd7-8870-bdf92d73ea4f` |
| Continuity, 24 tests | `vrun-ff0f4a16-3cd5-4ccd-b4fa-5d1d986e472a` |
| Shared backend conformance | `vrun-ef7d36c1-0132-4383-8716-861a604b49ee` |
| Command and conversation-actor admission regression files | `vrun-b1455ee6-332b-4eb6-b085-cbff31524313` |
| Full-project typecheck | `vrun-c4c4d671-1620-492e-bada-59a66e95ad05` |
| Formatting | `vrun-e0f59acf-bdfe-4bc0-835d-c734cc08dbcf` |
| Lint | `vrun-df41742c-8388-484d-a28f-47e41c926a15` |
| Architecture seams | `vrun-59ce9771-ab57-4ef0-aa3c-f0ecc9c13bd8` |

The taskless-backend and command fixtures passed in `vrun-264e5b5c-1267-4523-b8be-1daea0b2cd13`; naming/compaction UI fixtures passed in `vrun-738cd1f4-61be-4deb-b9b9-05121ac9a8fa`; collaboration and workflow eligibility fixtures passed in `vrun-b856e2bf-62af-4c9b-bd34-10f3d34e0798`. The complete affected-test run passed: `vrun-28945cee-af44-48cf-9c32-be33510a3c52`. Its receipt is `.cc/temp/changed-tests-final-pass.log`.

## Authenticated verification

The final authenticated run passed all seven tests across two files in 108.59 seconds, using Composer 2.5 with `fast: "true"`. The branch's worker and adapter run against the authenticated SDK in scratch workspaces and stores. These cases use real provider calls and OS process-group checks:

- A standard task stores a unique marker, persists its continuation to disk, and recalls the marker through a recreated runner and different worker. Prior output is not replayed. Continuity validate/recover probes accept the task ref against its owned store.
- An isolated task asked to write a file instead computes a structured answer without tool events or the requested file. Its store is deleted and no ref is returned.
- Cancellation after the provider accepts input settles and leaves no worker process group.
- Actual shell tool output contains the trusted CC project, session and conversation identity. Worker environments are read from the OS and contain no `CURSOR_API_KEY`.
- A separate parent process starts a continued task, is killed after input acceptance, and its worker self-reaps. Another runner resumes the persisted task and recalls the earlier marker without replaying the unfinished turn's requested completion.
- The existing live MCP checks negotiate and invoke the deterministic stdio tool, and verify cancellation cleans up the worker and MCP process group.

The registered validator inventory exposes no authenticated Cursor command. The narrow local diagnostic therefore invokes this worktree's credential-gated wrapper directly, with explicit files and scratch temp storage:

```sh
TMPDIR="$PWD/.cc/temp" scripts/validate/cursor-acceptance.sh \
  src/lib/agent-backends/cursor/acceptance/task-runner.acceptance.test.ts \
  src/lib/agent-backends/cursor/acceptance/mcp.acceptance.test.ts
```

The wrapper and launcher accept file filters. The live output is `.cc/temp/live-closeout.log`; raw task results, MCP events, artifact hashes and per-case receipts are under `.cc/temp/cursor-acceptance/`. The installed CC server is prebuilt and is not evidence that branch changes have been deployed.

## Provider limits and scope

**Shell startup can reload host credentials.** An authenticated diagnostic in `.cc/temp/live-final.log` asked a normal task to print a marker only if `CURSOR_API_KEY` was absent. The stored shell result printed the correct CC identity but omitted that marker. The model mentioned the marker in its explanation, so searching only final text would have produced a false pass. SDK 1.0.28's shell implementation captures interactive login-shell state (`zsh -ilc`), which can reload host startup files after CC strips inherited credentials. The final test asserts actual tool output and the separate worker environment. It does not claim credentials cannot enter an unrestricted shell through host configuration. No credential value was requested or recorded by this diagnostic. A stronger shell credential boundary requires controlling shell initialization/execution; it is not proven by the existing worker environment filter or this task facet.

**Provider memory cannot be disabled through the supported SDK options.** Isolated-one-shot applies the available settings, tools, capabilities, continuation and store controls; it does not claim provider-side memory isolation or exact filesystem/network confinement. The descriptor's existing native-memory limitation remains in place.

This work delivers the execution primitive and accurate admission. It does not establish application-wide auxiliary, workflow, collaboration, or cross-platform parity. Existing generic consumers follow task-facet admission automatically; their full application matrix belongs to the dependent tickets. No governed execution guarantee is registered.
