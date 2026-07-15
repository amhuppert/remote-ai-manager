---
date: 2026-07-12
status: implemented; resolves §3.6 blockers 1-5 of docs/reports/2026-07-12_consolidated-architecture-design-and-plan.md
---

# Phase 1 slice designs — §3.6 blocker resolutions

Five blocker designs consolidated into one document. Each section is a resolved design with its acceptance tests; every file:line evidence citation is preserved.

**Evidence snapshot caveat (applies to every section):** all file:line references were taken against branch `csm/review-and-refactor-composition-units-d688c3` at commit `0c42c186` while a concurrent Phase 0 workflow edits `src/**`. Treat file paths + symbol names as authoritative and re-verify line numbers at implementation time.

---

## Decisions

### D-ref — AgentSessionRef shape-migration rollout policy: **(a) breaking version-gated cutover**

Three rollout options were on the table:

- **(a) Breaking cutover** — bump `KNOWN_SCHEMA_VERSION`, insert a `schema_migrations` row, and refuse protocol-aware older builds before open. A binary released before the barrier protocol cannot be retrofitted by a marker it never reads. The marker is not a lifetime lease, so every lower-version process that already holds a connection must be quiesced for cutover; staging the scanner in a prior release protects only later opens. Required explicit breaking-change approval.
- **(b) Dual-read with canonical-only writes / back-compat shims** — required explicit backward-compatibility approval per the project rule.
- **(c) Non-breaking additive/graceful-quarantine** — shadow superset rows readable by frozen older builds, lenient decode, an idempotent Umzug data migration, no `KNOWN_SCHEMA_VERSION` bump.

**Selected by Alex on 2026-07-13: policy (a).** The persisted shape is canonical `{backend, ref}` and migration 0005 stamps compatibility version `1`. A protocol-aware older build that opens after the barrier is refused before it can mutate or read the upgraded database. Every lower-version process already holding a connection must be stopped for cutover; a staged scanner protects subsequent opens but does not fence that connection's lifetime. Pre-protocol binaries must additionally be prevented from reopening after the marker is published. The shadow-superset write path and retirement follow-up are rejected; legacy/superset decoding remains only as transitional tolerance for data not yet converged by migration.

### D10 — no `cctl codex` alias

The generic agent-runs command (Phase 3.6 rename of `codex-runs`) **replaces** `cctl codex` outright; no alias is kept. Retaining the alias would have been backward compatibility requiring explicit approval; deletion is the default path. Consumers are updated in the same slice (no barrel/alias re-exports, per `structure.md`).

### Approved plan amendments

Alex approved both amendments on 2026-07-13:

1. **Blocker 3 §2.1:** per-kind `capabilityKinds[].applyTiming` replaces the plan text's single `runtimeConfigApplyTiming` field so Claude agents can truthfully declare `next-conversation` timing.
2. **Blocker 4 D-B4.2:** one sanctioned `as`-narrowing mints `TESTFAKE_BACKEND_ID` in the lint-fenced test-support module.

---

## Blocker 1 — Backend-compatible structured-output projection (§3.1.6, §3.6.1)

**Status: resolved design.** One shared extraction/validation module in `src/lib/agent-backends/structured-output.ts`; one Claude-owned projection function applied *inside the Claude adapter at the two SDK handoff points*, so every Claude-bound schema is projected by construction and no caller ever hand-maintains a Claude-safe schema again. Zod stays the authoritative post-parse acceptance schema. This replaces raw `z.toJSONSchema` output reaching Claude unprojected.

### 1.1 Current-state inventory: the 7 structured-output mechanisms

| # | Mechanism | Location (evidence) | Wire schema | Extraction | Post-parse validation |
|---|---|---|---|---|---|
| 1 | **AgentCall facade gate** | `src/lib/workflows/primitives/agent-call-facade.ts:239–324` (`applyStructuredOutputGate`, `resolveStructuredOutputCandidate`, `parseStructuredOutputText`, `extractLastJsonFence`) + `src/lib/workflows/primitives/structured-output-gate.ts:37–288` (`validateJsonSchemaSubset`, a ~250-line hand-rolled JSON Schema validator) | caller's `outputSchema: Record<string, unknown>` (`agent-call-vocabulary.ts:52,58`) | native `structuredOutput` → raw `JSON.parse(text)` → **last** `` ```json``/bare fence. Native present but invalid = hard fail, no fall-through (`agent-call-facade.ts:290–292`) | hand-rolled JSON-schema subset |
| 2 | **Collaboration hand-authored projections** | `src/lib/workflows/collaboration/types.ts:12–22` (header documenting the Claude keyword hazard), `types.ts:102+` (`SHORT_STRING_JSON_SCHEMA`, `AGREEMENT_JSON_SCHEMA`, … full `*_JSON_SCHEMA` literal family); consumed at `agent-caller-production.ts:217–218`; two-pass work-turn→format-turn repair at `agent-caller-production.ts:368–395`; orchestrator-owned-field injection at `helpers.ts:119–174` (`parseAndInjectArtifact`) | hand-written literals, deliberately keyword-free | backend-native only (format turn under enforcement) | Zod content schema + full-schema re-validate |
| 3 | **Graph validator 4-path chain** | `src/lib/workflow-graph/validator-runner.ts:378–412` (`parseValidatorResponse`: `structured_output` → `raw_json` → `fenced_json_block` (+ `fenced_json_block_fallback`, `runner_error`; union at :369–375)); hands `VALIDATOR_OUTPUT_SCHEMA` (`:52–72`, incl. an `as unknown as Record<string, unknown>` cast at `:705`) to the runner and sets `skipStructuredOutputGate: true` at `:718` (escape hatch plumbing: `execute-workflow-task-run.ts:67,208–209`; `conversation/machine.ts:129–130,640–643`; `conversation/types.ts:104,216,401`; `actor-implementations.ts:2622`) | hand-written literal, keyword-free | native → raw → fenced; **falls through when native fails safeParse** (`:385–393`) | Zod `workflowAgentValidatorResultSchema` |
| 4 | **Conflict-resolution copy** | `src/lib/sessions/conflict-resolution.ts:283–343` (structured → raw JSON → own `extractLastJsonCodeFence` at `:251`) | (prompt-driven) | same 3-path chain, privately re-implemented | Zod `conflictEntriesPayloadSchema` |
| 5 | **codex-output prompt wrapper** | `src/lib/agent-backends/codex/codex-output.ts:8–27` (`CODEX_OUTPUT_SCHEMA` hand literal), `:37–39` (`wrapCodexPrompt`), `:50+` (`parseCodexStructuredResponse` — a fully hand-rolled non-Zod field-by-field parser). Consumers: `codex-runs/service.ts:33`, `workflows/conversation/actor-implementations.ts:513` (dynamic import) | hand literal | `JSON.parse` of string input only | hand-rolled typeof checks (no Zod) |
| 6 | **Chat-spawn named fence** | `src/lib/chat-spawning/proposal-validator.ts:42–69` (`extractFromText` — named `` ```spawn-proposal`` fence regex at `:46–49`; `extractProposal` accepts pre-parsed object or turn text) | none (fence convention) | first named-fence match | Zod `spawnProposalSchema` (`:22–26`) |
| 7 | **Raw `z.toJSONSchema` projection** (the blocker's direct target) | `src/lib/context-artifacts/generation.ts:94–105` — `COMPACTION_JSON_SCHEMA = z.toJSONSchema(compactionStructuredOutputSchema, { io: "input", override … })`; handed to the backend at `context-artifacts/service.ts:442` (`outputFormat: { type: "json_schema", schema: COMPACTION_JSON_SCHEMA }`). Cousins: hand-mirrored `COMMIT_MESSAGE_JSON_SCHEMA`/`MERGE_MESSAGE_JSON_SCHEMA` at `conversation-commands/schemas.ts:22–40` duplicating `commitMessageOutputSchema` (`:13–18`), consumed at `conversation-commands/service.ts:254–255` | generated (only `z.toJSONSchema` call in `src/`) | via mechanism #1/#3 | Zod `compactionStructuredOutputSchema` |

**Where Claude-bound schemas cross into the SDK (the projection insertion points):**

- Task runs: `src/lib/agent-backends/claude/task-runner.ts:136–138` builds `outputFormat` from `input.outputSchema` and passes it to `query()` at `:192`.
- Conversation runtimes: `src/lib/agent-backends/claude/conversation-runtime.ts:711` (QuerySession options) and `:723` (runtime constructor), flowing to the SDK at `query-session.ts:404`.

**Backend capability vocabulary already exists:** `structuredOutputEnforcement: "backend_native" | "post_validation" | "unsupported"` at `agent-call-vocabulary.ts:95–99,111`, populated in `workflows/primitives/backend-capabilities.ts:21,30` (both backends currently `backend_native`).

#### 1.1.1 The documented Claude keyword failure mode

`docs/structured-data-responses.md:105–147` ("Backend Enforcement Compatibility"): Claude's `outputFormat: { type: "json_schema" }` supports basic types, `enum`, `const`, `anyOf`, `allOf`, `$ref`/`$defs`, `additionalProperties: false`, but does **not** support `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `multipleOf`, `minItems`, `maxItems` (`:117–120`). These are *dangerous, not ignored*: the CLI validates output against them post-generation but cannot steer generation, so the model loops and fails the whole turn with `Failed to provide valid structured output after N attempts` (`:122–132`). Codex tolerates the same keywords (`:128–129`). The hazard is restated at `workflows/collaboration/types.ts:12–22` and in the test-local guardrail at `collaboration/schemas.test.ts:208–246` (`UNSUPPORTED_STRUCTURED_OUTPUT_KEYWORDS` + `unsupportedStructuredOutputKeywordPaths`, asserted at `:636–638`).

#### 1.1.2 Live hazard found during this audit (motivating red-first repro)

`COMPACTION_JSON_SCHEMA` **currently carries the unsupported keywords** into a backend that defaults to Claude:

- Walking the exported constant (verified by executing the module) yields `minItems: 1` on every `sourceRefs` array (from `.min(1)` at `generation.ts:63,69`) and `minimum`/`maximum` = ±9007199254740991 on every `z.int()` field (`$.properties.decisions.items.properties.sourceRefs.minItems=1`, `…messageIndex.minimum=-9007199254740991`, etc.).
- The compaction backend defaults to `"claude"`: `src/lib/config/schemas.ts:61` (`backend: agentBackendSchema.default("claude")`), threaded to the run at `context-artifacts/service.ts:383,459`.

The safe-integer bounds are practically unviolatable, but `minItems: 1` is a real hair-trigger (a model emitting one empty `sourceRefs` array trips CLI-level rejection the grammar never prevented). This is precisely the documented failure mode shipping today, and it is the red-first repro for the projection.

### 1.2 Resolved design

#### 1.2.1 Module A — shared extraction + post-parse validation: `src/lib/agent-backends/structured-output.ts`

```ts
export type StructuredOutputSource = "native" | "raw_json" | "fenced";

export interface ExtractStructuredOutputOptions {
  /** Restrict fenced extraction to a named info string (e.g. "spawn-proposal").
      Default: last ```json or bare ``` fence. */
  fenceInfo?: string;
}

export function extractStructuredOutput(
  input: { native?: unknown; text: string | null },
  options?: ExtractStructuredOutputOptions,
):
  | { ok: true; value: unknown; source: StructuredOutputSource }
  | { ok: false; error: string };

export function validateStructuredOutput<T>(
  schema: z.ZodType<T>,
  input: { native?: unknown; text: string | null },
  options?: ExtractStructuredOutputOptions,
):
  | { ok: true; value: T; source: StructuredOutputSource }
  | { ok: false; error: string; stage: "extraction" | "validation" };
```

Semantics (each decision pinned by a test in §1.3):

1. **Extraction precedence** `native` → raw `JSON.parse(full text)` → **last** fenced block — matching the union of today's chains (facade `agent-call-facade.ts:287–308`; validator `validator-runner.ts:384–411`; conflict-resolution `conflict-resolution.ts:283–343`).
2. **Fall-through on invalid candidates**: `validateStructuredOutput` tries each extraction source *in order* and accepts the first that passes `safeParse`; if none passes, it reports the Zod issues of the highest-priority candidate (`stage: "validation"`). This is the validator chain's existing behavior (`validator-runner.ts:385–393` — native failing safeParse falls through to raw/fenced) and is a **deliberate behavior widening for the facade**, which today hard-fails when native output is present but invalid (`agent-call-facade.ts:290–292` returns `source: "existing"` unconditionally). Red-first test required (§1.3, T1.4).
3. **Named fences** via `fenceInfo` cover the chat-spawn `` ```spawn-proposal`` convention (`proposal-validator.ts:46–49`) so Phase 3 migration is a drop-in.
4. `extractStructuredOutput` is the JSON-schema-flavored entry (the facade gate validates a `Record<string, unknown>` schema, not Zod — `agent-call-vocabulary.ts:52`): Phase 1.7 rewires `applyStructuredOutputGate` to call `extractStructuredOutput` for candidate resolution and keeps `runStructuredOutputGate`/`validateJsonSchemaSubset` (`structured-output-gate.ts:37–76`) as its validator. `validateStructuredOutput` is the Zod-flavored entry the Phase-3 consumers (validator chain, conflict-resolution, codex-output, chat-spawn) migrate onto.
5. Error strings name what was attempted (`"no structured output: native absent, text is not JSON, no fenced JSON block"`), preserving the debuggability of today's per-site messages (e.g. `conflict-resolution.ts:325`).

Structured logging per `.kiro/steering/logs.md` (module `agent-backends.structured-output`; events `structured_output.extracted` (debug, `{source}`), `structured_output.validation_failed` (warn, `{stage, source, issuePaths}`)).

#### 1.2.2 Module B — the Claude projection: `src/lib/agent-backends/claude/structured-output-projection.ts`

```ts
/** Keywords Claude's native enforcement validates but cannot steer (docs/structured-data-responses.md §Backend Enforcement Compatibility). */
export const UNSUPPORTED_CLAUDE_STRUCTURED_OUTPUT_KEYWORDS = [
  "minLength", "maxLength", "pattern",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minItems", "maxItems",
] as const;

/** Pure. Returns every path in `schema` carrying an unsupported keyword. */
export function unsupportedStructuredOutputKeywordPaths(schema: unknown, path?: string): string[];

/** Pure. Deep-copies `schema` with every unsupported keyword removed, everything else preserved. */
export function projectSchemaForClaude(
  schema: Record<string, unknown>,
): Record<string, unknown>;
```

**Stripped** (recursively, at any depth — `properties`, `items`, `anyOf`/`oneOf`/`allOf` branches, `$defs`): the 10 keywords above. This is the documented set (`docs/structured-data-responses.md:117–120`) plus `exclusiveMinimum`/`exclusiveMaximum` — the same numeric-range class, and what Zod v4 emits for `.positive()`/`.gt()`; omitting them would leave a trivially reachable hole.

**Preserved**: `type`, `enum`, `const`, `properties`, `required`, `items`, `additionalProperties`, `anyOf`, `allOf`, `oneOf`, `$ref`, `$defs`, `description`, `title`, `default` — i.e., everything else, verbatim. Descriptions are load-bearing (bounds live there as advisory text per `docs/structured-data-responses.md:138–139`), so projection must not touch them.

**The keyword list and path-walker live in production code** (the projection needs them; guardrail tests import them), replacing the private test copy at `collaboration/schemas.test.ts:215–246`.

**Insertion points — inside the Claude adapter, not at call sites:**

1. `claude/task-runner.ts:136–138`: `schema: projectSchemaForClaude(input.outputSchema)`.
2. `claude/conversation-runtime.ts:711` (and the mirrored constructor arg at `:723`): project `input.outputFormat.schema` once where the runtime accepts it, so `query-session.ts:404` only ever sees projected schemas.

Codex applies **no projection** (identity): Codex's stack tolerates the keywords (`docs/structured-data-responses.md:128–129`) and its schemas benefit from them. That asymmetry is exactly why projection is backend-owned — it is provider knowledge below the seam (Decision D9 pattern, plan §3.1.5). When the Phase-1 descriptor lands, the projection is surfaced as descriptor knowledge (e.g. `descriptor.structuredOutput.projectSchema(schema)` beside the existing `structuredOutputEnforcement` facet at `backend-capabilities.ts:21,30`); in Phase 1.7 the direct function calls at the two adapter points are sufficient and remain the implementation behind that facet.

**Effect on mechanism #7:** `z.toJSONSchema` stays (it is the correct generator); its raw output simply never reaches Claude unprojected. `COMPACTION_JSON_SCHEMA`'s `minItems`/`minimum`/`maximum` are stripped at the adapter; violations (e.g. empty `sourceRefs`) now surface in CC's Zod `safeParse` and flow into the compaction service's existing schema-retry feedback loop (`context-artifacts/service.ts:424–433`) — a recoverable, attributed failure instead of an opaque SDK loop. This is the intended failure-model shift (`docs/structured-data-responses.md:140–143`).

#### 1.2.3 What Phase 1.7 does and does not migrate

Per plan §Phase 1.7 (report line 441): implement Modules A+B, apply the adapter projection, migrate the **facade gate** onto shared extraction. The validator chain (#3), conflict-resolution (#4), codex-output (#5), and chat-spawn (#6) migrate in Phase 3 where touched (`§3.1` report line 463 deletes `skipStructuredOutputGate` + the validator chain + conflict-resolution's copy). Collaboration's hand-authored projections (#2) **remain** until generated backend-specific projections prove parity; the ratchet target is *duplicate schema knowledge to zero*, not hand-authored projections to zero (report line 441). The ratchet file records: collab `*_JSON_SCHEMA` literals (deletion condition: parity proven by generated projection over the same Zod content schemas), `COMMIT/MERGE_MESSAGE_JSON_SCHEMA` hand mirrors (deletion condition: replaced by `z.toJSONSchema(commitMessageOutputSchema)` + adapter projection during Phase 3 conversation-commands touch), `CODEX_OUTPUT_SCHEMA` + hand parser (deletion condition: Phase 3.6 agent-runs drops the wrap/parse path, report line 473).

#### 1.2.4 Rejected alternatives

- **Caller-owned projection at each call site** — repeats the collab hand-maintenance failure mode that produced the compaction hazard; every future caller is a new opportunity to forget. Adapter-seam projection is safe by construction.
- **`z.toJSONSchema` `override` hooks as the only mechanism** — protects only generated schemas, not the five hand-authored literal families, and every generator call must remember the hook (the existing one at `generation.ts:98–103` forgot the keywords while remembering `additionalProperties`).
- **Ajv (or similar) for post-parse validation** — Zod is already authoritative everywhere; a second validator adds a dependency and a semantics-drift surface. The hand-rolled subset validator in the gate stays for the JSON-schema-shaped path until Phase 3 revisits it.
- **Rejecting (throwing) on unsupported keywords at the adapter instead of stripping** — turns a recoverable projection into a runtime crash for schemas that are valid contracts (the bounds are legitimately enforced post-parse); the guardrail *test* is the place to fail loudly, the adapter is the place to be safe.

### 1.3 Acceptance tests (Phase 1.7)

All new tests colocated per `structure.md`. Red-first entries marked **[RED]** must fail against current behavior before implementation.

#### T1 — `src/lib/agent-backends/structured-output.test.ts` (new)

- **T1.1** extraction precedence: given `native` defined + text containing different raw JSON → returns native, `source: "native"`; given no native + full-text JSON → `raw_json`; given no native + prose with two fences → value of the **last** fence, `source: "fenced"`; bare ``` ``` and `` ```json`` info strings both accepted; `fenceInfo: "spawn-proposal"` matches only the named fence.
- **T1.2** nothing extractable (`native` undefined, text null / prose-only) → `{ ok: false }` with an error naming all attempted sources.
- **T1.3** `validateStructuredOutput`: valid native → `{ ok: true, source: "native" }`; native absent, valid fenced → `source: "fenced"`.
- **T1.4 [RED — pins the fall-through widening]** `native` present but failing the Zod schema, while the text carries a valid fenced JSON object → `{ ok: true, source: "fenced" }`. (Today's facade would hard-fail this shape; the validator chain would pass it — the module standardizes on fall-through.)
- **T1.5** all candidates fail schema → `{ ok: false, stage: "validation" }` with the native candidate's Zod issue paths in `error`; no candidates at all → `stage: "extraction"`.

#### T2 — `src/lib/agent-backends/claude/structured-output-projection.test.ts` (new)

- **T2.1** per-keyword strip: for each of the 10 keywords, a schema carrying it at (a) a top-level property, (b) `items`, (c) an `anyOf` branch, (d) `$defs` → projected output has `unsupportedStructuredOutputKeywordPaths(projected) === []`.
- **T2.2** preservation: a maximal supported-subset schema (`type`/`enum`/`const`/`required`/`additionalProperties: false`/`description`/nested `properties`/`items`/`anyOf`/`$defs`/`$ref`) round-trips **deep-equal** through projection; separately, projecting a keyword-carrying schema deep-equals the source after manually deleting only the unsupported keys (proves nothing else is touched). Input object is not mutated.
- **T2.3 [RED — the live-hazard repro]** `unsupportedStructuredOutputKeywordPaths(COMPACTION_JSON_SCHEMA).length > 0` (documents the shipping hazard: `generation.ts:94` + backend default `"claude"` at `config/schemas.ts:61`) **and** `unsupportedStructuredOutputKeywordPaths(projectSchemaForClaude(COMPACTION_JSON_SCHEMA)) === []`. (The first half is an inventory assertion that later flips to a projected-at-adapter guarantee; keep it as documentation of why projection exists.)
- **T2.4** recursive guardrail over every production Claude-bound schema constant — `projectSchemaForClaude(s)` yields zero unsupported paths for each of: `COMPACTION_JSON_SCHEMA`, `VALIDATOR_OUTPUT_SCHEMA` (`validator-runner.ts:52`), `COMMIT_MESSAGE_JSON_SCHEMA`/`MERGE_MESSAGE_JSON_SCHEMA` (`conversation-commands/schemas.ts:22,32`), every collaboration `COLLABORATION_*_OUTPUT_SCHEMA`, and `CODEX_OUTPUT_SCHEMA` (dual-lane callers can route it to Claude). New Claude-bound constants must be added to this inventory; the test file's header states the admission rule.
- **T2.5** parity (projected shape retains the intended contract): for the compaction, commit/merge, and validator schemas — (a) a representative **valid** fixture (passing the authoritative Zod schema) also passes the projected JSON schema via `validateJsonSchemaSubset` (projection only widens acceptance, never narrows); (b) the projected schema still **rejects** an empty object and an extraneous top-level property (mirrors the existing collab contract tests at `collaboration/schemas.test.ts:646–654`); (c) `required` sets, `additionalProperties: false`, and `enum` members are unchanged between source and projection.

#### T3 — adapter seam tests (extend existing suites, DI per engineering-principles — no `vi.mock` of internal modules)

- **T3.1 [RED]** `claude/task-runner.test.ts`: dispatch a task with `outputSchema` containing `minItems`/`minimum` → the `outputFormat.schema` captured at the injected `query` boundary carries none of the unsupported keywords and is otherwise deep-equal to the input.
- **T3.2 [RED]** `claude/conversation-runtime.test.ts`: create a runtime with a keyword-carrying `outputFormat` → the QuerySession options schema is projected (both the options path at `conversation-runtime.ts:711` and the constructor-held copy at `:723` observe the projected schema).
- **T3.3** codex task-runner counterpart: the same schema passes through the Codex adapter **unmodified** (identity projection pinned so a future "helpful" global strip fails a test).

#### T4 — facade gate migration (`workflows/primitives/agent-call-facade.test.ts`, extend)

- **T4.1 [RED — behavior change]** completed dispatch where `outcome.structuredOutput` fails the gate but `outcome.text` contains a valid fenced JSON object → gate passes and the result's `structuredOutput` is the fenced value (today: `failWithSchemaValidation`, per `agent-call-facade.ts:290–292` + `:284`).
- **T4.2** parity pins for unchanged behavior: no `outputSchema` → result untouched (`:244`); non-completed outcome → untouched (`:245`); gate failure with *no* recoverable text → `schema_validation` failure with the same normalized reason shape; passing native output does not get overwritten.
- **T4.3** collaboration guardrail dedupe: `collaboration/schemas.test.ts` imports `unsupportedStructuredOutputKeywordPaths` + the keyword list from the production module; its private copies (`:215–246`) are deleted; all existing `omits json_schema keywords…` assertions (`:636–638`) stay green.

#### Gates

`bun run typecheck && bun run lint && bun run test && bun run build`; ratchet file updated with the §1.2.3 populations and deletion conditions. Blocker 1 is **resolved** when T1–T4 are green and the adapter-seam projection is live for both Claude entry points.

### 1.4 Open risks

1. **Behavioral shift on compaction under Claude (intended, but live):** stripping `minItems: 1` moves empty-`sourceRefs` failures from SDK-internal retries to CC's Zod retry loop (`context-artifacts/service.ts:424+`). Net better (attributed, fed-back), but compaction latency/retry accounting changes; watch `schemaRetryUsed` telemetry after rollout.
2. **Facade fall-through widening (T1.4/T4.1)** accepts fenced JSON that native enforcement rejected. A malformed-native + coincidentally-valid-fenced turn now passes; the Zod/gate schema is still the arbiter, so the accepted value is contract-valid, but the provenance changes (`parse.source` in the Phase-3.1 widened result makes this observable).
3. **`format` keyword left unprojected.** `z.toJSONSchema` emits `format` for `z.email()`/`z.url()` etc.; the docs' unsupported list doesn't include it and no production Claude-bound schema emits it today. If Claude's enforcement rejects/validates `format` the same way, the projection list needs a follow-up entry — the T2.4 inventory test is where it would surface.
4. **The gate's subset validator doesn't implement `anyOf`/`allOf`/`$ref`** (`structured-output-gate.ts:84–141` handles only `oneOf`/`enum`/`const`/types). Projection preserves those keywords, so a future schema using them would be enforced natively but under-validated by the facade gate. No current production schema is affected; Phase 3's gate revisit should close it.
5. **Two Claude insertion points, not one:** task-runner and conversation-runtime are independent handoffs; T3.1/T3.2 pin both, but any *new* Claude SDK entry point (e.g. a future streaming variant) must route through the same projection — the descriptor facet in Phase 1 proper is the durable fix for that.

### 1.5 Addendum (2026-07-12) — approved amendment to T3.2: `runtime.outputFormat` is an identity token, not a provider handoff

T3.2 as written above required both the QuerySession options path **and** the constructor-held copy to observe the projected schema. The implementation deliberately deviates (Phase 1 backend-seam review, finding 9), and that deviation is hereby recorded as the approved design:

- **`runtime.outputFormat` holds the caller's original (unprojected) object and is an opaque source-identity token.** Its only production consumer is the actor's recreate gate (`workflows/conversation/actor-implementations.ts` — `shouldRecreateRuntime` compares `runtime.outputFormat !== desiredOutputFormat` by reference). Substituting a fresh projected object at construction would break identity with the caller's cached schema object and churn the runtime every turn (see debug-adapter's per-phase wrapper cache).
- **The only Claude SDK handoff is projected.** `claude/conversation-runtime.ts` projects `input.outputFormat.schema` once (`projectSchemaForClaude`) and passes that distinct copy on `QuerySessionOptions.outputFormat`; `query-session.ts` therefore only ever sees projected schemas. No SDK path reads `runtime.outputFormat`.
- **The pin:** the T3.2 test in `claude/conversation-runtime.test.ts` asserts, at the injected `query()` boundary, that the SDK-bound `outputFormat` is (a) shape-equal to the projection and (b) reference-distinct from both `runtime.outputFormat` and the source schema object. Any change that routes the runtime-held source to the SDK fails this test.

T3.2's acceptance text is superseded accordingly: "the QuerySession options schema is projected; the runtime-held copy retains the caller's object by reference as the recreate-gate identity token and never reaches the SDK."

### 1.6 Addendum (2026-07-13) — conflict-resolution & bare-fence acceptance are intentionally on the shared chain (Phase 3 review F5)

The §1.1 inventory characterized mechanism #4 (**conflict-resolution copy**) as "the same 3-path chain, privately re-implemented," and §1.2.1 item 2 framed the fall-through as a **deliberate widening for the facade** (mechanism #1). Both are accurate about the facade, but the inventory did not record that the pre-migration conflict parser had a *conflict-specific* rejection shape the facade never shared: when a backend-native structured output was present but failed the schema, the old conflict parser **hard-failed immediately** rather than falling through to a valid raw/fenced text candidate (`3c845aa0:src/lib/sessions/conflict-resolution.ts:290–304`). Migrating conflict-resolution onto `validateStructuredOutput` therefore widened its accepted-source/error policy, not only the facade's. It also gained the shared matcher's **bare-fence acceptance** (a ``` ``` block with no `json` info string — `structured-output.ts:184–189`), which the old private parser did not accept.

**Decision: the widening is approved and made explicit for these consumers.** Both changes are consistent with the shared chain's design intent — Zod remains the authoritative arbiter, so an accepted fallback candidate is contract-valid, and the provenance is observable via `ValidateStructuredOutputResult.source`. A backend-native contract miss no longer masks a schema-valid self-corrected text payload in the same turn; that is the same "self-corrected fenced payload" behavior §1.2.1 item 1 endorses for the module as a whole. Neither the graph validator nor conflict-resolution restores a private parser or opts out of bare-fence acceptance.

**Pins (consumer-level, so a future opt-out is caught):**

- **Validator chain (#3):** `parseValidatorResponse` — an invalid native candidate (missing the required `summary`) falls through to a schema-valid fenced-JSON text candidate; asserted `parsePath === "fenced_json_block"` (`src/lib/workflow-graph/validator-runner.test.ts`).
- **Conflict-resolution (#4):** `parseConflictEntries` (now exported for this pin) — an invalid native candidate (`{ conflicts: [{ file: "x" }] }`) falls through to a schema-valid raw-JSON *and* a schema-valid bare/`json`-fenced text candidate; the no-recoverable-text case still fails (`src/lib/sessions/conflict-resolution.test.ts`).

**Not adopted:** the finding's conditional alternative — a shared `stopAfterInvalidNative` validation option plus `fenceInfo: "json"` to reproduce the exact old conflict behavior — is deliberately declined. Restoring the narrower policy would fork the shared chain per-consumer, which is what Phase 1 consolidated away; the consumer pins above make the wider policy a reviewed, guarded contract instead.

---

## Blocker 2 — AgentSessionRef shape-migration rollout mechanics under policy (a) (§3.1.1, D17, §3.6.2)

**Status: resolved design under D-ref (above), amended 2026-07-14 with the implementation-review failure modes and persistence hardening.** Rollout policy **(a) — breaking version-gated cutover**. `KNOWN_SCHEMA_VERSION` is `1`; migration 0005 durably publishes the append-only version-1 compatibility barrier before it rewrites persisted refs to canonical `{backend, ref}` and records SQLite compatibility version `1`. Migration failure is fatal. A protocol-aware older build opening after publication is refused before a SQLite connection is constructed, so refusal cannot checkpoint or rewrite WAL/SHM sidecars. All lower-version processes with an already-open connection must be quiesced for cutover; staging the scanner in an earlier release protects later opens only. A pre-protocol binary must also be prevented from reopening because it cannot honor the marker.

The compatibility stamp and every incompatible-byte rewrite are one atomic unit. Per-table transactions are insufficient: a failure after one table commits but before the stamp would expose canonical-only bytes while the database still advertises version `0`.

### 2.1 Current state (evidence)

- Legacy union: `agentSessionRefSchema = z.discriminatedUnion("backend", [{backend:"claude", sessionId}, {backend:"codex", threadId}])` — `src/lib/agent-backends/schemas.ts:12-16`; hand-written TS duplicate at `src/lib/agent-backends/types.ts:7-9` (deleted by §3.1.1).
- Target canonical shape: `{ backend, ref }` in `src/lib/shared/schemas.ts` (plan §3.1.1, lines 139-160 of the report).
- Both union arms are **non-strict** `z.object`s → they ignore unknown keys. This is what makes a superset row readable by old builds.
- Migration runner: Umzug over `applied_migrations`, ledger `INSERT OR IGNORE` tolerating concurrent double-apply (`src/lib/state-store/migrator.ts:16-41`); migrations run once at startup from `instrumentation.node.ts:81-95`, which today **catches and continues** on failure (`:91-95`) — Phase 0.5 (running concurrently) makes this fatal; this design assumes that lands first.
- Fresh DBs: schema floor creates current shapes synchronously; every migration stamps as a no-op (`src/lib/state-store/migrations/README.md`, "How schema management is split").

### 2.2 Inventory — every persisted site of the exact `AgentSessionRef` union

| # | Storage | Field | Evidence |
|---|---|---|---|
| 1 | `conversations.backend_ref` (JSON column) | `ConversationState.backendRef` | schema `src/lib/conversations/schemas.ts:239`; decode `conversation-row-codec.ts:223-232`; encode `conversation-row-codec.ts:378` (`encodeSharedConversationColumns`, shared by both tables); SQL `conversations-repo.ts:412,420,449` |
| 2 | `project_conversations.backend_ref` | same, via shared codec | column `src/lib/state-store/project-conversations-repo.ts:81,121`; codec doc `conversation-row-codec.ts:112-118` |
| 3 | `conversations.forked_from` / `project_conversations.forked_from` | `forkedFrom.sourceBackendRef` | schema `src/lib/conversations/schemas.ts:151`; decode `conversation-row-codec.ts:190-199`; encode `:371` |
| 4 | `conversations.machine_snapshot` / `project_conversations.machine_snapshot` | XState context `backendRef` (+ `forkedFrom.sourceBackendRef`) embedded in the persisted snapshot | context assignment `src/lib/workflows/conversation/machine.ts:227,374-375,447,457-458,592-596`; persisted opaquely (`z.unknown()`, codec `:110,212-221`) via `writeSnapshot` `src/lib/workflows/conversation/persistence.ts:154-180`; on rehydrate the **snapshot context wins over the row column** (`manager.ts:1388-1407`, comment "it won't override the snapshot") |
| 5 | Wire/UI (not a table): `conversationListItemSchema.backendRef` (`conversations/schemas.ts:289`, `GET /api/conversations/all`), `ConversationState` in SSE broadcasts, and client branch sites (e.g. `src/features/session/conversation/InfoDetailsPopover.tsx:26-27` reads `sessionId`/`threadId`) | compile-time migration in the same slice; stale-tab risk only | |

**Non-sites (checked, ruled out):** jobs (`src/lib/jobs/` — no ref fields); collab envelope persists raw `threadId` *strings*, not the union (`src/lib/workflows/collaboration/envelope.ts:589,650`), and lives in the already-quarantined `sessions.workflow_envelopes` column; `agentCallResultSchema.backendRef` (`workflows/primitives/agent-call-vocabulary.ts:178`) is a runtime result, never persisted. Graph-workflow lane and event refs are not rows in this database migration and therefore remain non-sites for §2.7; their separate vocabulary work item is now resolved by C6 rather than left out of the architecture program.

### 2.3 Historical policy-(c) design — superseded by §2.7

The remainder of §§2.3–2.6 records the originally proposed additive/shadow design for audit history. It is non-authoritative after Alex selected breaking policy (a). Section 2.7 is the implementation contract.

**Three mechanisms, one codec module.** New module `src/lib/shared/session-ref-codec.ts` (cross-domain primitive per `structure.md`; consumed by state-store codec, workflow persistence, and the migration):

1. **Lenient persisted-shape decoder.** `persistedAgentSessionRefSchema`: accepts canonical `{backend, ref}`, legacy `{backend, sessionId|threadId}`, and the superset; normalizes (Zod transform) to canonical `{backend, ref}`. Used at every read seam replacing direct `agentSessionRefSchema` use: `conversation-row-codec.ts:223-232` (backend_ref), inside `forkedFromSchema.sourceBackendRef` (`conversations/schemas.ts:151`), and snapshot restore (below).
2. **Shadow encoder.** `encodeAgentSessionRefForStorage(ref)` → superset `{backend, ref, sessionId|threadId}` (legacy key mirrors `ref`). Applied at every persisted seam: `encodeSharedConversationColumns` (`conversation-row-codec.ts:371,378`) and `writeSnapshot` (`persistence.ts:167` — structural-clone patch of `context.backendRef` / `context.forkedFrom.sourceBackendRef` before persist). Old builds parse the superset fine (non-strict union arms ignore `ref`). Encoding is deterministic, preserving the canonical-row byte-comparison contract (`conversation-row-codec.ts:25-29`).
3. **Umzug migration `0005-agent-session-ref-shape.ts`** (next number after `0004-fast-to-normal.ts`): for `conversations` and `project_conversations`, rewrite `backend_ref`, `forked_from`, and `machine_snapshot` rows to the superset. For `machine_snapshot`, deep-walk the JSON and rewrite any object matching the **exact** legacy signature (`{backend:"claude", sessionId:string}` or `{backend:"codex", threadId:string}`, `ref` absent) — fixed paths are too brittle against invoked-actor children. Idempotent by predicate (`ref` key absent → rewrite; present → skip), wrapped in one `db.transaction` per table so crash-replay converges; per-row malformed JSON is **skipped with a loud log**, never thrown (a pre-existing corrupt row must not brick startup once migration failure is fatal). No `KNOWN_SCHEMA_VERSION` bump, no `schema_migrations` row.

**Forward-protection quarantine (new builds only).** Extend the conversation codec so `backend_ref` and `forked_from` decode failures degrade the column to `null` with a `column_quarantined`-style error log (mirroring `sessions-repo.ts:365-377`) instead of throwing the row. Degradation semantics: `backendRef: null` → next turn starts a fresh backend session (continuity loss, already a handled state — `prompt.resume_ref_missing`); `forkedFrom: null` → provenance display loss. Both strictly better than failing every conversation list read. This protects *future* shape evolution; it cannot protect old builds.

**Rehydration.** `validateRestoredSnapshot` (`persistence.ts:188-212`) gains a normalization step alongside the existing `coerceLegacyActiveTurn` precedent (`:206`): `context.backendRef` and `context.forkedFrom.sourceBackendRef` pass through the lenient decoder before the actor is created, covering snapshots written by old builds after the migration ran. The `_schemaVersion` context gate stays at 1.

**Racing-worker behavior (multiple servers sharing `command-center.db`):**

- Two new-build workers racing the migration: ledger `INSERT OR IGNORE` (`migrator.ts:16-25`) + idempotent predicate + WAL write serialization → convergent; double-apply is a no-op.
- Old-build writer after migration: writes legacy-shape refs (and, when it round-trips a migrated row through its Zod parse, **strips** the shadow `ref` key, reverting that row to legacy). The lenient decoder reads it; the next new-build write re-supersets it. Convergent, no data loss.
- Old-build reader after migration: parses superset rows natively; reads new-build machine snapshots whose context carries the superset. The only breaking read is a canonical-only ref row, which the shadow-encode discipline prevents from existing during the window.

**Fresh-DB behavior:** schema floor only; `0005` stamps as a no-op at first startup; all writes go through the shadow encoder, all reads through the lenient decoder — contract-test `:memory:` fixtures need no migration step.

**Older-build reopen expectations:** opens without a gate (no version bump); conversation reads/writes work throughout the shadow window; worst residual case (canonical-only row from a missed seam) throws in the old build only — flagged as risk, pinned by raw-bytes tests.

**Shadow retirement (named deletion condition, follow-up work item):** when no pre-migration build can share `CC_CONFIG_DIR` (concretely: migration merged to main, live CC instance rebuilt, all session worktree branches rebased/rebuilt past it), a follow-up migration strips legacy keys and the decoder's legacy arm + shadow encoder are deleted. Recording and executing this is Alex-approved, per the backward-compatibility rule.

**Rejected alternatives:** (a) breaking `KNOWN_SCHEMA_VERSION` cutover — excluded by the D-ref policy choice; (b) dual-read with canonical-only writes — rejected because released builds throw on unknown ref shapes at the conversation boundary (codec `:223-232`) and cannot be retrofitted; (c-variant) quarantine-only without shadow writes — rejected for the same reason (quarantine exists only in sessions-repo, `sessions-repo.ts:354-377`); bumping machine `_schemaVersion` to 2 instead of rewriting snapshots — rejected: it discards every resumable snapshot (`persistence.ts:197-203` returns null on mismatch), losing in-flight turn state wholesale.

### 2.4 Historical policy-(c) acceptance tests — superseded by §2.7

**Pin FIRST — round-trip durability contract extensions** (per the schema-driven backstop rule):

- `src/lib/state-store/conversations-repo.contract.test.ts` — maximal fixtures currently pin the legacy shape (`backendRef: {backend:"codex", threadId:…}` at `:133,1343`; `forkedFrom` at `:111,1306`): update to canonical `{backend, ref}` (both a codex and a claude variant) so `assertRoundTripDurability` pins reload equality of the new shape. Add **raw-bytes assertions** (new focused test in the same file): after persist, `SELECT backend_ref` / `forked_from` JSON contains `backend` + `ref` + the mirrored legacy key — red until the shadow encoder ships. Mirror in the `project_conversations` contract coverage.
- `src/lib/shared/session-ref-codec.test.ts` (new): decodes legacy claude/codex, canonical, and superset → canonical; rejects handle-less garbage; `decode(encode(x)) === x`; and an **old-reader compatibility pin** — a verbatim frozen copy of today's discriminated union (from `agent-backends/schemas.ts:12-15`) parses the superset and extracts the correct `sessionId`/`threadId`.

**Migration tests** — `src/lib/state-store/migrations/0005-agent-session-ref-shape.test.ts` (beside `migrator.test.ts`, README step 5):

- Seeds legacy rows in both tables (all three columns, machine_snapshot with a nested legacy ref inside context) → asserts superset with correct `ref` per backend.
- **Idempotency:** double `up` → byte-identical rows (`stableStringify`).
- **Crash-replay:** run `up`, delete the `applied_migrations` row, `runMigrations` again → converges, ledger re-stamped.
- **Fresh DB:** empty tables → no-op, stamped (returned in applied names).
- **Mixed rows:** already-superset and `NULL` rows byte-untouched; one malformed-JSON row skipped without throwing while siblings migrate.
- **Racing old writer:** insert a legacy-shape row *after* migration → repo read returns canonical (decoder leniency).

**Red-first behavior changes:**

- Quarantine: conversation row with unparseable `backend_ref` (and separately `forked_from`) decodes with that field `null`, a quarantine error log, and every other column intact — currently throws (`conversation-row-codec.ts:223-232`), so red first. Location: `conversation-row-codec` test coverage (new colocated test file or existing repo tests).
- Rehydration normalization: `src/lib/workflows/conversation/persistence.test.ts` — `validateRestoredSnapshot` on a snapshot with legacy `context.backendRef` returns canonical context (red first); persisted snapshot JSON (via `createPersistenceFixture` real-store round-trip) carries the superset in `context.backendRef` (red first).
- `src/lib/workflows/conversation/rehydration.test.ts` — end-to-end: legacy-snapshot conversation rehydrates and the actor context holds the canonical ref.

### 2.5 Historical policy-(c) sequencing — superseded by §2.7

Land after Phase 0.5's fatal-migration change (instrumentation currently swallows failure, `instrumentation.node.ts:91-95`); this is a Phase 1 first-slice work item (plan Part 4, Phase 1 first paragraph). The mechanical ~20-branch-site collapse to `.ref` field access, the `types.ts:7-9` duplicate deletion, and the wire/UI updates ride the same slice. Historically, graph-workflow vocabulary and shadow retirement were recorded as separate follow-ups; C6 completes the graph item, while §2.7 supersedes the shadow policy entirely.

### 2.6 Historical policy-(c) risks — superseded by §2.7

1. **Old builds cannot be retrofitted:** any canonical-only `{backend,ref}` JSON that reaches `conversations.backend_ref` or `forked_from` while a pre-migration build still shares `CC_CONFIG_DIR` will make that old build throw `PersistenceError` on conversation reads (`conversation-row-codec.ts:223-232` has no quarantine). The shadow-encode discipline (raw-bytes contract tests) is the only guard; a missed persisted seam re-opens the breakage.
2. **Machine-snapshot rewrite relies on a deep-walk structural matcher** over opaque XState snapshot JSON (`machine_snapshot` is `z.unknown()` at the read boundary); if a future snapshot embeds an object that coincidentally matches the legacy-ref signature, the migration would rewrite it. The matcher is exact-key-set to minimize this, but it is heuristic by nature.
3. **Sequencing dependency:** migration `0005` must land after Phase 0.5 makes `runMigrations` failure fatal (`instrumentation.node.ts:91-95` currently logs and continues); if it lands first, a migration bug silently no-ops and the shadow window never opens for old rows.
4. **Old builds that mutate a migrated conversation strip the shadow `ref` key on write-back** (Zod non-strict parse), reverting individual rows to legacy shape; convergence depends on the new build's lenient decoder + next new-build write. If the lenient decode arm is deleted (shadow retirement) while any old-build writer is still alive, those reverted rows become unreadable.
5. **Stale browser tabs after server upgrade** read canonical wire payloads (`{backend,ref}`) with old client JS (e.g. `InfoDetailsPopover.tsx:26-27` reads `sessionId`/`threadId`) and display a blank ref until reload — cosmetic, accepted.
6. **Historical temporary coexistence:** this risk originally left graph-workflow engine-discriminated refs and validation review artifacts to a separate vocabulary work item. C6 closes that item with a provider-neutral graph envelope; only the deliberately separate collaboration envelope remains outside this migration's persisted-union scope.

### 2.7 Authoritative policy-(a) cutover contract (2026-07-14)

**Representation.** The only persisted target shape is canonical `{backend, ref}`. New writes do not retain `sessionId`/`threadId` shadow keys. The shared codec may decode legacy and former superset rows only so a pre-cutover or interrupted development database can converge; that tolerance does not make older binaries compatible with canonical bytes.

**Mutation-free compatibility preflight.** Each breaking version owns an append-only marker named by version in the database directory. Migration 0005 atomically and durably publishes marker 1 *before* its breaking SQLite transaction. Protocol-aware open scans marker names before constructing `better-sqlite3`; a marker greater than `KNOWN_SCHEMA_VERSION` fails before any SQLite open, schema-floor DDL, notification-table rebuild, additive-column repair, legacy workflow purge, migration execution, actor rehydration, or filesystem deletion. No marker means version `0`. `schema_migrations` remains a secondary integrity gate for legacy/unmarked databases and is rechecked after acquiring the write lock. Persistent startup pragmas such as `journal_mode=WAL` run only after that locked recheck succeeds. The append-only naming prevents concurrent lower-version publication from overwriting a higher barrier. A barrier remains if its following DB transaction fails: this conservative state is intentional, because current builds can retry while a protocol-aware older reader must not race the cutover. This protocol does not reach backward in an already-open connection's lifetime. Every lower-version process holding a connection must be quiesced for the breaking cutover; a staged scanner excludes only later opens, and pre-protocol binaries must additionally be prevented from reopening. Acceptance holds a future version only in an uncheckpointed WAL and asserts byte/hash identity for the DB, WAL, SHM, marker, and adjacent sentinels after refusal.

**One cutover transaction.** After publishing the external barrier, migration 0005 acquires `BEGIN IMMEDIATE`, rechecks `schema_migrations` under that lock, rewrites `conversations` and `project_conversations` (including nested refs in `backend_ref`, `forked_from`, and `machine_snapshot`), and inserts SQLite compatibility version `1` before committing. Helpers participate in that outer transaction and do not commit per table. A failure injected after either table or immediately before the stamp rolls back every database row and the stamp; the fail-closed external barrier remains. Umzug writes `applied_migrations` after `up`; replay is therefore required and remains idempotent.

**Concurrency.** The immediate lock is acquired before the compatibility recheck and first candidate scan. Racing current workers serialize; the second rechecks canonical rows and the `INSERT OR IGNORE` stamp under the lock. A later protocol-aware incompatible process is excluded by the already-published pre-open barrier, and a protocol-aware worker that opened earlier refuses persistent startup mutation when the newer cutover won before its under-lock recheck. If the older worker wins that lock first, it is an active lower-version process; because the protocol does not fence an open repository connection for its lifetime, operations must quiesce it before the breaking cutover proceeds. Any migration that checks schema before copying/dropping it follows the same lock-before-probe and compatibility-recheck rule.

**Irreversible filesystem effects.** The one-time legacy workflow purge is not part of schema initialization. While holding its dedicated `BEGIN IMMEDIATE` lock, it first atomically renames the live `workflows/` directory below a permanent quarantine sentinel (or creates an empty sentinel when no live directory exists), then fsyncs both destination and source parents. Only after that durable capture does the same critical section reset embedded session execution state and commit pending plus completion markers together. Captured children are removed after commit; the pending marker keeps cleanup retryable. A crash after capture but before SQL commit leaves the durable sentinel, so retry never recaptures a newly-created live `workflows/` directory. A pre-existing completion marker from the old implementation remains a no-op, while a pending-only marker from the superseded implementation is finalized without touching the live directory.

**Crash-durable file publication.** `atomicWriteFile` completes every byte and fsyncs the temporary file before rename. After rename it fsyncs the target parent, every recursively created ancestor, and the nearest pre-existing parent in bottom-up order, so both the file entry and the path that reaches it survive power loss. Only explicitly classified platform errors for unsupported directory fsync are tolerated; an `EIO` at any level propagates.

**Acceptance tests (red first):**

- future-version open with the version committed only in WAL refuses before constructing SQLite and leaves DB/WAL/SHM/marker/sentinel hashes unchanged;
- a future ledger version committed after the first read but before `BEGIN IMMEDIATE` wins the locked recheck, and the losing opener leaves persistent journal mode unchanged;
- failure after each 0005 stage leaves both tables and `schema_migrations` byte-identical to pre-run state;
- failure after barrier publication but before cutover leaves legacy DB bytes intact and the fail-closed barrier durable;
- successful 0005 commit makes both tables canonical and version `1` visible together;
- crash-after-`up`/before-Umzug-ledger replay converges without changing canonical bytes or duplicating the stamp;
- two file-backed connections racing 0005 both complete without partial visibility or startup failure;
- workflow purge failure before capture leaves SQL unchanged; failure after durable capture but before SQL commit preserves the capture sentinel, and retry deletes only quarantined legacy files while preserving a newly-created live workflow directory;
- concurrent missing-source finalizers converge on one empty capture sentinel without startup failure;
- a write into multiple missing directory levels fsyncs every created ancestor bottom-up and reports an injected ancestor `EIO`;
- older-reader behavior is proved by the version gate only for protocol-aware opens after barrier publication; deployment quiescence handles every already-open lower-version connection, while a staged scanner protects later old-version opens and pre-protocol binaries are prevented from reopening.

---

## Blocker 3 — Descriptor facet truthfulness + runtime-config payload containment (§3.1.2, §3.1.5, D9, §3.6.3)

**Status: resolved design.** Verdict up front: the §3.1.2 descriptor is implementable with **two truthfulness corrections** — (1) a single per-backend `runtimeConfigApplyTiming: "live" | "next_turn"` is factually wrong (Claude's three cascades have *three different* apply timings today, including `next-conversation` for agents), so timing becomes **per capability kind**; (2) `toneToken` values are the design-system tone names actually used (`cyan`/`violet`), not invented `backend-*` tokens. Everything else in §3.1.2 maps to a verifiable current behavior.

### 3.1 Current-state audit: the four capability systems

| System | Location | Status | Evidence |
|---|---|---|---|
| `ConversationBackendCapabilities` (6 booleans) | `src/lib/agent-backends/types.ts:11-18`, produced by `backendCapabilities()` switch at `src/lib/agent-backends/capabilities-descriptor.ts:28-55` | **Dead.** Exposed as `runtime.capabilities` (claude `conversation-runtime.ts:105-106`, codex `conversation-runtime.ts:120-121`) but zero production reads: `grep '\.capabilities'` outside MCP finds no consumer; field names (`queueWhileRunning`, `preciseFork`, `portableMcpAtStart`, `portableMcpBetweenTurns`, `askUserQuestion`, `contextWindowMetrics`) appear only in the two defining files and tests. It also **contradicts** the live systems: `queueWhileRunning: false` for codex vs `QueueCapability.acceptsWhileRunning: true` (`capabilities-descriptor.ts:19` vs `:44`), `askUserQuestion: true` for codex vs `nativeMidTurnAskUser: false` in the live view. Delete (Phase 1.2, already scheduled). |
| `QueueCapability` | `src/lib/agent-backends/capabilities-descriptor.ts:7-26` | **Live.** Consumers: `src/lib/prompt/queue.ts`, `queue-route-handlers.ts`, `src/features/session/prompt/PromptComposer.tsx`, `use-prompt-submission.ts`. Behavior-backed: Claude `in_turn` ↔ `queueUserInput` implemented (`claude/conversation-runtime.ts:374-396`); Codex `next_turn` ↔ no `queueUserInput` on `CodexConversationRuntime`. |
| `BackendCapabilityView` | `src/lib/workflows/primitives/backend-capabilities.ts:18-40`, schema `agent-call-vocabulary.ts:89-116` | **Live** (workflow layer). Two hand-maintained constants; becomes a one-function derivation from the descriptor. |
| `McpBackendCapabilities` | `src/lib/mcp/backend-capabilities.ts:61-147` | **Live and well-shaped.** Registered entries `claudeMcpCapabilities`/`codexMcpCapabilities` (`:108-144`); registered into the descriptor's `mcp` facet as-is (existing domain type, per §3.1.2). |

**Dependency inversion (the D9 target):** `agent-backends` imports provider config types *from* `agent-capabilities` today — `src/lib/agent-backends/types.ts:2-3`, `conversation.ts:10-11`, `claude/conversation-runtime.ts:31,60`, `codex/conversation-runtime.ts:42`. The twin backend-named apply ports are `defaultApplyClaudeRuntime`/`defaultApplyCodexRuntime` (`src/lib/agent-capabilities/default-deps.ts:850-892`, port interfaces `apply/helpers.ts:45-109`, invoked at `apply/cascade.ts:290,607`). Backend-identity branches: `apply-planner.ts:218-221,255-261` (codex retryable-rejected / turn-start apply), `apply/outcome.ts:238`, `runtime-composer.ts:225`. The undeclared cast: `src/lib/mcp/runtime-apply.ts:514-517` reads `isTurnActive` via `as unknown as { isTurnActive?: unknown }`.

**Note on "PreparedRuntimeConfig":** no such type exists in `src/` today (verified by grep); §3.1.5's sentence is a design *prohibition* on a tempting future shape, not a current type. This design honors it: the apply operation takes neutral input and returns a status — no prepared-payload object exists at all.

### 3.2 Truthful descriptor literals (Claude, Codex)

#### 3.2.1 Corrected facet shape (deviations from §3.1.2 marked ★)

```ts
// src/lib/agent-backends/descriptor.ts
export type CapabilityKind = "skills" | "plugins" | "agents";

// ★ per-kind timing replaces the single runtimeConfigApplyTiming field.
// "idle_live" = live-apply when idle, staged when a turn is active;
// "next_turn" = staged, promoted at the next turn boundary;
// "next_conversation" = binding fixed at session creation (Claude canUseTool).
export type CapabilityApplyTiming = "idle_live" | "next_turn" | "next_conversation";

export interface BackendCapabilityKindSupport {
  kind: CapabilityKind;
  applyTiming: CapabilityApplyTiming;
}

export interface BackendConversationCapabilities {
  queue: QueueCapability;                                   // existing type, capabilities-descriptor.ts:7-10
  continuationStrength: "precise_session" | "synthetic_thread" | "none";
  fork: "native" | "synthetic" | "unsupported";
  structuredOutput: "backend_native" | "post_validation" | "unsupported";
  contextWindowMetrics: boolean;
  nativeMidTurnAskUser: boolean;
  externalTurns: boolean;
  capabilityKinds: readonly BackendCapabilityKindSupport[]; // ★ carries timing per kind
}
```

Why ★ is required: the current cascade metadata registry (`src/lib/agent-capabilities/metadata.ts:38-86`) declares `applySemantics: "idle-live-apply"` for claude-skills and claude-plugins, **`"next-conversation"` for claude-agents** (the SDK `canUseTool` binding is fixed at session creation — `apply-planner.ts:11-13`, `claude-runtime-translator.ts:17-20`), and `"next-turn"` for both codex kinds. A single per-backend `"live" | "next_turn"` cannot express Claude truthfully; collapsing to it would silently re-break the agents cascade. The plan's promise ("timing branches collapse into reads of `runtimeConfigApplyTiming`") is preserved — the reads are just keyed by `(backend, kind)` instead of backend alone. (`compositionSupport` stays out of the descriptor: all five cascades are `"translator"` today — `metadata.ts:44,53,68,77,86` — and `verification-gated` has no current member; the planner's branch remains as-is above the seam.)

#### 3.2.2 Claude descriptor literal

```ts
// src/lib/agent-backends/claude/descriptor.ts
export function createClaudeBackendDescriptor(deps: ClaudeDescriptorDeps): AgentBackendDescriptor {
  return {
    id: "claude",
    metadata: {
      label: "Claude",                          // BackendToggle.tsx:14, ComposerModeChip.tsx:11-14
      toneToken: "cyan",                        // ComposerModeChip.tsx:19-31 (cyan Claude / violet Codex)
      skillTriggerPrefix: "/",                  // PromptEditor.tsx:121, commands/service.ts:133,162
      models: [
        { id: "fable",  label: "Fable",  description: "Most capable",   effortLevels: ["low","medium","high","xhigh","max"] },
        { id: "opus",   label: "Opus",   description: "Highly capable", effortLevels: ["low","medium","high","xhigh","max"] },
        { id: "sonnet", label: "Sonnet", description: "Balanced",       effortLevels: ["low","medium","high"] },
        { id: "haiku",  label: "Haiku",  description: "Fastest",        effortLevels: [] },
      ],                                        // ids: agent-backends/schemas.ts:4; efforts: MODEL_EFFORT_LEVELS schemas.ts:39-44;
                                                // labels/descriptions: ModelSelector.tsx:17-22 (one of the 3 hand-copied catalogs)
      defaultModelId: "opus",                   // getDefaultClaudeModel, schemas.ts:8-10
      defaultTimeoutMs: null,                   // no backend-level configured default; null → resolveConfiguredTimeoutMs → 0 = unbounded (timeout.ts:1-6)
    },
    conversation: {
      factory: deps.conversationFactory,        // existing registration, registry.ts:3
      continuity: deps.continuity,              // Phase 1.6, out of this blocker's scope
      runtimeConfig: createClaudeRuntimeConfigAdapter(deps),   // §3.3 below
      capabilities: {
        queue: { acceptsWhileRunning: true, deliveryTiming: "in_turn" },  // capabilities-descriptor.ts:16-17; behavior: queueUserInput claude/conversation-runtime.ts:374-396
        continuationStrength: "precise_session",  // backend-capabilities.ts:20 (persistent QuerySession subprocess)
        fork: "native",                           // sdkForkSession, conversations/service.ts:2,449-462 (forkMode "native"; synthetic fallback on anchor loss)
        structuredOutput: "backend_native",       // outputFormat → SDK structured output: query-session.ts:404,1085; backend-capabilities.ts:22
        contextWindowMetrics: true,               // contextTokens + contextWindowMax populated: claude/conversation-runtime.ts:313-314; backend-capabilities.ts:23
        nativeMidTurnAskUser: true,               // backend-capabilities.ts:24 (SDK-level AskUserQuestion via canUseTool)
        externalTurns: true,                      // buildExternalTurnHandler: claude/conversation-runtime.ts:542,669
        capabilityKinds: [
          { kind: "skills",  applyTiming: "idle_live" },          // metadata.ts:38-44
          { kind: "plugins", applyTiming: "idle_live" },          // metadata.ts:47-53
          { kind: "agents",  applyTiming: "next_conversation" },  // metadata.ts:62-68
        ],
      },
    },
    tasks: {
      runner: deps.taskRunner,                  // claude/task-runner.ts
      structuredOutput: "backend_native",       // outputSchema → outputFormat on query: claude/task-runner.ts:136-137,192
    },
    mcp: claudeMcpCapabilities,                 // mcp/backend-capabilities.ts:108-125 (registered object, unchanged)
    errors: deps.failureClassifier,             // Phase 1.5; replaces getLikelyStaleResumeFailureMessage string-grep (collaboration/agent-caller-production.ts:276)
  };
}
```

#### 3.2.3 Codex descriptor literal

```ts
// src/lib/agent-backends/codex/descriptor.ts
{
  id: "codex",
  metadata: {
    label: "Codex",                             // BackendToggle.tsx:15
    toneToken: "violet",                        // ComposerModeChip.tsx:19-31; tokens.css:572 (--cc-codex-violet-a35)
    skillTriggerPrefix: "$",                    // PromptEditor.tsx:121 (`char === "$" → backend === "codex"`), MobilePromptToolbar.tsx:254
    models: [
      { id: "gpt-5.6-sol",   label: "GPT-5.6 Sol",   description: "Flagship",            effortLevels: ["low","medium","high","xhigh","max","ultra"] },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", description: "Balanced",            effortLevels: ["low","medium","high","xhigh"] },
      { id: "gpt-5.6-luna",  label: "GPT-5.6 Luna",  description: "Fast & affordable", effortLevels: ["low","medium","high","xhigh"] },  // ModelSelector.tsx:27-31
      { id: "gpt-5.5",       label: "GPT-5.5",       description: "Previous flagship",   effortLevels: ["low","medium","high","xhigh"] },
      { id: "gpt-5.4",       label: "GPT-5.4",       description: "Previous generation", effortLevels: ["low","medium","high","xhigh"] },
      { id: "gpt-5.4-mini",  label: "GPT-5.4 Mini",  description: "Balanced",            effortLevels: ["low","medium","high","xhigh"] },
      { id: "gpt-5.4-nano",  label: "GPT-5.4 Nano",  description: "Fastest",             effortLevels: ["low","medium","high","xhigh"] },
    ],                                          // ids: codexModelSchema schemas.ts:69-77; efforts: CODEX_MODEL_REASONING_LEVELS schemas.ts:127-135; labels: ModelSelector.tsx:24-36
    defaultModelId: "gpt-5.4",                  // getDefaultCodexModel, schemas.ts:81-83; codexConfigSchema default schemas.ts:112
    defaultTimeoutMs: null,                     // codexConfigSchema.timeoutMs nullable optional, schemas.ts:114
  },
  conversation: {
    capabilities: {
      queue: { acceptsWhileRunning: true, deliveryTiming: "next_turn" },  // capabilities-descriptor.ts:18-19; CC queue drains next turn, runtime has no queueUserInput
      continuationStrength: "synthetic_thread",  // backend-capabilities.ts:29 — durable thread id resumed per turn via resumeThread (codex/conversation-runtime.ts:214-217); process re-spawned each turn, no live in-turn session
      fork: "synthetic",                         // conversations/service.ts:449 forkMode "synthetic" path; buildSyntheticForkSeed service.ts:27
      structuredOutput: "backend_native",        // outputSchema on runStreamed: codex/conversation-runtime.ts:241-243 (+ JSON parse of final message :328-333); backend-capabilities.ts:31
      contextWindowMetrics: false,               // contextWindowMax always null: codex/conversation-runtime.ts:347; backend-capabilities.ts:32
      nativeMidTurnAskUser: false,               // backend-capabilities.ts:33 (cctl-based asking exists for both backends but is not an SDK-native mid-turn tool)
      externalTurns: false,                      // no onExternalTurnEvent wiring anywhere in codex/conversation-runtime.ts
      capabilityKinds: [
        { kind: "skills",  applyTiming: "next_turn" },  // metadata.ts:71-77
        { kind: "plugins", applyTiming: "next_turn" },  // metadata.ts:80-86
      ],                                                // no "agents" kind for codex — AGENT_CAPABILITY_CASCADE_KINDS, agent-capabilities/schemas.ts:17-23
    },
    /* factory, continuity, runtimeConfig as for Claude */
  },
  tasks: { runner: deps.taskRunner, structuredOutput: "backend_native" },  // outputSchema native: codex/task-runner.ts:333,354-358
  mcp: codexMcpCapabilities,                   // mcp/backend-capabilities.ts:127-144
  errors: deps.failureClassifier,
}
```

Descriptors are built by `createXxxBackendDescriptor(deps)` factories (method-syntax deps interfaces per engineering-principles) so the conformance suite can run them against fake SDK ports without `vi.mock`.

### 3.3 The runtime-config apply seam (D9 resolved)

#### 3.3.1 Neutral seam types — defined in `agent-backends` (the lower layer)

The restored dependency direction is `agent-capabilities → agent-backends`, so the neutral vocabulary lives in the seam module, and `agent-capabilities` imports it (today it's backwards: `agent-backends/types.ts:2-3` et al. import from `agent-capabilities`).

```ts
// src/lib/agent-backends/runtime-config.ts  (all-neutral; no provider types)
export interface ResolvedCapabilityItem {
  itemId: string;
  enabled: boolean;
  /** Which cascade layer decided it; "native" = no CC override. */
  originLayer: "native" | "global" | "project" | "session" | "conversation";
}
export interface ResolvedCapabilityKind {
  kind: CapabilityKind;
  items: readonly ResolvedCapabilityItem[];
}
export interface ResolvedCapabilityCascade {
  backend: AgentBackendId;
  kinds: readonly ResolvedCapabilityKind[];
}

export type RuntimeConfigApplyResult =
  | { status: "applied" }
  | { status: "deferred"; reason: "turn_active" }
  | { status: "rejected"; error: string };

export interface BackendRuntimeConfigAdapter {
  readonly backend: AgentBackendId;
  /** Translate and apply below the seam; no provider payload escapes. */
  apply(input: {
    runtime: ConversationBackendRuntime;
    resolved: ResolvedCapabilityCascade;
  }): Promise<RuntimeConfigApplyResult>;
}
```

No `PreparedRuntimeConfig` and no `payload: unknown` exists anywhere: translation output (`ClaudeRuntimeCapabilityConfig` — `claude-runtime-translator.ts:64-77`; `CodexRuntimeCapabilityConfig`) becomes a private type inside the adapter directory, produced and consumed within one `apply()` call frame.

#### 3.3.2 What moves, what stays

**Moves into `src/lib/agent-backends/claude/runtime-config/`:** `claude-runtime-translator.ts`, `claude-plugin-translator.ts`, `claude-agent-suppression.ts` (already imported by the Claude runtime at `claude/conversation-runtime.ts:60` — it is provider knowledge), plus a small `plugin-native-records.ts` extracted from `claude-discovery.ts` (the reader that produces `ClaudePluginNativeRecord` from native settings — see §3.3.4).
**Moves into `src/lib/agent-backends/codex/runtime-config.ts`:** `codex-runtime-translator.ts`.

**`agent-capabilities/` keeps:** the override stores (`global-store.ts`, `scope-store.ts`), resolver, `mutation-service.ts`, discovery (`claude-discovery.ts`, `codex-discovery.ts` — item enumeration + diagnostics for the UI/resolver), `runtime-hashes.ts`, `apply-planner.ts` (dispositions now keyed off descriptor `applyTiming`, zero `backend ===` branches), the apply service orchestration (`apply/`), metadata (minus `applySemantics`, which the descriptor now owns), routes, SSE invalidation. It calls exactly one port:

```ts
// replaces applyClaudeRuntime/applyCodexRuntime (apply/helpers.ts:98-109, default-deps.ts:850-892)
applyRuntimeConfig(input: {
  conversation: ApplyConversationIdentity;
  resolved: ResolvedCapabilityCascade;
}): Promise<RuntimeConfigApplyResult>;
```

whose default implementation resolves the runtime from `runtime-registry` and the descriptor from the registry, then calls `descriptor.conversation.runtimeConfig.apply({ runtime, resolved })`. Inside the adapter, the concrete runtime type is known (same directory), so `applyClaudeCapabilityConfig`/`applyCodexCapabilityConfig` (`conversation.ts:203-215`) move **off the neutral `ConversationBackendRuntime` interface** and become adapter-internal methods. `ClaudeCapabilityApplyResult.skipped-turn-active` (`conversation.ts:30-33`) maps to `{ status: "deferred", reason: "turn_active" }`.

**Conversation-start seeding goes through the same containment:** `ConversationToolingOverrides` (`types.ts:20-30`) drops `claudeCapabilityConfig`/`codexCapabilityConfig` and gains neutral `capabilities?: ResolvedCapabilityCascade`; each factory translates internally at `createRuntime`. The actor's per-backend compose seeds (`default-deps.ts:894-954,1065-1107`, `actor-implementations.ts:781,835,1750` branches) collapse to one neutral compose result + one seed field.

**`mcp/runtime-apply.ts`:** the `as unknown as { isTurnActive?: unknown }` probe (`runtime-apply.ts:514-517`) is deleted; MCP's between-turns apply consumes the declared result — `deferred/turn_active` ⇒ its existing `defer-running` path.

#### 3.3.3 Cascade taxonomy: `{backend, kind}` with a persistence codec — no data migration

In-memory taxonomy becomes `{ backend: AgentBackendId, kind: CapabilityKind }`, validated against the descriptor's `capabilityKinds` (a `{backend:"codex", kind:"agents"}` pair fails Zod validation loudly, replacing the ownership refinement at `agent-capabilities/schemas.ts:36-62`). The **on-disk representation stays the five strings** (`"claude-skills"` … `"codex-plugins"`, `schemas.ts:17-23`) via a bijective codec at the store boundary (`` encodeCascadeKind({backend,kind}) = `${backend}-${kind}` ``, decode fails loudly on unknown strings). This honors §3.1.1's warning against bundling persisted-shape rewrites: overrides persisted in `config.json` and in project/session/conversation state keep their shape; older builds keep reading them.

#### 3.3.4 The two hard wrinkles, decided

**Native plugin records.** Claude's plugin translation computes a minimal delta against native `settings` entries (`claude-runtime-translator.ts:52-61` takes `nativePluginRecords` from `discoverClaudePlugins`). Those records are provider knowledge and may not cross the seam upward. Decision: the reader producing `ClaudePluginNativeRecord` moves into `agent-backends/claude/runtime-config/plugin-native-records.ts`; the adapter reads native records **itself** at apply/creation time, and `claude-discovery.ts` imports the reader from the adapter (legal direction: capabilities → backends). The `nativeRecords` side-channel through `ComposeConversationStartResult` (`runtime-composer.ts:108-110`, `default-deps.ts:236-248,289`) is deleted.

**Hash basis.** Runtime idempotency hashes are currently computed from translator *emissions* (`emittedRows`, `claude-runtime-translator.ts:79-84`; `computeCascadeRuntimeHash` in `runtime-hashes.ts`), which the seam now hides. Decision: hashes are computed **above the seam from the resolved cascade** — per kind, the rows with `originLayer !== "native"` (deterministic, seam-neutral; equals today's emissions for skills/agents, differs for plugins where the emission was a native-delta). Consequence: each existing conversation's persisted `appliedHash` mismatches once after upgrade, producing exactly one idempotent re-apply (the planner already treats hash drift safely — `apply-planner.ts:81-87`). Covered by an acceptance test (§3.5.2).

**Rejected alternatives (brief):** (a) single per-backend `runtimeConfigApplyTiming` — untruthful for claude-agents, see §3.2.1; (b) translators stay in `agent-capabilities` with adapters registered at a composition root — rejected by D9 itself (provider knowledge above the seam, dependency direction stays inverted); (c) a `PreparedRuntimeConfig` token with `payload: unknown` — §3.1.5 forbids it and nothing needs it (translate-and-apply is one call frame); (d) migrating persisted cascade-kind strings now — needless breaking rewrite, codec is bijective and free; (e) adapter re-reads native plugin settings *and* discovery keeps its own copy of the reader — duplicate provider knowledge, rejected for the shared-reader import.

### 3.4 Conformance suite: capability ↔ behavior coherence (§3.1.7)

`src/lib/agent-backends/conformance.ts` (test-only), `describeBackendConformance(descriptor, harness)` where `harness` supplies fake SDK ports via the descriptor factories' deps (no `vi.mock`). Runs against Claude, Codex, and a parameterized test descriptor. Assertions:

1. **Id agreement:** `descriptor.id === conversation.factory.backend === tasks.runner.backend === mcp.backend === conversation.runtimeConfig.backend === conversation.continuity.backend`.
2. **Metadata validity:** `defaultModelId ∈ models[].id`; every `effortLevels` entry ∈ `effortLevelSchema.options` (`agent-backends/schemas.ts:18-27`); non-empty `label`; `skillTriggerPrefix ∈ {"/", "$"}`; model ids unique.
3. **Facet completeness:** at least one execution facet; `registerBackend` rejects duplicates and facetless descriptors.
4. **Queue coherence:** `deliveryTiming === "in_turn"` ⇔ the created runtime implements `queueUserInput`; `"next_turn"` ⇒ it does not (pins claude `conversation-runtime.ts:374` vs codex's absence).
5. **Context-metrics coherence:** `contextWindowMetrics === false` ⇒ a completed fake turn's `contextWindowMax === null` (codex `conversation-runtime.ts:347`); `true` ⇒ populated from the harness turn.
6. **External-turn coherence:** `externalTurns === false` ⇒ a runtime created with `onExternalTurnEvent` never emits `external_turn_*` when the harness injects an out-of-band frame; `true` ⇒ it does.
7. **Structured-output coherence:** declared `backend_native` ⇒ the harness observes `outputSchema`/`outputFormat` forwarded to the SDK port on both facets (claude `task-runner.ts:136-192`, codex `task-runner.ts:333`).
8. **Runtime-config kind coherence:** `runtimeConfig.apply` with a resolved cascade containing exactly `capabilityKinds` succeeds; an undeclared kind (e.g. codex+agents) returns `{ status: "rejected" }` — never a silent drop.
9. **Apply-timing coherence:** for an `idle_live` kind, apply during a harness-active turn returns `{ status: "deferred", reason: "turn_active" }`; for `next_turn` kinds it returns `applied` (staging semantics) regardless of turn state; `next_conversation` kinds are never live-applied.
10. **Ref discipline:** `continuity.*` rejects a ref whose `backend !== descriptor.id`; `fork()`'s happy-path outcome kind matches the declared `fork` capability (`native` → `{kind:"native"}`, `synthetic` → `{kind:"synthetic_seed"}`, `unsupported` → `{kind:"unsupported"}`).
11. **Failure classification:** `errors.classify` returns schema-valid `AgentFailureClassification` for timeout / abort / unknown-object inputs and never throws.

### 3.5 Acceptance tests (specified now; red-first where behavior changes)

#### 3.5.1 Phase 1.2 — descriptor + registry + catalog

| Test file | Asserts | Red-first? |
|---|---|---|
| `src/lib/agent-backends/descriptor.test.ts` (new) | `registerBackend` atomic registration; duplicate-id rejection; requires ≥1 execution facet; `getBackendDescriptor`/`listBackends`; resettable bootstrap independent of import order (contrast: today registration is import-side-effect only, `registry.ts:3-6`, pinned by `registry-bootstrap.test.ts`) | **Yes** — none of these APIs exist |
| `src/lib/agent-backends/conformance.test.ts` (new) | The §3.4 suite green for Claude, Codex, and the parameterized test descriptor | **Yes** |
| `src/lib/workflows/primitives/backend-capabilities.test.ts` (extend, then retire constants) | Parity pin first: view derived from the descriptor deep-equals `CLAUDE_CAPABILITY_VIEW`/`CODEX_CAPABILITY_VIEW` literals (`backend-capabilities.ts:18-34`); then the hand-constants are deleted and the derivation is the only source | Parity-pin pattern |
| `src/lib/agent-backends/capabilities-descriptor.test.ts` (repoint, then delete with module) | `queueCapabilityForBackend` parity against descriptor `conversation.capabilities.queue`; `backendCapabilities()` + `ConversationBackendCapabilities` deleted with zero references | Parity-pin |
| `src/lib/agent-backends/route-handlers.test.ts` (new) | `GET /api/agent-backends` serves `listBackends()` metadata + capability labels; response Zod-parses; **no provider config payloads in the wire shape** | **Yes** |
| `src/components/ModelSelector.test.tsx` (extend) | Renders models/labels/default from `useBackendCatalogQuery` data; `CLAUDE_MODEL_OPTIONS`/`CODEX_MODEL_OPTIONS` (`ModelSelector.tsx:17-36`) deleted; unknown backend id fails loudly (no silent claude coercion — pins the current `backend === "codex" ? … : CLAUDE` fallback at `ModelSelector.tsx:42` as the anti-behavior) | **Yes** for the loud-failure behavior |
| Seam ratchet (`scripts/seam-adoption.ts`, Phase 0.4) | Hardcoded `["claude","codex"]` arrays / label maps ceiling set to observed count, ratcheted to 0 in 1.2 (offenders include `BackendToggle.tsx:14-15`, `ComposerModeChip.tsx:11-14`, `MessageRow.tsx:134`, `TypingIndicator.tsx:70`, `ExecutionContextNode.tsx:303-417`, `MobilePromptToolbar.tsx:254`) | n/a (CI gate) |

#### 3.5.2 Phase 1.3 — neutral runtime-config apply

| Test file | Asserts | Red-first? |
|---|---|---|
| `src/lib/agent-backends/runtime-config.test.ts` (new) | `ResolvedCapabilityCascade` Zod validation vs `capabilityKinds` (codex+agents rejected); `RuntimeConfigApplyResult` mapping table (`skipped-turn-active` → `deferred/turn_active`) | **Yes** |
| `src/lib/agent-backends/claude/runtime-config/*.test.ts` (moved from `agent-capabilities/claude-runtime-translator.test.ts`, `claude-plugin-translator.test.ts`, `claude-agent-suppression.test.ts`) | Existing translation behavior preserved (moved tests stay green); **new:** adapter `apply` on a turn-active runtime returns `deferred/turn_active`; on a dead runtime returns `rejected`; native plugin records read adapter-side (fake fs dep), no `nativeRecords` in any seam input | New assertions red-first |
| `src/lib/agent-backends/codex/runtime-config.test.ts` (moved from `codex-runtime-translator.test.ts`) | Translation preserved; apply stores config for next-turn ingestion and returns `applied`; `rejected` when runtime closed | Move + red-first for apply |
| `src/lib/agent-capabilities/apply-planner.test.ts` (rewrite affected cases) | Planner input takes neutral `applyTiming` (not `metadata.applySemantics`, not `backend`); the codex-retryable-rejected disposition (`apply-planner.ts:218-221`) and turn-start apply split (`:255-267`) reproduce as `applyTiming === "next_turn"` reads; **zero `backend ===` occurrences in the module** (lint/architecture assertion) | **Yes** — signature change |
| `src/lib/agent-capabilities/apply/service.test.ts` (extend) | Single `applyRuntimeConfig` port replaces the twin ports; `deferred/turn_active` produces `staged-idle` state exactly as today's `skipped-turn-active` does; twin-port symbols (`ClaudeApplyPortInput`, `CodexApplyPortInput`, `defaultApplyClaudeRuntime`, `defaultApplyCodexRuntime`) no longer exist | **Yes** |
| `src/lib/mcp/runtime-apply.test.ts` (extend) | Turn-active deferral derived from the declared apply result; the `as unknown as` probe (`runtime-apply.ts:514-517`) deleted (typecheck + behavior test: deferred result ⇒ `defer-running`) | **Yes** |
| `src/lib/agent-capabilities/schemas.test.ts` (extend) | `{backend,kind}` ⇄ persisted-string codec bijective over all five kinds; unknown persisted string fails loudly; persisted override fixtures from a pre-change snapshot still parse (round-trip durability per project testing policy, using `createPersistenceFixture()` where state-store rows are involved) | **Yes** for codec |
| Hash-basis migration test (in `apply/service.test.ts`) | A conversation persisted with an old emissions-basis `appliedHash` triggers exactly one re-apply on the next mutation/turn-start, then returns `idempotent-no-op` on repeat | **Yes** |
| Dependency-direction architecture test / ESLint seam rule (Phase 0.4 rule, ratcheted to 0 here) | Zero imports of `@/lib/agent-capabilities/**` from `src/lib/agent-backends/**` (current offenders: `types.ts:2-3`, `conversation.ts:10-11`, `claude/conversation-runtime.ts:31,60`, `codex/conversation-runtime.ts:42`) | n/a (CI gate) |

### 3.6 Open risks

1. **Hash-basis change** (§3.3.4): the plugins cascade previously hashed a native-delta; the neutral basis ignores native-state drift, so a user editing `settings.json` outside CC no longer perturbs the idempotency hash. Correctness holds (the adapter re-translates fresh on every apply), but a native-only change while CC state is hash-stable won't trigger a proactive re-apply until the next mutation/turn — one spurious re-apply per existing conversation on upgrade (test-covered). Judged acceptable; flag in the 1.3 slice review.
2. **`continuationStrength: "synthetic_thread"` naming debt:** Codex resume is a *native* SDK `resumeThread` (`codex/conversation-runtime.ts:214-217`); the enum name suggests otherwise. Semantics are documented in the descriptor (thread-granular, per-turn re-materialization vs Claude's live session), value unchanged to preserve `BackendCapabilityView` parity. A rename is a possible Phase 3 cleanup, not now.
3. **Double read of native plugin settings** (discovery for item lists above the seam, adapter for delta records below): same file, two readers, small TOCTOU window between compose-hash and apply-translate. The adapter's fresh read wins at apply time, so worst case is one extra re-apply; monitor in the conformance harness.
4. **Catalog staleness vs SDK reality:** descriptor `models`/`effortLevels` remain hand-maintained constants (as today, `schemas.ts:39-44,127-135`); the descriptor centralizes but cannot verify them against the provider. The conformance suite checks internal consistency only.
5. **Approved plan amendment:** per-kind `capabilityKinds[].applyTiming` replaces the original plan's single `runtimeConfigApplyTiming` field (required for truthfulness — Claude agents are `next-conversation`). Alex approved this on 2026-07-13.
6. **`defaultTimeoutMs` is currently distinguishing-value-free** (null for both; real timeouts come from the config cascade — `codexConfigSchema.timeoutMs`, `resolveConfiguredTimeoutMs`'s 0-sentinel). Kept because §3.1.2 declares it and the catalog route will serve it; if Alex prefers YAGNI-deletion, it is a one-line drop with no consumer impact.

---

## Blocker 4 — Closed-registry consumer-locality criterion (§3.1.7, §3.6.4)

**Status: implemented and approved.** Alex approved the single sanctioned `as`-narrowing that mints the `"testfake"` id inside the test-only support module on 2026-07-13. The rejected alternatives remain below as design rationale.

### 4.1 Current state (evidence)

**Registry today** — `src/lib/agent-backends/registry-core.ts` holds two module-level `Map<AgentBackendId, …>` (`:8-12`), per-kind registration functions `registerConversationBackendFactory`/`registerTaskRunner` (`:14-26`), and throwing getters (`:28-48`). There is **no descriptor, no `registerBackend`, no reset function**. Bootstrap is side-effect imports in `src/lib/agent-backends/registry.ts:3-6` (`import "./claude/conversation-runtime"` etc.). The only test-reset mechanism today is `vi.resetModules()` + dynamic re-import (`registry-bootstrap.test.ts:5-7`). The `_resetForTesting()` at `runtime-registry.ts:47` is a *different* registry (per-conversation live runtimes), but it is the precedent for the reset idiom.

**Identity today** — canonical `agentBackendSchema = z.enum(["claude","codex"])` at `src/lib/shared/schemas.ts:7-8`; hand-written duplicate `AgentBackendId = "claude" | "codex"` at `src/lib/agent-backends/types.ts:5` (deleted in Phase 1.1); discriminated ref union twice: `types.ts:7-9` and `agent-backends/schemas.ts:12-16`.

**Consumers still branch on identity** — 55 backend-identity branch lines in `src/lib/` outside `agent-backends/` (grep `backend === "claude"|backend === "codex"|agentBackend === `, non-test; the same grep over all of `src/` including UI files yields 86 — the UI catalog consumers are exempt from corpus E per D-B4.4 and are handled by Phase 1.2's catalog migration). Representative: `workflows/primitives/workflow-agent-caller.ts:239,307,414` + four provider-named deps methods (`createClaudeConversation`/`validateClaudeConversation`/`startCodexThread`/`resumeCodexThread`, `:114-130`); `workflows/primitives/backend-capabilities.ts:39` (`backend === "codex" ? CODEX_CAPABILITY_VIEW : CLAUDE_CAPABILITY_VIEW` — note an unknown id silently gets the Claude view); `workflows/conversation/actor-implementations.ts` (10 branch lines; registry surface at `:246,:435,:576,:612,:1258,:2609`); `mcp/runtime-apply.ts:244-262,:373`; `codex-runs/service.ts:376` (hardcoded `getTaskRunner("codex")`); `prompt/sdk-driver.ts:34,:826`; `conversations/service.ts` (3 lines).

**Transcript envelope** — `agent-backends/transcript.ts:11-17` (`agentTranscriptEntrySchema` = `{seq, backend, type, raw}`); non-adapter consumers: `workflow-graph/execution-logger.ts`, `workflow-graph/validator-runner.ts`, `workflows/conversation/execute-workflow-task-run.ts`, `workflows/conversation/types.ts`.

### 4.2 Resolved design

#### D-B4.1 — Registry extension + explicit resettable bootstrap (Phase 1.2, restated here as the locality test's substrate)

`registry-core.ts` gains, alongside the (ratchet-migrating, then deleted) per-kind getters:

```ts
export function registerBackend(descriptor: AgentBackendDescriptor): void;
// - runtime-validates descriptor.id ∈ agentBackendSchema (fail loud, no coercion)
// - requires at least one execution facet (conversation | tasks)
// - rejects duplicate ids
export function getBackendDescriptor(id: AgentBackendId): AgentBackendDescriptor; // throws on missing
export function listBackends(): readonly AgentBackendDescriptor[];               // registration order

// Test-only seams (same file, underscore-prefixed per runtime-registry.ts:47 precedent):
export function _registerBackendForTesting(descriptor: AgentBackendDescriptor): void;
// identical to registerBackend EXCEPT it skips the id-enum runtime check
export function _resetBackendRegistryForTesting(): void; // clears the descriptor map
```

The internal map is keyed by `string` (it already is at runtime); the id-enum check is *policy in `registerBackend`*, which is exactly the door the parameterized test registry needs: production registration stays closed at runtime, `_registerBackendForTesting` is the one sanctioned bypass. Bootstrap becomes an explicit, idempotent `bootstrapBackends()` (registering the Claude + Codex descriptors) exported from `registry.ts`; the side-effect imports at `registry.ts:3-6` are replaced by a call to it, and tests do `beforeEach(_resetBackendRegistryForTesting)` + explicit registration instead of the `vi.resetModules()` dance.

An ESLint/ratchet guard forbids importing `@/lib/agent-backends/testing/**` and calling `_registerBackendForTesting`/`_resetBackendRegistryForTesting` outside `*.test.ts` (added to the §3.5 seam list).

#### D-B4.2 — How `"testfake"` enters the type system (approved 2026-07-13)

The production id schema stays closed (`agentBackendSchema`, `shared/schemas.ts:7`). The widening lives in exactly one test-support module:

```ts
// src/lib/agent-backends/testing/testfake-backend.ts  (test-only; lint-fenced per D-B4.1)
export const testWidenedAgentBackendSchema = z.enum(["claude", "codex", "testfake"]);
// The ONE sanctioned type-level fiction in the codebase: "testfake" is runtime-verified
// against the widened schema, then narrowed to AgentBackendId so it can flow through
// consumer code typed against the closed union. Production registration rejects it
// (registerBackend id-enum check); only _registerBackendForTesting accepts it.
export const TESTFAKE_BACKEND_ID =
  testWidenedAgentBackendSchema.parse("testfake") as AgentBackendId;
```

This compiles as a plain narrowing assertion (`AgentBackendId` ⊂ the widened union — no `as unknown as`), but at runtime the value is not a member of `AgentBackendId`, so it bends the "as only after a verified runtime check" steering rule. Alex approved this single test-only exception on 2026-07-13. Rejected alternatives:

- *Module augmentation* (`declare module "@/lib/shared/schemas" { … }` extensible-interface idiom): the augmentation is program-wide under one tsconfig, so `"testfake"` would become assignable **everywhere** during `bun run typecheck`, silently weakening the closed-enum guarantee for production files too.
- *Env-gated schema* (schema includes `"testfake"` when `NODE_ENV === "test"`): production behavior varies under test; the thing being proven (consumers work against the *production* schema's consumers) is no longer what runs.
- *Keying consumers by `string`*: destroys the closed-union guarantee at every consumer, the exact opposite of P10's "curated static set is the product".

#### D-B4.3 — The parameterized test-only descriptor (`createTestFakeBackend`)

`src/lib/agent-backends/testing/testfake-backend.ts` exports `createTestFakeBackend(overrides?): { descriptor: AgentBackendDescriptor; calls: TestFakeCallLog }`. Every operation records into `calls` (an append-only array of `{op, input}`) so assertions can prove the *descriptor* was exercised, not a fallback branch. Minimal contents, truthful to the conformance suite's capability↔behavior coherence checks:

- **`id`**: `TESTFAKE_BACKEND_ID`.
- **`metadata`**: `{ label: "Test Fake", toneToken: "cyan" (any registered design-system tone per Blocker 3 §3.2.1's toneToken correction), skillTriggerPrefix: "/", models: [{ id: "fake-1", label: "Fake 1", description: "deterministic scripted model", effortLevels: [] }], defaultModelId: "fake-1", defaultTimeoutMs: null }`.
- **`conversation` facet**:
  - `factory`: implements `ConversationBackendFactory` (`conversation.ts:278-287`). `createRuntime` returns an in-memory `ConversationBackendRuntime` (`conversation.ts:158-228`): `status: "alive"`, scripted `sendTurn` that emits, in order, `backend_init` with `{ backend: "testfake", ref: "fake-ref-1" }`, one `content` text block, two `transcript_entry` envelopes whose `raw` is a shape **no real backend produces** (`{ type: "testfake_frame", marker: <uuid> }` — the marker is how transcript assertions prove byte-faithful passthrough), `input_accepted`, then resolves a deterministic `ConversationBackendTurnResult` (fixed `costUsd`/`durationMs`/`numTurns`, `contextTokens: null` matching `contextWindowMetrics: false`). `close()` flips `status` to `"dead"`. No optional methods except `applyPortableMcpConfig` (records + returns applied) — used by the MCP-apply section.
  - `continuity` (`BackendContinuityAdapter`, §3.1.4): in-memory — `start` mints `fake-ref-<n>`, `validate` returns `{status:"valid"}` iff the ref was minted by this instance (else `stale`), `resumeOrRecover` echoes the ref (`recovered: false`), `fork` returns `{ kind: "unsupported" }`, matching the declared capability.
  - `runtimeConfig` (`BackendRuntimeConfigAdapter`, §3.1.5): records; returns `{ status: "applied" }` for a cascade containing only the declared `agents` kind, `{ status: "rejected" }` for any undeclared kind (conformance check 8 — never a silent drop).
  - `capabilities` (`BackendConversationCapabilities`, per Blocker 3 §3.2.1's corrected facet shape): `queue: { acceptsWhileRunning: false, deliveryTiming: "next_turn" }` (shape per `capabilities-descriptor.ts:7-10`), `continuationStrength: "synthetic_thread"`, `fork: "unsupported"`, `structuredOutput: "post_validation"`, `contextWindowMetrics: false`, `nativeMidTurnAskUser: false`, `externalTurns: false`, `capabilityKinds: [{ kind: "agents", applyTiming: "next_turn" }]` — a `(kind, timing)` pair neither real backend declares (Claude agents is `next_conversation`, Codex has no `agents` kind), per the distinct-value rule below.
- **`tasks` facet**: `runner` implements `AgentTaskRunner` (`task.ts:56-59`) — scripted `AgentTaskResult` with `text`, fixed `usage`, `transcript` of two `testfake_frame` envelopes, `backendRef: { backend: "testfake", ref: "fake-task-ref-1" }`; `structuredOutput: "post_validation"`.
- **`mcp`**: an `McpBackendCapabilities` (`mcp/backend-capabilities.ts:61-69`) with `serverDisable: "native"`, `betweenTurnApply` set to the staging mode, `toolDiscovery: { preferred: "probe", probeFallback: false }` — chosen so the MCP-apply disposition observable **differs from both Claude's and Codex's**, making a fallback-to-either-real-backend branch detectable.
- **`errors`** (`AgentFailureClassifier`, §3.1.4): AbortError → `{kind:"aborted", retryable:false}`; a sentinel `TestFakeStaleRefError` → `{kind:"stale_resume_ref", retryable:true}`; everything else → `{kind:"backend_error", retryable:false}`.

Design rule baked into the fake: **wherever a capability value could be shared with Claude or Codex, pick the third option or a distinct value** (e.g. `deliveryTiming` differs from Claude, `toolDiscovery.preferred` differs from both). A consumer that secretly falls back to a real backend's constants then produces an observably wrong value, which the behavioral assertions catch (today `capabilityViewForBackend` at `backend-capabilities.ts:39` would return the *Claude* view for `"testfake"` — the fake's `continuationStrength: "synthetic_thread"` vs Claude's `"precise_session"` makes that failure visible).

#### D-B4.4 — The measured criterion: "zero execution-consumer edits"

**Acceptance contract for a new supported backend `X`:** the diff touches only (1) `src/lib/shared/schemas.ts` — add `"X"` to `agentBackendSchema`; (2) a new `src/lib/agent-backends/X/**` adapter directory + its descriptor; (3) the `bootstrapBackends()` registration list; plus tests/fixtures. **The execution-consumer corpus E (below) has zero changed lines.**

**Corpus E — the modules that count as execution consumers** (per §3.1.7's six categories, pinned to files):

| # | Category | Files | Enforced from |
|---|---|---|---|
| E1 | AgentCall | `workflows/primitives/agent-call-facade.ts`, `agent-call-conversation.ts`, `agent-call-task.ts`, `agent-call-vocabulary.ts`, `backend-capabilities.ts` | 1.2 (capability derivation) / 1.8 (facade drive); deepened checks in 3.1 |
| E2 | Machines | `workflows/conversation/machine.ts`, `actor-implementations.ts`, `execute-workflow-task-run.ts` | 1.5 (disposition reads) — full drive staged to 3.5 for the actor pipeline |
| E3 | Lane modules | `workflows/primitives/{workflow-agent-caller,lane-service,lane-store,lane-scheduler,lane-vocabulary,graph-workflow-lane-adapter}.ts` | 3.2 (staged: provider-named deps die there) |
| E4 | Transcript consumers | `workflow-graph/execution-logger.ts`, `workflow-graph/validator-runner.ts` (transcript path), `workflows/conversation/{execute-workflow-task-run,types}.ts` | 1.4 |
| E5 | MCP apply | `mcp/runtime-apply.ts` | 1.3 |
| E6 | Orchestration | `workflow-graph/{iteration-orchestrator,implementer-runner,validator-runner,workflow-collaborator-caller,execution-events}.ts`, `prompt/sdk-driver.ts`, `conversations/service.ts` | mixed: `conversations/service.ts` fork 1.6; graph runners 3.2/3.3; `codex-runs/service.ts` → E6 at 3.6 (agent-runs rename) |

**Explicitly exempt:** `src/lib/agent-backends/**` (that's where a new backend *is* edits), `shared/schemas.ts` (allowed edit #1), collaboration modules (`workflows/collaboration/**` — P10: the Claude/Codex pair is named config, generalization is a non-goal), and UI catalog consumers (they render from `GET /api/agent-backends` after 1.2; they're covered by 1.2's "delete every hardcoded backend array", not by this criterion).

**How the test proves "zero edits" — two halves, both required:**

1. **Static half:** the corpus contains zero backend-identity literals. A test reads each enforced file in E and asserts zero regex matches for `["'\`](claude|codex)["'\`]` and zero `backend ===` / `agentBackend ===` comparisons (no allowlist for enforced files; a log line needing the backend uses the variable). If the corpus has no literals to change, adding backend X cannot *require* editing it.
2. **Behavioral half:** literal-absence alone doesn't prove the parametric path *works* (a consumer could throw on an unknown id, or an exhaustive `switch` could hit `assertNever`). So the suite registers the testfake descriptor via `_registerBackendForTesting` and drives real corpus code end-to-end with `backend: "testfake"`, asserting on **values only obtainable through the descriptor** (the fake's distinct capability values, its call log, its `testfake_frame` markers, its `{backend:"testfake", ref}` envelopes). Together: the corpus is parametric in the id *and* the parametric path is live.

**Staging mechanism (matches the roadmap: Phase 1 migrates E1-cap/E2/E4/E5 + fork; Phase 3 migrates E3 and the rest of E6):** every corpus file/behavioral section carries a status in an exported `CONSUMER_LOCALITY_MAP` (`"enforced"` | `"pending:phase-3"`). Pending behavioral sections are written now and run under `it.fails` — they are red today by construction (e.g. `workflow-agent-caller.ts:239` branches on `lane.backend === "claude"` and would try to `createClaudeConversation` for `"testfake"`), and the moment the Phase 3 slice lands, `it.fails` itself fails, forcing the section to be flipped to `enforced` in the same PR (the locality analogue of the seam ratchet's equal-to-observed rule). Phase 3's exit criteria add: *zero `it.fails` remaining in the locality suite*.

**Persistence boundary (deliberate):** post-§3.1.1, `agentSessionRefSchema` validates `backend` against the closed enum, so `{backend:"testfake"}` is **rejected at storage seams by design** — the closed registry means persistence stays closed. The behavioral drive therefore uses in-memory stores via the existing DI seams (`ActorImplementationDeps`, `WorkflowAgentCallerDeps`, lane-store injection), an explicit, documented exemption from the real-store-fixture steering rule (that rule targets durability correctness, which the per-backend contract tests own; locality tests assert consumer parametricity). One boundary test pins this truthfully: `agentSessionRefSchema.safeParse({backend:"testfake", ref:"x"}).success === false` — the *only* rejection point for a fake id is the canonical schema, i.e. allowed-edit #1.

#### D-B4.5 — Conformance parameterization

`describeBackendConformance(descriptor)` (§3.1.7, `src/lib/agent-backends/conformance.ts`) runs three times: Claude, Codex, testfake. For the fake it verifies the same contract as the real backends — id agreement across facets, model catalog validity + default presence, ref round-trip, **mismatched-ref rejection** (the fake's continuity adapter must reject `{backend:"claude", …}`), normalized failure classification, and capability↔behavior coherence (`fork: "unsupported"` ⇔ `fork()` returns `{kind:"unsupported"}`; `contextWindowMetrics: false` ⇔ `contextTokens: null`). This keeps the fake honest: the locality proof is only as good as the fake's conformance.

### 4.3 Acceptance tests (Phase 1.8 deliverables)

All red-first: every file below fails against today's code (no `registerBackend`, no descriptor, 55 branch lines in the corpus), and the enforced subset goes green only as its owning Phase 1 slice lands — which is the measurement.

1. **`src/lib/agent-backends/registry-core.test.ts`** (extend existing coverage)
   - `registerBackend` rejects a duplicate id; rejects a descriptor with neither facet; **rejects an id outside `agentBackendSchema` at runtime** (feed the testfake descriptor through the *production* function and assert it throws).
   - `_registerBackendForTesting` accepts the testfake descriptor; `getBackendDescriptor(TESTFAKE_BACKEND_ID)` returns it; `listBackends()` includes it.
   - `_resetBackendRegistryForTesting()` empties the registry (`getBackendDescriptor` throws after reset); `bootstrapBackends()` is idempotent (double-call registers each backend once).
2. **`src/lib/agent-backends/conformance.test.ts`**
   - `describeBackendConformance` × {claude descriptor, codex descriptor, `createTestFakeBackend().descriptor`} — assertions per D-B4.5.
3. **`src/lib/agent-backends/testing/testfake-backend.test.ts`**
   - The fake's own contract: scripted event order (`backend_init` → `content` → `transcript_entry`×2 → `input_accepted`), call-log recording for every operation, distinct-from-real capability values (guard test comparing against the Claude/Codex descriptors so the "pick the third value" rule can't silently erode), `TESTFAKE_BACKEND_ID` round-trips the widened schema.
4. **`src/lib/agent-backends/consumer-locality-static.test.ts`** (static half)
   - Exports `CONSUMER_LOCALITY_MAP` (corpus E with per-file status). For every `enforced` file: zero backend-id literal matches, zero identity comparisons (regexes per D-B4.4). For every `pending:phase-3` file: `it.fails` on the same assertion (flips loudly when the Phase 3 slice cleans the file). Also asserts the map's file list matches the filesystem (a moved/renamed consumer fails the suite rather than silently dropping out of the corpus).
5. **`src/lib/agent-backends/consumer-locality.test.ts`** (behavioral half; sections keyed to corpus E)
   - *Setup (all sections):* `_resetBackendRegistryForTesting()` → `_registerBackendForTesting(createTestFakeBackend().descriptor)`; in-memory DI stores per D-B4.4's persistence-boundary decision.
   - **E1 AgentCall:** `executeAgentCall` with `request.backend = TESTFAKE_BACKEND_ID` (conversation shape and task shape) — dispatch resolution carries `backend: "testfake"`; the attached capability view equals the fake's declared values (specifically `continuationStrength === "synthetic_thread"`, which today's Claude-fallback at `backend-capabilities.ts:39` cannot produce); the fake's call log shows `factory.createRuntime`/`runner.run` invoked; result text/blocks equal the script.
   - **E2 Machines:** drive one full turn through `executePromptForMachine` with `agentBackend: TESTFAKE_BACKEND_ID` (deps via the existing `ActorImplementationDeps` seam) — turn completes; the persisted (in-memory) transcript contains both `testfake_frame` envelopes byte-identical to what the runtime emitted (marker uuid equality); the completion path reads `continuationDisposition` from the normalized result (no `backend === "codex"` branch effect: with the fake's classifier returning `retain`, the ref survives where today's codex-literal branch would have decided).
   - **E3 Lane modules** (`it.fails` until Phase 3.2): `WorkflowAgentCaller` acquires a lane for `"testfake"`, runs a call via `descriptor.conversation.continuity` — `LaneState` stores the neutral `{backend:"testfake", ref:"fake-ref-1"}` envelope; the continuity adapter's call log shows `start`/`validate`/`resumeOrRecover` in the right order across two calls.
   - **E4 Transcript consumers:** feed the fake's `transcript_entry` envelopes through the execution-logger write path and the `execute-workflow-task-run` read path — entries come back with `raw` deep-equal (marker intact), and no consumer throws or branches on `entry.raw` shape (this doubles as the §3.1.3 raw-payload non-interpretation architecture test's positive case).
   - **E5 MCP apply:** `applyAtTurnStart` for a conversation whose runtime is the fake — apply disposition is derived from the fake's declared `mcp.betweenTurnApply` and its `capabilityKinds[].applyTiming` (values distinct from both real backends per D-B4.3), and `applyPortableMcpConfig` appears in the call log; no id branch outcome possible.
   - **E6 Orchestration** (`it.fails` until 3.2/3.3 for graph runners): validator-runner/implementer-runner single-iteration drive with `engine`/backend `"testfake"` — dispatch resolution + persisted validator transcript carry testfake values end-to-end. `conversations/service.ts` fork (enforced from 1.6): `continuity.fork()` returns `{kind:"unsupported"}` and the service surfaces the normalized outcome (today it would silently take the Claude-native `forkSession` path).
   - **Boundary pin:** `agentSessionRefSchema.safeParse({backend:"testfake", ref:"x"})` fails — documents that the canonical id schema is the single intentional rejection point (allowed-edit #1).
6. **Seam-guard additions** (Phase 0.4/1.2 lint + ratchet, restated as acceptance): importing `@/lib/agent-backends/testing/**` or calling `_registerBackendForTesting`/`_resetBackendRegistryForTesting` outside `*.test.ts` is a lint error; the §3.5 backend-identity ratchet's ceiling for corpus-E files is **zero** (not merely non-increasing) once each file's phase lands.

**Phase 1.8 exit reading:** suites 1–3 fully green; suite 4/5 green for every `enforced` section, `it.fails`-red for every `pending:phase-3` section; Phase 3 exit adds "zero `it.fails` in the locality suite".

### 4.4 Rejected alternatives (summary)

- **Open/plugin registry** (accept any string id in production): contradicts P10 ("a curated static set is the product") and D-B4.4's boundary pin; rejected.
- **Module augmentation / env-gated schema / string-keyed consumers** for the test id: rejected per D-B4.2.
- **Full behavioral drive over real SQLite persistence:** impossible and undesirable — the closed ref schema rejecting `"testfake"` at storage seams is a feature; in-memory DI stores + the boundary pin are the truthful substitute.
- **Deferring the whole locality suite to Phase 3:** rejected — Phase 1 migrates four of the six consumer categories, and the staged `it.fails` mechanism gives Phase 3 a forcing function instead of a TODO.

### 4.5 Open risks

1. **D-B4.2's approved type-level fiction:** `"testfake"` is asserted to `AgentBackendId` in one lint-fenced test-support module. Do not repeat this exception elsewhere; the rejected fallback (module augmentation) would weaken the closed-enum guarantee across the whole typecheck program.
2. **`it.fails` staging drift:** staged sections use `it.fails` to pin pre-Phase-3 redness; if Phase 3 scope shifts (e.g. lane migration lands piecemeal), a section can half-pass and `it.fails` becomes flaky — the Phase 3 exit criterion "zero `it.fails` in the locality suite" must be enforced in review, not just documented.
3. **Persistence-boundary classification of future ref-parse sites:** the behavioral drive cannot cross real persistence — `agentSessionRefSchema` (post-§3.1.1 `backend: agentBackendSchema`) rejects `"testfake"` at storage seams by design, so the locality suite uses in-memory DI stores, exempted from the real-store-fixture steering rule. If a future consumer moves ref validation above the storage seam (e.g. parses refs on the hot path), the drive will break there and the parse site must be classified as canonical-schema (allowed) or consumer logic (violation) — the suite's boundary test documents this but cannot auto-classify new sites.
4. **Literal-regex gaming:** the static half's "zero backend-id literals" rule can be gamed (e.g. `["cla","ude"].join("")`) or tripped by innocent prose in comments; the regex intentionally scans comments too — accepted cost, since the corpus is small and reviewed.
5. **E6 corpus-map upkeep:** `conversations/service.ts` fork and `codex-runs/service.ts` sit at the consumer/orchestration boundary; their enforcement is staged (1.6 and 3.6) and the corpus map in the static test must be updated in those slices or the equal-to-observed discipline is lost.

---

## Blocker 5 — Typed SSE publication separated from lifecycle StatusBus projection (§3.4 first bullet, §3.6.5)

**Status: resolved design.** One typed publication module (`src/lib/events/publication.ts`) becomes the sole production entry point onto the SSE wire; StatusBus shrinks to an explicit, exhaustively-typed lifecycle projection with the manufactured `conversation/unknown/running` fallback deleted. Implementation lands entirely in Phase 4.1; Phase 0.4 consumes only the sanctioned-module list (warn-level lint) from this design. **Phase 1 needs nothing from this blocker — confirmed in §5.3.**

### 5.1 Current-state inventory (verified)

#### 5.1.1 Two competing publication paths

**Path A — raw transport.** `broadcast(event: SSEEvent)` in `src/lib/events/broadcaster.ts:66-111` (globalThis client set, seq counter, replay buffer). Production **value** importers outside the transport itself (10 — matches the audit's "~10"):

| # | Importer | Evidence |
|---|---|---|
| 1 | `src/lib/context-artifacts/route-handlers.ts` | `:38` |
| 2 | `src/lib/agent-capabilities/route-bindings.ts` | `:2` |
| 3 | `src/lib/mcp/sse-broadcast.ts` | `:19` (`broadcast as defaultBroadcast`, injectable `emit`) |
| 4 | `src/lib/conversations/lifecycle-route-handlers.ts` | `:34-35` |
| 5 | `src/lib/conversations/mark-read-route-handlers.ts` | `:21-22` |
| 6 | `src/lib/prompt/transcript.ts` | `:26-29` (message-appended/updated — highest-frequency publisher) |
| 7 | `src/lib/chat-spawning/spawn-service.ts` | `:16` |
| 8 | `src/lib/session-alignment/service-factory.ts` | `:1` |
| 9 | `src/lib/project-conversations/prompt-entry.ts` | `:20` |
| 10 | `src/lib/project-conversations/route-handlers.ts` | `:29` |

Sanctioned-by-nature: `src/lib/events/sse-route-handlers.ts:13` (the SSE route transport) and the lazy `require("@/lib/events/broadcaster")` inside the current bus adapter (`src/lib/workflows/primitives/default-session-status-bus.ts:39-43`). Type-only `BroadcastFn` importers (9): `dev-server/{registry.ts:12,reconciliation.ts:2,liveness.ts:2}`, `jobs/queue.ts:17`, `session-alignment/service.ts:5`, `notifications/repo.ts:10`, `conversations/{lifecycle-route-handlers.ts:35,mark-read-route-handlers.ts:22}`, `events/broadcast-event.ts:14`.

Best-effort policy lives in `src/lib/events/broadcast-event.ts:27-36` (`broadcastEvent`: build+broadcast in one try/catch, warn, never fail the mutation). 9 call sites: `conversations/lifecycle-route-handlers.ts:164,211,259`, `session-alignment/service.ts:306`, `project-conversations/route-handlers.ts:225,343,389,435,470`.

**Path B — StatusBus.** `publishSessionStatus` (`workflows/primitives/default-session-status-bus.ts:55-63`) wraps every event in `runAsTrace("sse:broadcast:<type>")`, resolves a scope envelope via `resolveSessionStatusScope` (`session-status-bus.ts:141-264`), notifies in-process subscribers, then forwards the raw event to the wire. Production callers: `dev-server/{liveness.ts:30,registry.ts:155,reconciliation.ts:185}`, `workflow-graph/execution-events.ts:41-43` (ALL `GraphWorkflowSSEEvent` types), `workflow-graph/lane-tool-context-loader.ts:302`, `workflows/collaboration/{manager.ts:516,deps-factory.ts:159,217}`, `workflows/conversation/manager.ts:813-953`, `workflows/conversation/debug-adapter.ts:141`, `conversations/message-queue-service.ts:937`, `conversations/mark-unread.ts:57,89` (injected), `notifications/repo.ts:35`, `jobs/queue.ts:136`, plus the dead root tier `workflows/actions.ts:63-78` (zero importers — Phase 0.2 deletes it).

#### 5.1.2 `subscribeSessionStatus` has zero production subscribers — verified

`grep -rn subscribeSessionStatus src` hits only its definition (`default-session-status-bus.ts:127-131`) and 8 test files (`section-4/6-1/6-2/6-3/7-2` parity suites, `debug-adapter.test.ts`, `default-session-status-bus.test.ts`). The audit claim holds.

#### 5.1.3 The manufactured fallback — found

`session-status-bus.ts:256-262`: the `default` case of `resolveSessionStatusScope` returns `{ scope: "conversation", scopeId: FALLBACK_SCOPE_ID /* "unknown", :65 */, status: "running" }` for any unrecognized event. It is hit **today** by:

- `conversation-unread` events published through the bus (`conversations/mark-unread.ts:57,89`; `workflows/collaboration/deps-factory.ts:217`) — no resolver case exists for the type.
- 12 graph-workflow event types routed via `execution-events.ts:42` with no resolver case: `graph-workflow-{pending-halt-reason, merge-status, batch-scheduled, lane-status, join-status, approval-pending, approval-resolved, user-input-pending, user-input-resolved, charter-registered, charter-updated, live-edit-applied}` (union membership: `src/lib/api/sse-events.ts:119-130`; only 6 graph types have resolver cases at `session-status-bus.ts:176-205`).

So a lane-status event is projected as a *conversation* named *unknown* that is *running* — noise for any future subscriber, and evidence that scope resolution by post-hoc inference over an open union cannot be correct.

### 5.2 Resolved design

#### 5.2.1 The typed publication module — `src/lib/events/publication.ts`

One module, colocated with the transport, owning tracing, the broadcaster adapter, the lifecycle projection hook, and the best-effort policy:

```ts
export interface PublishOutcome { delivered: boolean; error?: Error }
export type PublishFn = (event: SSEEvent) => PublishOutcome;   // replaces BroadcastFn in all deps interfaces

/** THE production entry point. Trace root `sse:broadcast:<type>` (name kept for
 *  Speedscope continuity, cf. default-session-status-bus.ts:58-60), lifecycle
 *  projection to in-process subscribers, then wire broadcast. Never throws:
 *  transport failure → { delivered:false, error } + structured warn. */
export function publishEvent(event: SSEEvent): PublishOutcome;

/** Best-effort variant retaining broadcast-event.ts's exact mutation policy:
 *  `build()` runs inside the guard; any throw (schema or transport) is
 *  swallowed with `failureEvent` + `context` warn. `publish` injectable for DI. */
export function publishEventBestEffort(options: {
  build(): SSEEvent;
  logger: Pick<Logger, "warn">;
  failureEvent: string;
  context: Record<string, unknown>;
  publish?: PublishFn;
}): void;

/** Constructs + publishes a `scoped-status` event (absorbs publishScopedStatusEvent,
 *  default-session-status-bus.ts:103-118, contract comments preserved). */
export function publishScopedStatus(input: PublishScopedStatusInput): PublishOutcome;

/** In-process lifecycle subscription (replaces subscribeSessionStatus). */
export function subscribeLifecycle(subscriber: StatusBusSubscriber): () => void;

// Test seams: setPublicationBroadcastForTesting / _resetPublicationForTesting
```

**Deliberate deviation from "per-SSEEvent typed publish fns" (plural):** the design ships **one** generic `publishEvent` over the discriminated `SSEEvent` union rather than ~43 named wrappers. TypeScript already narrows per-type at every call site via the `type` literal; 43 identical-bodied wrappers are shallow modules adding no contract. The genuinely per-event element — "does this event project to lifecycle, and how" — lives in the per-type projection table (§5.2.2), which is where per-event decisions actually differ. Rejected alternative noted in §5.5.

#### 5.2.2 Lifecycle projection — `src/lib/events/lifecycle-projection.ts`

`resolveSessionStatusScope`'s switch survives as an **exhaustive, closed** projection; the `default` fallback and `FALLBACK_SCOPE_ID` die:

```ts
export const LIFECYCLE_EVENT_TYPES = [ /* the 10 below */ ] as const;
export type LifecycleSSEEvent = Extract<SSEEvent, { type: (typeof LIFECYCLE_EVENT_TYPES)[number] }>;
/** null = wire-only event, no lifecycle envelope. Exhaustive switch over
 *  LifecycleSSEEvent + assertNever — adding a type to the set without a
 *  projection is a compile error. */
export function projectLifecycle(event: SSEEvent): { scope; scopeId; status } | null;
```

**Explicitly supported lifecycle events (the enumeration), preserving today's mappings** (`session-status-bus.ts:71-117,146-254`):

| Event | scope | scopeId | status |
|---|---|---|---|
| `conversation-status` | `conversation` | `conversationId` | running / awaiting,waiting_for_input→paused |
| `ask-question` | `conversation` | `conversationId` | paused |
| `job-status` | `merge_job` | `jobId` | completed / failed / conflicts→paused / else running |
| `graph-workflow-status` | `graph_workflow` | `executionId` | completed / failed / halted,paused→paused / else running |
| `graph-workflow-context-status` | `graph_workflow` | `executionId` | running |
| `graph-workflow-task-status` | `graph_workflow` | `executionId` | completed,skipped→completed / failed / paused,blocked→paused / else running |
| `dev-server-status` | `dev-server` | `project/session/server` | running,starting→running / stopped→completed / error→failed |
| `debug-mode-status` | `debug` | `conversationId` | running |
| `debug-log-received` | `debug` | `conversationId` | running |
| `scoped-status` | passthrough (unknown scope→`workflow`) | `scopeId` | passthrough |

Inclusion criterion: reports the state of a durable unit of work with a non-manufactured mapping — **except** the two `debug-*` events, retained solely because `debug-adapter.test.ts:264-308` and the section-6-2 parity suite pin `scope:"debug"` envelopes protecting the Phase 2.3.4 debug eviction. Deletion condition: when section-6-2/debug-adapter parity retires post-eviction, drop `debug-log-received` (pure activity) from the set.

**Dropped from projection (wire-only from now on):** `message-queued`, `message-queue-updated` (manufactured `running`), `notification-created`, `notification-updated` (manufactured `completed` — notifications aren't lifecycles), `graph-workflow-{validation-result, circuit-breaker, shared-documents-updated}` (point events), and everything the `default` fallback previously swallowed (`conversation-unread`, the 12 graph event types in §5.1.3, and all Path-A events should they ever route through). Zero production subscribers exist (§5.1.2), so nothing breaks; test deltas are enumerated in §5.4.

#### 5.2.3 What StatusBus becomes

- The generic primitive `createStatusBus` (`workflows/primitives/status-bus.ts`) **moves unchanged** to `src/lib/events/status-bus.ts` — envelope schema, never-throw delivery, independent subscriber/wire failure isolation (`status-bus.ts:106-156`) are all retained and now instantiated only by `publication.ts` as its module-scoped singleton. This removes the `events → workflows/primitives` dependency inversion.
- `session-status-bus.ts` and `default-session-status-bus.ts` are **deleted** at the end of 4.1b; their surviving pieces are the projection table (→ `lifecycle-projection.ts`), `publishScopedStatusEvent` (→ `publishScopedStatus`), and the trace root + singleton (→ `publication.ts`).
- `broadcast-event.ts` is **deleted** at the end of 4.1c (absorbed as `publishEventBestEffort`).
- StatusBus's role statement for steering (`engineering-principles.md` primitive list, Phase 0.3): *"in-process lifecycle projection over published SSE events, restricted to the enumerated lifecycle set; the wire contract is owned by publication.ts."* It keeps zero production subscribers after 4.1 — it is a subscription point for planned consumers (activity rail, workflow envelope observers); adopt-or-delete applies if none materialize (risk §5.6).

#### 5.2.4 Migration order (Phase 4.1, each slice fully green)

1. **4.1a — Land the modules.** Move `status-bus.ts`; add `lifecycle-projection.ts` (red-first: fallback-removal tests §5.4) and `publication.ts` (ports `broadcast-event.test.ts` + relevant `default-session-status-bus.test.ts` cases). Reimplement `publishSessionStatus`/`publishScopedStatusEvent`/`subscribeSessionStatus` as thin delegations to publication so the projection restriction (the only behavior change) lands once, at the seam. Update `section-4-production-paths.test.ts:125-190` (message-queued: wire assertion kept, envelope assertion inverted) in the same commit.
2. **4.1b — Convert bus callers** (12 modules, §5.1.1 Path B list; `workflows/actions.ts` already deleted by Phase 0.2) from `default-session-status-bus` imports to `publishEvent`/`publishScopedStatus`; repoint the 8 test files' subscribe imports to `subscribeLifecycle`. Delete `session-status-bus.ts` + `default-session-status-bus.ts` (+ their tests, folded into 4.1a's).
3. **4.1c — Convert raw-transport importers**: the 10 value importers (§5.1.1 table) to `publishEvent`; the 9 `broadcastEvent` call sites to `publishEventBestEffort`; the 9 `BroadcastFn` type importers to `PublishFn`. Delete `broadcast-event.ts`.
4. **4.1d — Enforce.** ESLint seam rule warn→error; seam-ratchet ceiling for the broadcaster-import seam set to the sanctioned count (2); `seams:check` green.

Order rationale: bus-first deletes two modules immediately and exercises the projection under its heaviest producers (graph execution events) before touching route handlers; raw importers are mechanical once `publishEventBestEffort` exists.

#### 5.2.5 Lint-rule sanctioned-module list (feeds Phase 0.4 at warn, 4.1d at error)

Importing `@/lib/events/broadcaster` (any path form, value or type) is permitted only in:

1. `src/lib/events/publication.ts` — the adapter
2. `src/lib/events/sse-route-handlers.ts` — the transport route (`addClient`/`removeClient`/`replayFramesSince`/`getClientCount`)
3. `**/*.test.ts` — transport tests and `_resetForTesting`

During 4.1 (pre-deletion) the warn-level allowlist additionally carries `src/lib/workflows/primitives/default-session-status-bus.ts` and `src/lib/events/broadcast-event.ts`, each tagged with deletion conditions "removed in 4.1b/4.1c". Rule lives beside the existing guardrails (`eslint-rules/tailwind-guardrails.mjs` pattern), in a new `eslint-rules/seam-guardrails.mjs`; the seam-adoption corpus pattern is `from ["'](@/lib/events/broadcaster|\.{1,2}/(\.\./)*(events/)?broadcaster)["']`.

### 5.3 Phase-gating confirmation

**This blocker gates only the design; Phase 1 consumes nothing from it.** Phase 1 is the backend seam (§3.1: registry, descriptors, structured-output, migrations) and touches no SSE publication surface; the roadmap places all publication work in the 4.1 wave ("publication adoption follows the SSE/StatusBus decision", report Ground rules — Ordering) and §3.6's preamble keeps "the implementation steps themselves … in their owning phases". The only pre-4.1 consumer of this design is **Phase 0.4** (warn-level ESLint seam rule + seam-adoption corpus need §5.2.5's list and pattern), which is satisfied by this document — no code from this blocker is required before Phase 4.1.

### 5.4 Acceptance tests (Phase 4.1)

**`src/lib/events/lifecycle-projection.test.ts`** (new; red-first where marked):

- Table-driven: each of the 10 supported types → exact `{scope, scopeId, status}` per §5.2.2, including every status-mapping branch (ports `mapConversationStatus`/`mapJobStatus`/`mapGraphWorkflowStatus`/`mapTaskStatus`/`mapDevServerStatus` cases from the current suites).
- **RED-FIRST (behavior change):** `projectLifecycle` returns `null` for `conversation-unread` and for `graph-workflow-lane-status` — written first against the current path (`publishSessionStatus`), where they fail by producing a `conversation/unknown/running` envelope; they pass only when the fallback is gone.
- Pins the enumeration: `LIFECYCLE_EVENT_TYPES` equals the exact 10-element set (a new lifecycle event requires touching this test deliberately). Compile-time exhaustiveness via `assertNever` needs no runtime test.
- `scoped-status`: recognized scope passthrough; unknown scope → `workflow` (+ structured warn).

**`src/lib/events/publication.test.ts`** (new):

- `publishEvent` delivers the raw event to the injected wire unchanged, and for a lifecycle event delivers the envelope `{scope, scopeId, status, timestamp, payload === event}` to `subscribeLifecycle` subscribers (payload-to-wire + envelope-to-subscriber parity, ports the section-4 pattern).
- Non-lifecycle event (`message-appended`, `conversation-unread`) → wire delivery, **zero** subscriber envelopes.
- Trace: the wire broadcast executes under root `sse:broadcast:<type>` (assert trace context inside the injected broadcast fn).
- Transport throw → `{delivered:false, error}` + warn, no throw, subscribers still notified; subscriber throw → wire + remaining subscribers unaffected + warn (ports `status-bus.ts:106-156` semantics).
- `publishEventBestEffort`: `build()` throw swallowed with `failureEvent`+`context` warn; transport throw swallowed (ports `broadcast-event.test.ts` verbatim).
- `publishScopedStatus`: constructs a valid `ScopedStatusEvent` (timestamp defaulted, reason/payload optional) and publishes it (ports `default-session-status-bus.test.ts` cases).

**Updated in-place (same slice as the behavior change, 4.1a/b):**

- `section-4-production-paths.test.ts:125-190` — message-queued envelope assertion inverted (wire kept).
- `section-6-1/6-2/6-3/7-2` parity suites + `debug-adapter.test.ts` — subscribe entry repointed to `subscribeLifecycle`; **assertions unchanged** (all pinned scopes — `graph_workflow` at 6-2:175, `merge_job` at 6-3:150, `debug` at debug-adapter:284,307, `conversation` at 6-1 — are in the supported set), preserving their role as pins for the debug-eviction and lane migrations.
- `default-session-status-bus.test.ts`, `session-status-bus.test.ts`, `status-bus.test.ts`, `broadcast-event.test.ts` — folded/moved with their modules.

**Enforcement (4.1d):** `eslint-rules/seam-guardrails.test.mjs` — broadcaster import from a non-sanctioned production file errors; from `publication.ts`/`sse-route-handlers.ts`/tests passes. `seams:check` ceiling for the seam = 2. Exit criteria: production `events/broadcaster` importers = exactly the sanctioned pair; `session-status-bus.ts`, `default-session-status-bus.ts`, `broadcast-event.ts` deleted; full gate suite green.

### 5.5 Rejected alternatives

- **~43 named per-event publish functions** (`publishConversationStatus(...)`, …): shallow wrappers over an already-discriminated union; per-event knowledge lives in the projection table instead. Revisit only if per-event publication policy (beyond lifecycle projection) ever diverges.
- **Delete StatusBus outright** (zero production subscribers): rejected — the parity suites pin envelopes protecting two in-flight migrations, and the primitive is on the steering primitive list with planned consumers; restriction + deletion-condition is the adopt-or-delete-compliant middle.
- **Project *all* current resolver cases** (keep message-queue/notification mappings): rejected — they are manufactured statuses; keeping them re-blesses the inference-over-open-union pattern the blocker exists to kill.
- **Leave the projection in `workflows/primitives/`**: rejected — publication (events domain) may not depend upward on workflows; transport, projection, and publication now colocate in `src/lib/events/`.

### 5.6 Open risks

1. **Per-event `runAsTrace` lands on the high-frequency `message-appended` path** (`prompt/transcript.ts:26-29` currently broadcasts untraced); `runAsTrace` is ALS-based and already wraps the busiest bus path, but verify with `cc-performance-log-analysis` after 4.1c and add a `PERFORMANCE.md` entry if it regresses.
2. **`debug-mode-status`/`debug-log-received` stay in the lifecycle set** only to protect the Phase 2.3.4 debug-eviction pins (`debug-adapter.test.ts:264-308`, section-6-2); if the deletion condition (parity-suite retirement) is never exercised, a manufactured `running` projection becomes permanent.
3. **StatusBus retains zero production subscribers after 4.1**; it survives on planned consumers (activity rail / envelope observers) — if none materialize by program end, the adopt-or-delete rule should be re-applied to `subscribeLifecycle`.
4. **Evidence snapshot:** all file:line evidence is a snapshot of `csm/review-and-refactor-composition-units-d688c3` (HEAD `0c42c186`) and must be re-verified at 4.1 kickoff (`workflows/actions.ts` is assumed already deleted by Phase 0.2).
5. **`ScopedStatusEvent.scope` remains an open string on the wire** (`sse-events.ts:86`); unknown scopes narrow silently to `workflow` — the design adds a structured warn, but a typo'd scope from a future primitive-native workflow still publishes without failing.
6. **The 4.1a slice changes `publishSessionStatus` subscriber behavior while call sites still route through the old names**; any test added between now and 4.1 that asserts fallback envelopes (`conversation/unknown/running`) will conflict and must be triaged as pinning a bug, not a contract.

---

## Correctness contract addendum (2026-07-14)

This addendum supersedes implementation details above where the completed-program review found that a Module's interface still leaked a decision or admitted behavior that contradicted the pre-refactor contract.

### C1 — Conversation lifecycle completion and attached-workflow identity

`executePromptStream` and other callers consume a domain completion/result operation owned by the conversation lifecycle Module. No caller imports `ConversationActorRef`, sends a raw XState event, or classifies `snapshot.value`; the manager keeps those details inside the implementation. Settlement covers idle, user-input parking, and debug parking uniformly.

Attached asynchronous work is correlated by `{generation, attempt}`. Entering debug creates a new generation; retrying cleanup increments its attempt. Exiting debug aborts that generation's pending verifier. Both generation and attempt are validated on completion so a cancellation race cannot apply a prior result to a later debug session. An active persisted debug state that predates the generation field is assigned one at the lifecycle boundary and immediately persisted before cleanup can run; the in-memory lifecycle type always requires it.

Red-first acceptance drives a real turn into debug parking through the lifecycle interface and asserts prompt completion/stream detachment, then holds generation A's verifier across exit/re-entry and proves both its success and failure are ignored in generation B.

### C2 — Failure-kind-aware continuation

The adapter that observes a failure returns the normalized classification and continuation disposition together. `stale_resume_ref` always returns `{backendRef:null, continuationDisposition:"clear"}`. A graceful Codex `turn.failed` retains its established thread because that event alone does not prove the provider rollout stale. Claude retains a precise session for transient local failures but clears a classified stale resume. The conversation machine contains no backend identity policy; it only applies the result invariant.

Each adapter has matrix tests plus one persistence-level conversation test proving the next turn receives the retained ref or starts fresh as declared.

### C3 — Isolated one-shot task policy

`AgentTaskRequest` carries a semantic execution profile rather than provider option fields. Session-name generation selects `isolated-one-shot`: one turn, no tools, no MCP, no inherited settings/hooks, and no persisted continuation. An adapter either guarantees the whole profile or returns a typed unsupported result before invoking its provider; partial approximations are forbidden. The ordinary/default profile preserves general task behavior. Tests capture the concrete Claude invocation and the Codex zero-provider-call unsupported result.

### C4 — Lifecycle projection scope authority

Section 5.2.2's original mapping of `graph-workflow-context-status` and `graph-workflow-task-status` onto `scope:"graph_workflow"`/`scopeId:executionId` is superseded. Only `graph-workflow-status` is authoritative for execution lifecycle. Context/task events remain on the SSE wire but either project to dedicated context/task scopes keyed by their own identifiers or return `null`; they cannot change the whole execution status. Known paused and terminal statuses are exhaustively mapped, and no known status defaults to `running`.

### C5 — Completion and locality enforcement

An exact-count ratchet is green only when it matches the current corpus, but a deliberately pinned failure is not an approved survivor. The Phase 3 exit condition remains: the testfake backend successfully traverses the declared execution-consumer corpus, no pending entries remain, and adding a supported backend requires zero machine, lane, transcript-consumer, MCP-apply, or orchestration edits beyond the canonical id schema, descriptor/adapters, and bootstrap registration.

### C6 — Graph validation session and review identity

The canonical graph validation event session envelope is `{backend, ref, lane, refKind, workflowConversationId?}`. The execution strategy, not backend identity, assigns its meaning:

- conversation strategy: `refKind:"conversation"`, with the stable Command Center conversation id in both `ref` and `workflowConversationId`;
- task strategy: `refKind:"backend"`, with the lane's opaque backend continuation handle in `ref` and no inferred conversation id;
- cleared task continuation: `sessionRef:null`.

Persisted lane state uses the same neutral `{backend,ref}` payload with `refKind` and `workflowConversationId` as separate ownership fields. Review artifacts use `{kind:"conversation", ref:<Command Center conversation id>}` or `{kind:"response", ref:<backend handle>, response, usage}`. The validator runner constructs these values at the strategy boundary; the event publisher only transports them. Provider-to-meaning switches and post-hoc lane-state enrichment are forbidden. Legacy Claude/Codex payloads are accepted only by boundary preprocessors. UI reuse is keyed by `workflowConversationId ?? ref`, so provider SDK handle rotation cannot manufacture a new logical validator session.
