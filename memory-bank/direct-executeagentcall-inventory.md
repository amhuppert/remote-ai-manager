# Direct `executeAgentCall` callers (outside conversation actor)

Descriptive snapshot of every production call site of `executeAgentCall` outside `src/lib/workflows/conversation/`. Test files are excluded. Bypass column refers to the conversation lifecycle triad: `appendTranscriptEntry` + SSE `message-appended` broadcast + `acquireConversationLock`.

| File | Line | Kind | Structured output schema | Backend | Bypasses lifecycle? | Status |
|---|---|---|---|---|---|---|
| `src/lib/sessions/conflict-resolution.ts` | — | `task_run` | `CONFLICT_ENTRIES_OUTPUT_SCHEMA` (passed via `outputFormat` to the conversation actor) | session's `agentBackend` (dynamic via conversation actor) | No | **Migrated** — routes through `executeWorkflowTaskRun` for both resolve (write) and analyze (read) paths. |
| `src/lib/workflows/validation-fix.ts` | — | `task_run` | none | session's `agentBackend` (dynamic via conversation actor) | No | **Migrated** — routes through `executeWorkflowTaskRun`; retry behaviour driven by `isRetry: boolean` flag (the conversation actor preserves its own backend ref across calls). |
| `src/lib/workflow-graph/planner.ts` | — | `task_run` | none (planner consumes out-of-band MCP draft) | session's `agentBackend` (dynamic via conversation actor) | No | **Migrated** — already routes through `executeWorkflowTaskRun`. |
| `src/lib/workflow-graph/validator-runner.ts` | 492 | `task_run` | `VALIDATOR_OUTPUT_SCHEMA` | dynamic: `invocation.backend` (`claude` or `codex`) | Yes | **Documented (not migrated).** See justification below. |

## Notes

### validator-runner.ts — direct `executeAgentCall` retained

The validator runner remains the sole direct caller of `executeAgentCall` and is intentionally kept off the conversation actor path. Justification:

1. **Backend selection is request-level, not session-level.** Each validator invocation chooses its own backend from the `invocation.backend` field (resolved upstream from `validatorType: "claude" | "codex"`), independently of the parent session's `agentBackend`. The conversation actor binds to the session's backend; a validator dispatched against the same session may need a different backend per turn.
2. **Custom `validateStructuredOutput` override.** Validator parses fenced JSON, raw JSON, and structured output via `parseValidatorResponse`. The post-dispatch structured-output gate inside the conversation actor would conflict with this resilient parsing — the validator deliberately bypasses the facade gate with `validateStructuredOutput: () => ({ valid: true })` and relies on `outputSchema` forwarding to enforce the schema at the runner level.
3. **`laneRef` continuity service.** Validator turns carry `laneRef: { workflowId, laneId }` for cross-lane backend reuse via `continuity-service`. The conversation actor's task-run entrypoint targets a session conversation, not a workflow lane — funnelling validator turns through it would require introducing a parallel lane-keyed dispatch path.
4. **Operates outside session conversations.** Validators run as part of a graph workflow lane and write into `validator-output-registry` / lane state; they are not part of a session conversation's transcript. Forcing them through `executeWorkflowTaskRun` (which requires a `conversationId`) would either pollute an unrelated conversation transcript or require synthesising one purely for the dispatch.

The remaining bypass of the lifecycle triad is acceptable because validator turns are never user-visible transcript entries — they are workflow-internal RPCs whose state lives in the lane execution graph.

### Other notes

- **`conflict-resolution.ts`** wraps its conflicts array under a `conflicts` object property because the Anthropic tool `input_schema` requires `type: "object"` at the root. The schema is now passed as `outputFormat: { type: "json_schema", schema: CONFLICT_ENTRIES_OUTPUT_SCHEMA }` to `executeWorkflowTaskRun`.
- **`validation-fix.ts`** previously took an `AgentSessionRef` through its result + input to keep the SDK conversation pinned across retries. That mechanism is gone: the conversation actor stores its own `backendRef` between turns, so the merge machine now only passes `isRetry: boolean` for prompt selection.
- The merge machine resolves the session's most-recently-active conversation (`getSessionConversations[0].id`) and dispatches the conflict-resolution / validation-fix turns against that conversation. Trade-off: those turns pollute the feature conversation's transcript. Accepted as simpler than provisioning a dedicated merge-internal conversation.
