# Codex `outputFormat` / `structuredOutput` Parity Audit

Audit of how the Codex backend handles the `outputFormat` option compared to the Claude backend, ahead of the planned P7 finalizingTurn gate that uses non-null `turn.structuredOutput` as the success condition for debug-mode phase advancement.

## Claude reference path

1. Conversation machine resolves `outputFormat` per turn:
   - `src/lib/workflows/conversation/machine.ts:271-298` — `executing.invoke.input` reads `context.activeTurn?.outputFormat` first, falls back to `getDefaultDebugAdapter().resolveOutputFormat(context.debugMode?.phase)`.
2. Forwarded into the backend factory:
   - `src/lib/workflows/conversation/actor-implementations.ts:1249` — `factory.createRuntime({ ..., outputFormat: input.outputFormat })`.
3. Stored on the Claude runtime:
   - `src/lib/agent-backends/claude/conversation-runtime.ts:80-82` — `readonly outputFormat: { type: "json_schema"; schema: Record<string, unknown> } | undefined`.
   - `src/lib/agent-backends/claude/conversation-runtime.ts:108` — `this.outputFormat = opts.outputFormat`.
4. Passed to the `query()` SDK call as part of `Options`:
   - `src/lib/agent-backends/claude/query-session.ts` builds SDK options with `outputFormat`, verified by tests at `src/lib/agent-backends/claude/query-session.test.ts:835-871` ("passes outputFormat to SDK Options when provided").
5. Captured from the SDK result message — **schema-validated by the SDK**:
   - `src/lib/agent-backends/claude/query-session.ts:646-648`:
     ```ts
     if (resultMsg.subtype === "success") {
       const success = resultMsg as SDKResultSuccess;
       turn.structuredOutput = success.structured_output;
     }
     ```
   - On validation exhaustion the SDK emits `subtype: "error_max_structured_output_retries"` (test: `query-session.test.ts:521-554`), which is converted to `error` and leaves `structuredOutput` undefined.
6. Surfaced on the conversation-level result:
   - `src/lib/agent-backends/claude/conversation-runtime.ts:241,450` — `structuredOutput: turnResult.structuredOutput`.
   - `src/lib/workflows/conversation/actor-implementations.ts:1579` — `structuredOutput: turnResult?.structuredOutput` becomes `PromptActorResult.structuredOutput`, then `context.lastResult.structuredOutput` per `src/lib/workflows/conversation/machine.ts:303`.

## Codex equivalent path

1. Same machine resolution and same `ExecutePromptInput.outputFormat` as Claude (shared at `src/lib/workflows/conversation/machine.ts:271-298`).
2. Same forwarding in `actor-implementations.ts:1249` — backend-agnostic.
3. Stored on the Codex runtime:
   - `src/lib/agent-backends/codex/conversation-runtime.ts:104-106` — `readonly outputFormat: { type: "json_schema"; schema: Record<string, unknown> } | undefined`.
   - `src/lib/agent-backends/codex/conversation-runtime.ts:132` — `this.outputFormat = input.outputFormat`.
4. Passed to the Codex SDK as `outputSchema` on `runStreamed`:
   - `src/lib/agent-backends/codex/conversation-runtime.ts:197-202`:
     ```ts
     const streamed = await thread.runStreamed(promptInput, {
       signal: input.signal,
       ...(this.outputFormat ? { outputSchema: this.outputFormat.schema } : {}),
     });
     ```
5. Captured **without schema validation** by `JSON.parse` of the last `agent_message` text:
   - `src/lib/agent-backends/codex/conversation-runtime.ts:269-277`:
     ```ts
     let structuredOutput: unknown;
     if (this.outputFormat && acc.lastAgentMessageText) {
       try {
         structuredOutput = JSON.parse(acc.lastAgentMessageText);
       } catch {
         // Not valid JSON despite outputFormat being set
       }
     }
     ```
   - `acc.lastAgentMessageText` is set by `processEvent` via the `setLastAgentMessageText` callback at `src/lib/agent-backends/codex/conversation-runtime.ts:212-214`.
6. Surfaced on the same `ConversationBackendTurnResult.structuredOutput` field:
   - `src/lib/agent-backends/codex/conversation-runtime.ts:283-294` — `structuredOutput` is included in the result object returned from `sendTurn`.
   - From there, the identical actor-implementations forwarding at `src/lib/workflows/conversation/actor-implementations.ts:1579` lifts it into `PromptActorResult.structuredOutput`.

(Note: `src/lib/agent-backends/codex/task-runner.ts:207,234-241,281` mirrors the same JSON.parse approach but is the standalone task path, not part of the conversation flow.)

## Verdict

**PARITY at the contract level — with one validation-strictness gap that callers must understand.**

Both backends:

- Accept the same `outputFormat: { type: "json_schema"; schema }` shape from `ExecutePromptInput`.
- Forward it to their underlying SDK as the schema instruction (Claude `outputFormat`, Codex `outputSchema`).
- Surface results on the same field — `ConversationBackendTurnResult.structuredOutput` → `PromptActorResult.structuredOutput` → `context.lastResult.structuredOutput`.
- Produce a nullish (`undefined`) `structuredOutput` when the agent fails to return a usable structured response.

The gap is in **how strictly the structured response is validated**:

| Aspect | Claude (`query-session.ts:646-648`) | Codex (`conversation-runtime.ts:269-277`) |
|---|---|---|
| Validation | Anthropic SDK validates against the JSON schema; only schema-valid output appears as `success.structured_output`. | None. Last `agent_message` text is `JSON.parse`d — any parseable JSON becomes `structuredOutput`, even if it does not match the schema. |
| Failure surface on schema-exhausted retries | Result subtype `error_max_structured_output_retries` → returned as `error` string; `structuredOutput` is undefined. | No equivalent. A non-JSON / schema-divergent reply produces `structuredOutput === undefined` with `error === null`. |
| Failure surface on parse failure | N/A (SDK has already parsed). | `try { JSON.parse(...) } catch {}` swallows silently — `structuredOutput === undefined`, `error === null`. |

## Implications for P7

A guard of the form `context.lastResult?.structuredOutput != null` is **safe to use as the debug-mode phase-advancement gate for both backends**: both produce a nullish value precisely when the structured contract was not honored, regardless of the underlying mechanism (SDK retry exhaustion vs. JSON.parse failure vs. agent omitting JSON entirely).

What the P7 gate should be aware of:

1. **No backend-capability flag is required** for the basic "did we get structured output?" check. The field is populated identically and absent identically.
2. **Codex can produce a parseable JSON object that does not match the schema.** With Claude this is impossible (SDK validates). If a downstream consumer of `structuredOutput` (e.g. `shouldLoopBackToHypothesizing` at `src/lib/workflows/conversation/machine.ts:96-100`, which casts to `DebugEvidenceAnalysisOutput`) relies on a specific shape, it must defensively `safeParse` the value with the corresponding Zod schema rather than trusting the cast — otherwise a malformed Codex reply could send the machine down a non-sensical branch.
3. **Codex surfaces a "no structured output" failure as silent absence**, not as a non-null `error`. A Codex-driven conversation that lands in `finalizingTurn` with `structuredOutput == null && error == null` should be treated as a debug-mode failure (e.g. retry, surface to user), not as a successful turn. The P7 finalizingTurn guard should not require both `structuredOutput != null` *and* `error == null` — the `structuredOutput != null` half is the single load-bearing condition for both backends.
4. **Suggested defensive pattern (no implementation in this audit):** when a debug phase consumes `lastResult.structuredOutput`, run `<phaseSchema>.safeParse(structured)` before acting on it. If the parse fails on the Codex backend, the gate should treat it identically to a missing structured output, since the backend cannot guarantee schema conformance. This keeps the gate backend-agnostic without introducing a capability flag.

In short: for the P7 finalizingTurn guard the two backends are interchangeable, but downstream code that relies on the *shape* of `structuredOutput` (already happens at `machine.ts:96-100`) is not yet defensive against the Codex-only "parseable but non-conforming" case. That is a follow-up worth tracking, but not a blocker for the gate itself.
