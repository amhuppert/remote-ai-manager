# Claude Structured Output: CC-Native Transport — Design & Implementation Plan

**Date:** 2026-07-23
**Ticket:** `command-center#18` — Explore Claude structured output reliability improvements
**Decision:** Option B (approved by Alex 2026-07-23) — Claude moves to a CC-owned
prompted-JSON transport with post-validation and a bounded repair turn; Codex keeps
native enforcement. No Kiro spec; this document is the design of record.
**Evidence base:** incident report
`.cc/tickets/18/files/78e40738-…-2026-07-22_claude-collaboration-structured-output-failure.md`,
installed `@anthropic-ai/claude-agent-sdk` 0.3.170, and the code survey in §3.

---

## 1. Problem

The Claude Agent SDK implements `outputFormat: { type: "json_schema" }` by making the
model call a synthetic `StructuredOutput` tool inside the Claude Code CLI. This
transport has a structural failure class that Command Center cannot tune or rescue:

- The model can serialize the tool arguments incorrectly (the incident showed
  XML-like parameter markup collapsing four fields into one), even when the intended
  content is correct and passes CC's authoritative Zod schema.
- The CLI's internal retry loop (5 attempts) is **not configurable or disableable**
  from the SDK surface; the only exposed knobs are the `outputFormat` option and the
  terminal `error_max_structured_output_retries` result subtype. All retries reuse
  the same session, context, tool protocol, and lossy feedback, so they are
  correlated — more retries repeat the same defect.
- On exhaustion the turn fails **with no text output**, so CC's fall-through
  extraction (`native → raw_json → fenced`) has nothing to salvage. The whole lane
  result is lost even when the substantive artifact is already on disk
  (incident: ~$1.04 burned in the failed formatting stage alone).
- Native enforcement is not constrained decoding — it validates *after* free-written
  tool arguments. It also accepts only a JSON Schema subset, which is why
  `projectSchemaForClaude` and its keyword-hazard inventory exist at all: keywords
  like `minLength`/`minItems` are validated but not steered, turning an unprojected
  schema into a guaranteed retry loop.

Codex's path (schema → `--output-schema` → final-response JSON) has no tool-call
envelope and no observed failures. The reliability gap is architectural, not a model
capability difference.

## 2. Decision, goals, non-goals

**Decision.** Remove the `outputFormat` handoff to the Claude Agent SDK entirely.
Claude requests structured output through a CC-owned contract: the adapter renders
the schema into the prompt, the model's final text is the transport, the existing
extraction + validation pipeline accepts it, and a single bounded corrective turn
repairs validation failures with precise, named feedback. The difference from Codex
is expressed through the existing `StructuredOutputSupport` capability
(`"post_validation"` vs `"backend_native"`), which the architecture already models
and neutral callers already select behavior from.

**Goals**

1. Eliminate the `StructuredOutput` tool-call transport and its failure class.
2. One CC-owned pipeline (request → dispatch → extract → validate → repair) shared
   by all consumers; backend-native enforcement remains an optional accelerator
   declared by capability, never a correctness dependency.
3. Failure becomes cheap and recoverable: one corrective turn with named Zod/gate
   issue paths, instead of 5 correlated in-turn resamples followed by total loss.
4. Delete the Claude wire-projection hazard class (`projectSchemaForClaude`, the
   unsupported-keyword list, the schema inventory guardrail).
5. Zero caller churn: consumers keep passing `outputSchema`/`outputFormat` through
   the same neutral request fields.

**Non-goals**

- Changing Codex's native enforcement (it stays; the shared gate already normalizes
  its outcome).
- Adopting the raw Anthropic SDK / Messages-API constrained decoding (requires an
  API key + separate billing outside the Claude Code session; revisit only if CC
  ever holds one).
- A runtime kill-switch/config flag for the transport. The flip is a one-line
  descriptor change plus adapter behavior, revertible by git; a config surface would
  be a compat shim (needs explicit approval per AGENTS.md, and none is requested).
- Reworking consumers' own outer retry/fallback policies (compaction's envelope
  loop, commit-message fallback). They remain as outer safety nets.

## 3. Current architecture (survey)

Three dispatch shapes request structured output today; all converge on the shared
extraction module `src/lib/agent-backends/structured-output.ts` and/or the facade
gate:

| Path | Consumers | How the schema flows | Post-turn validation |
|---|---|---|---|
| AgentCall facade (`workflows/primitives/agent-call-facade.ts`) | collaboration (two-pass format turn), graph-collab collaborator caller, workflow machine specs | `AgentCallRequest.outputSchema` → dispatch (`agent-call-task.ts` / `agent-call-conversation.ts`) → backend adapter | facade gate: `extractStructuredOutputCandidates` fall-through + `runStructuredOutputGate` (JSON-schema subset validator) |
| Conversation-actor task runs (`workflows/conversation/actor-implementations.ts`) | compaction (`context-artifacts/service.ts`, with its own outer feedback loop), commit/merge messages (`conversation-commands/service.ts`), ticket slash-command, debug schemas | `outputFormat.schema` mapped to `outputSchema` (actor-implementations.ts:819) → facade | facade gate + consumer Zod parse |
| Direct task-runner calls | agent runs (`agent-runs/service.ts`), ticket enrichment (`tickets/enrichment.ts`), graph validators (`workflow-graph/validator-runner.ts`), smart-merge conflict resolution (`sessions/conflict-resolution.ts`) | `getTaskRunner(backend)` → `runTask({ outputSchema })` | consumer calls `validateStructuredOutput(zodSchema, { native, text })` |

Backend adapters:

- **Claude** (`agent-backends/claude/task-runner.ts:188`,
  `conversation-runtime.ts:783` via `prompt/sdk-driver.ts`): `outputSchema` →
  `projectSchemaForClaude` → SDK `outputFormat` → synthetic tool → native retries →
  `structured_output` on the result, or `error_max_structured_output_retries`.
- **Codex** (`agent-backends/codex/task-runner.ts:494`): schema forwarded verbatim
  to `thread.run()`; `turn.finalResponse` parsed as JSON.

Already-existing pieces the design builds on:

- Extraction fall-through with sources `native → raw_json → fenced`
  (`structured-output.ts`) — text candidates are already first-class.
- The facade gate runs on **both** backends even when enforcement is native, so
  workflows already see one normalized outcome (`agent-call-facade.ts:497`).
- The descriptor vocabulary already includes `"post_validation"`
  (`descriptor.ts:54-61`); the conformance harness already conditions its
  native-forwarding check on `structuredOutput === "backend_native"`
  (`conformance.ts`).
- The two-pass work/format protocol gives every important schema a small dedicated
  formatting turn (`workflow-agent-caller.ts`, collaboration
  `agent-caller-production.ts:552`).
- Compaction already runs a CC-owned corrective loop with schema feedback
  (`context-artifacts/service.ts:455` — "Previous attempt rejected …"), proving the
  repair pattern in production.

## 4. Design

### D1 — Capability flip

`src/lib/agent-backends/claude/descriptor.ts`: both facets change
`structuredOutput: "backend_native"` → `"post_validation"` (conversation
capabilities, line 63; task facet, line 115). `capabilityViewFromDescriptor`
propagates this to `BackendCapabilityView.structuredOutputEnforcement` with no
further changes.

### D2 — Prompted-JSON transport in the Claude adapter

The adapter keeps its neutral contract — it accepts `outputSchema` and guarantees
the turn yields extractable JSON candidates — but changes *how* below the seam:

- **New neutral renderer** `src/lib/agent-backends/structured-output-prompt.ts`:
  `renderStructuredOutputInstruction(schema: Record<string, unknown>): string`.
  Deterministic output: a short contract preamble ("Your final message must be a
  single JSON object conforming to this JSON Schema. Output only the JSON object —
  no prose before or after it, no markdown fence required."), followed by the
  schema serialized with sorted keys inside a fenced block. The **full, unprojected
  schema** is rendered: `minLength`/`maxItems`/etc. become advisory generation
  signals (exactly what `docs/structured-data-responses.md` prescribes), while Zod
  and the gate keep enforcing them post-parse. The module is neutral (rendering
  JSON Schema to prose is not provider knowledge); the *decision to use it* is the
  Claude adapter's.
- **`claude/task-runner.ts`**: when `input.outputSchema` is present, do not build
  `outputFormat`; instead append the rendered instruction to the prompt as a
  clearly-delimited trailing section. Everything else (isolated one-shot mode,
  timeout, watchdog) is unchanged. `AgentTaskResult.structuredOutput` becomes
  `undefined` for Claude; the final text carries the payload and the existing
  extraction fall-through picks it up (`raw_json`, or `fenced` if the model wraps
  it).
- **`claude/conversation-runtime.ts` + `prompt/sdk-driver.ts`**: the runtime keeps
  accepting `outputFormat` in its create input — the runtime-identity logic in
  `actor-implementations.ts` (rebuild on `outputFormatChanged`, line 637) stays
  valid — but stops forwarding a projected schema to the query session. Instead the
  stored schema is rendered per turn and appended to the turn's prompt text.
- `mapErrorSubtype`'s `error_max_structured_output_retries` mapping stays as a
  defensive dead-letter (nothing in CC can trigger it after this change).

Why adapter-level rather than a neutral-layer branch: there are seven-plus neutral
dispatch sites (facade task/conversation, actor task runs, four direct-runner
consumers). Changing the two Claude adapter handoffs covers all of them with zero
caller churn, and keeps the Claude/Codex asymmetry below the backend seam exactly
where `.kiro/steering/agent-backends.md` requires it to live.

### D3 — Delete the wire-projection hazard class

Once D2 lands, no schema reaches the Claude wire, so the following are dead and are
removed in the same change series:

- `claude/structured-output-projection.ts` (module) and
  `claude/structured-output-projection.test.ts` (including the
  `CLAUDE_BOUND_SCHEMA_INVENTORY` guardrail),
- the re-exports `UNSUPPORTED_CLAUDE_STRUCTURED_OUTPUT_KEYWORDS` /
  `unsupportedStructuredOutputKeywordPaths` from
  `agent-backends/structured-output.ts:22-25`,
- the projection call sites in `claude/task-runner.ts` and
  `claude/conversation-runtime.ts`,
- the steering/docs rules that exist only to feed the inventory (see D9).

The "add every new Claude-bound schema to the inventory" maintenance obligation
disappears with it.

### D4 — Neutral repair primitive

New module `src/lib/agent-backends/structured-output-repair.ts`:

```ts
interface StructuredOutputRepairContext {
  schema: Record<string, unknown>;
  /** Bounded tail of the failed turn's text (the payload that failed the gate). */
  priorOutputText: string;
  /** Named validation issues from the gate/Zod ("$.artifacts is required", …). */
  issues: readonly string[];
}
buildStructuredOutputRepairPrompt(ctx): string;
```

The prompt is minimal and fresh-context by construction (incident recommendations
1, 2, 5): the contract instruction, the schema, the prior output, and the named
issues — including a "decoded keys were […]" style diagnostic when a candidate
parsed but missed required fields. It never resumes the large work context on the
task path.

Execution strategy differs by request kind (owned by the facade wiring, D5):

- `task_run`: the repair runs as a **fresh isolated one-shot** through the same
  resolved runner (`resumeRef: null`), so it is protocol-diverse and cheap.
- `conversation_turn`: the repair runs as **one corrective turn on the same
  runtime** (the session is not protocol-poisoned under prompted-JSON, the resumed
  prefix is mostly cache reads, and the runtime handle is what the dispatch layer
  has).

Default budget: **1 repair attempt**. It applies to any backend — a Codex native
failure that somehow passes dispatch but fails the gate gets the same rescue.

### D5 — Facade wiring and result metadata

`applyStructuredOutputGate` (agent-call-facade.ts:497) grows a repair stage:

1. Gate all candidates as today. On first pass → completed (unchanged).
2. On failure, if repair is enabled (default on; `AgentCallRequest` gets an
   optional `structuredOutputRepair?: { maxAttempts: number }`, default
   `{ maxAttempts: 1 }`), dispatch the corrective turn per D4, re-extract,
   re-gate.
3. On repaired success, the completed outcome carries
   `parse: { source, repaired: true, repairAttempts }` —
   `AgentCallStructuredOutputParse` in `agent-call-vocabulary.ts` is extended
   accordingly.
4. On repaired failure, return the existing `schema_validation` failure, enriched
   with `backendDetails`: candidate sources tried, top-level keys of the best
   candidate (keys only — no values, per log privacy), and repair attempt count.
   `failWithSchemaValidation` already preserves `transcript`, `contentBlocks`, and
   the top-level `artifacts` — a test pins that, which covers incident
   recommendation 4 (a manifest transport failure no longer discards evidence of
   completed work; already-written artifact files stay on disk and the failure
   names them via the preserved transcript/artifacts).

Direct-runner consumers (agent runs, enrichment, validator-runner,
conflict-resolution) are **not** migrated in this change: with Claude flipped, their
existing `validateStructuredOutput` text fall-through keeps working, and each has
its own fallback policy. Adopting `buildStructuredOutputRepairPrompt` there is a
cheap follow-up per consumer, listed as optional Phase 8.

### D6 — Diagnostics and classification

- Extend `agent_call.facade.structured_output_failed` log fields with
  `candidateSources` and `candidateTopLevelKeys` (bounded, keys only).
- New log events (per `.kiro/steering/logs.md` conventions, stable names,
  structured fields, no prompt contents):
  `agent_call.facade.structured_output_repair_attempted` /
  `…_repair_succeeded` / `…_repair_failed` with
  `{ backend, requestKind, attempt, issuePaths }`.
- `mapErrorSubtype` keeps the `error_max_structured_output_retries` branch; the
  Claude failure classifier gains an explicit classification for it (distinct,
  non-retryable-in-place) so any residual occurrence (e.g. a stale session started
  before deploy) is visible and attributable rather than a generic backend error.
  This satisfies incident recommendation 3 in spirit while the failure mode itself
  is being removed.

### D7 — Conformance updates

`agent-backends/conformance.ts` gains the mirror check for the other enum value:

- When a facet declares `structuredOutput: "post_validation"` and the harness
  supplies a structured-output drive, assert (a) the fake provider port received
  **no** native schema (`readForwardedSchema()` returns `undefined`), and (b) the
  dispatched prompt contains the rendered schema contract (the harness exposes the
  captured prompt).
- Update the Claude conformance harness to the new declaration; keep the
  lying-descriptor tests proving a backend that declares `post_validation` but
  forwards natively (or vice versa) FAILS the check.

### D8 — Docs and steering (same change, per AGENTS.md)

- `.kiro/steering/agent-backends.md` — rewrite the "Structured output" section:
  Claude = `post_validation` prompted-JSON transport (adapter renders the full
  schema into the prompt; nothing reaches the SDK wire); Codex = `backend_native`
  verbatim schema; Zod remains authoritative; delete the projection/inventory
  rules; document the repair stage as part of the neutral pipeline.
- `docs/structured-data-responses.md` — rewrite "Backend Enforcement
  Compatibility" (the unsupported-keyword hazard no longer exists at the wire;
  bounds-in-descriptions guidance remains as the advisory-signal rationale) and add
  a short "Repair turn" subsection to the Failure Model.
- `CONTEXT.md` only if its vocabulary references native Claude enforcement (check
  during implementation).

## 5. What does not change

- Codex adapters, byte for byte.
- The extraction module and its precedence semantics.
- Caller-facing request contracts: `outputSchema` (facade/task) and
  `outputFormat.schema` (actor/runtime create input) keep their shapes.
- The two-pass work/format protocol and its single-scheduler-acquisition property.
- The gate as the single normalized validation outcome for workflows.
- Consumers' outer fallbacks (commit default message, compaction envelope loop).

## 6. Alternatives rejected

- **A. Keep native + protocol-diverse fallback** (incident report's minimal fix):
  still pays 5 correlated in-SDK retries per failure before recovery starts, and
  leaves three mechanisms to maintain (native transport, fallback, gate).
- **C. CC-native for Codex too**: deletes almost nothing (Codex has no projection;
  its parse is one `JSON.parse`) while giving up the only transport with zero
  observed failures. The seam already hides the asymmetry from callers.
- **D. Raw Anthropic SDK `messages.parse()` (true constrained decoding)**: needs an
  API key and a second SDK/billing/auth path outside the Claude Code session CC
  runs on. Revisit only if that constraint changes.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| First-attempt invalid JSON where native would have succeeded | Failures are now cheap, uncorrelated, and repaired by one corrective turn with named issues; format turns are small by the two-pass design. Commit/compaction/validator schemas already succeed as text via fall-through today when native output is absent. |
| Model emits prose around the JSON (raw parse fails, no fence) | The instruction mandates only-JSON; extraction also accepts fenced output; the repair turn catches the residue. If logs show a persistent tail, extend the extractor with a first-balanced-object heuristic as a follow-up — not in scope now. |
| Prompt token cost of inlined schemas | Schemas are small manifests by policy (`structured-data-responses.md`); cost is comparable to what the SDK sent as the native system schema. |
| Compaction's outer loop + facade repair stack | Acceptable nesting: the inner repair simply makes the outer loop fire less. No interference — both act on completed-turn text. |
| Forgoing future upstream SDK fixes (e.g. real constrained decoding in the CLI) | Revert path is a descriptor flip + re-enabling one adapter branch; `mapErrorSubtype` retained. |
| Conformance/consumer suites assume native forwarding | D7 makes the check capability-aware; Phase 7 sweeps every consumer suite. |

## 8. Implementation plan

Red-green TDD throughout: each phase starts with failing behavior-level tests,
then the minimum implementation, then proportionate regression. Phases are ordered
so the tree is green after every phase; 1–5 are safe to land independently of 6.

**Phase 1 — Renderer (new, neutral).**
- Failing tests: `structured-output-prompt.test.ts` — deterministic rendering,
  sorted keys, full schema retained (including `minLength` etc.), contract
  preamble present, no trailing whitespace drift.
- Implement `renderStructuredOutputInstruction`.

**Phase 2 — Claude task runner flip.**
- Failing tests in `claude/task-runner.test.ts`: with `outputSchema` set,
  (a) `runQuery` receives **no** `outputFormat`, (b) the dispatched prompt ends
  with the rendered contract, (c) the result's text flows through and
  `structuredOutput` is absent.
- Implement; keep isolated one-shot behavior pinned.

**Phase 3 — Claude conversation runtime flip.**
- Failing tests in `claude/conversation-runtime.test.ts` (and the sdk-driver test
  seam): query session receives no `outputFormat`; a turn under a stored schema
  gets the rendered contract appended; runtime-identity comparison in
  `actor-implementations` still rebuilds on schema change (existing tests stay
  green).

**Phase 4 — Descriptor + conformance.**
- Failing tests: new `post_validation` behavior check in `conformance.ts`
  (no-native-forwarding + prompt-contract assertions, plus the lying-descriptor
  negative); Claude descriptor test updated to expect `post_validation` on both
  facets.
- Flip `claude/descriptor.ts`; update the Claude conformance harness.

**Phase 5 — Delete projection.**
- Remove module, inventory test, re-exports, call-site imports. Update
  `.kiro/steering/agent-backends.md` and `docs/structured-data-responses.md`
  in the same commit (docs/steering must move with the boundary, per AGENTS.md).
- Regression: `bun run test src/lib/agent-backends`, `bun run seams:check`,
  `bun run typecheck`.

**Phase 6 — Repair primitive + facade wiring.**
- Failing tests:
  - `structured-output-repair.test.ts` — prompt contains schema, bounded prior
    text, named issues, decoded-keys diagnostic.
  - `agent-call-facade.test.ts` — gate failure triggers exactly one repair
    dispatch (task_run: fresh one-shot via resolved runner; conversation_turn:
    corrective turn via resolved runtime); repaired success returns
    `parse.repaired === true` with the winning source; repair failure returns
    `schema_validation` with enriched details and **preserved
    transcript/contentBlocks/artifacts**; `structuredOutputRepair.maxAttempts: 0`
    disables it.
  - Classifier test: `error_max_structured_output_retries` maps to the dedicated
    classification.
- Implement repair module, facade stage, `AgentCallStructuredOutputParse`
  extension, log events.

**Phase 7 — Contract test + consumer regression sweep.**
- Contract-level test per incident recommendation 6 (collaboration-shaped): work
  turn completes and writes the artifact; format turn returns a malformed manifest
  (all required content present but trapped in one field); the repair turn returns
  valid JSON; the lane completes and registers the artifact.
- Targeted suites: collaboration, workflow-agent-caller, compaction
  (context-artifacts), conversation-commands, agent-runs, tickets/enrichment,
  workflow-graph validator-runner, sessions/conflict-resolution.
- Full gate: `bun run test`, `bun run typecheck`, `bun run lint`,
  `bun run seams:check`.
- Live verification (cc-live-feature-test skill): one real collaboration run on a
  Claude lane and one `/commit` generation, confirming manifest acceptance via
  backend state, plus grep of server logs for the new repair events.

**Phase 8 (optional follow-up, separate change).** Adopt the repair primitive in
the four direct-runner consumers where a retry beats their current fallback
(enrichment and validator-runner first).

### Decided defaults (cheap to change later)

- Repair budget: 1 attempt, enabled by default wherever a schema is present at the
  facade; opt-out via `structuredOutputRepair: { maxAttempts: 0 }`.
- Repair context: task_run = fresh isolated one-shot; conversation_turn = one
  corrective resumed turn.
- Rendered schema: full/unprojected, sorted keys, fenced.

## 9. Acceptance criteria

1. No code path passes `outputFormat` to the Claude Agent SDK (pinned by adapter
   tests and the conformance check; verified by grep at review).
2. `projectSchemaForClaude` and the schema inventory no longer exist.
3. The collaboration contract test (Phase 7) passes: a malformed-manifest format
   turn recovers via one repair turn and the lane completes.
4. All consumer suites, `bun run test`, `typecheck`, `lint`, and `seams:check` are
   green; no new backend-identity branches above the seam (capability-driven only).
5. Steering and docs updated in the same change series; the new repair log events
   appear in a live run.
