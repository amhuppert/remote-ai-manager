# Invalid structured output from a graph workflow context

**Date:** 2026-08-07
**Ticket:** remote-ai-manager#8
**Fix:** `c85b9765` — `fix(workflow-graph): dispatch a provider-portable dispositions schema`
**Files:** `src/lib/workflow-graph/advisory-delivery.ts`, `src/lib/workflow-graph/definition-schemas.ts`, `.kiro/steering/workflows.md`

## Symptom

A graph workflow execution halted with `Execution loop error` while the context
"Unit 2: WelcomeHeader" was in its `advisory_response` phase — after validation
had already passed. The halt card carried the provider's rejection verbatim:

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "code": "invalid_json_schema",
    "message": "Invalid schema for response_format 'codex_output_schema': In context=('properties', 'dispositions', 'items'), 'oneOf' is not permitted.",
    "param": "text.format.schema"
  },
  "status": 400
}
```

Resume could not clear it. The turn was rejected before it ran, so every retry
re-sent the same schema and earned the same 400.

## Root cause

`buildAdvisoryDispositionsOutputSchema` dispatched a schema built for the
repo's own JSON Schema subset (`src/lib/workflows/primitives/output-schema-subset.ts`),
not for the provider that would enforce it:

```jsonc
{
  "type": "array",
  "minItems": 2, "maxItems": 2,
  "items": {
    "oneOf": [                                  // (1) refused by the provider
      { "type": "object",
        "properties": {
          "disposition": { "const": "addressed" },  // (2) const with no type
          "reason": { "type": "string", "minLength": 1 } },
        "required": ["identity", "disposition"] },  // (3) reason left optional
      /* declined, deferred */
    ]
  }
}
```

The chain that made this fatal:

1. The Codex adapter declares `structuredOutput: "backend_native"` and sends the
   caller's schema through unmodified (`.kiro/steering/agent-backends.md`).
2. `@openai/codex-sdk` writes it to a temp file and passes `--output-schema` to
   the Codex CLI, which dispatches it as `text.format.schema` under the name
   `codex_output_schema` with strict mode on.
3. OpenAI's strict structured-output validator rejects the request outright.

All three constructs above violate strict mode. `oneOf` was simply the first one
the validator reported.

The three branches existed to make `declined` owe a reason *in the schema*: the
branches are mutually exclusive on the `disposition` const, so a bare decline
matched none of them and the gate's repair loop asked again. That rule was
correct; the mechanism was not portable.

### Verified against the live provider

Each rule was confirmed empirically with `codex exec --output-schema`, not
inferred from documentation:

| construct | outcome |
| --- | --- |
| `oneOf` | rejected — *"'oneOf' is not permitted"* |
| property declared but absent from `required` | rejected — *"'required' is required to be supplied and to be an array including every key in properties"* |
| `const` without a sibling `type` | rejected — *"schema must have a 'type' key"* |
| `anyOf` | accepted |
| `{ "type": "string", "enum": ["a"] }` | accepted |
| `{ "type": ["string", "null"] }` | accepted, returns `null` when empty |
| `minItems` / `maxItems` / `minLength` | accepted |

## The fix

The dispatched schema now states the **shape** only — everything a schema a
provider-native backend accepts can say:

```jsonc
{
  "type": "object",
  "properties": {
    "identity": { "type": "object", "properties": { /* … */ },
                  "required": ["roundSeq", "assignmentId", "ordinal"],
                  "additionalProperties": false },
    "disposition": { "type": "string", "enum": ["addressed", "declined", "deferred"] },
    "reason": { "type": ["string", "null"] }
  },
  "required": ["identity", "disposition", "reason"],
  "additionalProperties": false
}
```

`reason` is nullable rather than absent because a strict subset has no optional
properties: "nothing to say" has to be a value.

The two rules the schema can no longer carry moved into
`parseAdvisoryDispositions`, which is already where the checks no schema can
express are reported:

- **A decline owes a reason.** A `declined` entry whose `reason` is null or
  blank produces `Advisory 4:general:1 was declined without a reason. A decline
  owes a one-line reason.` The entry is still recorded as answered first, so a
  bare decline reads as one defect rather than also being reported as an
  advisory that received no disposition.
- **Coverage of the delivered set** (unchanged) — nothing missed, invented, or
  answered twice.

Both surface as the same retryable issue a schema rejection did, so the existing
`ADVISORY_RESPONSE_ATTEMPTS` loop and its identity-naming retry prompt answer
them exactly as before.

Supporting changes:

- `workflowAdvisoryDispositionEntrySchema` became a flat strict object with
  `reason: z.string().nullable()`, mirroring the dispatched schema rather than
  the old discriminated union. `ADVISORY_DISPOSITION_VALUES` is now the single
  source for the vocabulary shared by the Zod twin and the JSON Schema.
- The response prompt states the contract explicitly: *"Every disposition
  carries a `reason` field: the one-line explanation when you decline, and
  `null` otherwise."*
- `.kiro/steering/workflows.md` no longer claims the reason is required by the
  schema.

## Verification

Red-green, then a live check:

1. **Red.** A new test — *"stays inside the strict subset a provider-native
   backend accepts"* — walks the built schema for the three rejected constructs.
   Against the old builder it failed with
   `$.properties.dispositions.items.oneOf is not permitted by the provider`,
   the same defect the provider reported.
2. **Green.** The test passes against the new builder, alongside updated
   coverage for the nullable/required contract, the blank-reason decline, and
   reason trimming.
3. **Live provider.** The rebuilt schema was dumped from the builder itself and
   sent through `codex exec --output-schema`. It was accepted, and the payload
   the model returned —
   `{"dispositions":[{…,"disposition":"addressed","reason":null},{…,"disposition":"declined","reason":"Declined as requested."}]}`
   — passes both `validateJsonSchemaSubset` against the same schema and
   `parseAdvisoryDispositions` against the delivered batch.
4. `test` (diff-scoped), `typecheck`, and `lint` are green. One unrelated arch
   test (`sentinel-public-surface`) timed out under full-suite load and passes
   on its own.

## Known remaining gap

This fix covers the engine's own schema. The same class of failure is still
reachable from **user-authored context output schemas**:
`output-schema-subset.ts` recommends `oneOf` (and refuses `anyOf`), and permits
optional properties. Any execution context whose authored `outputSchema` uses
either will halt identically on a Codex implementer.

The durable fix is a projection at the Codex adapter seam — translate the subset
schema into a strict schema on the way out (`oneOf` → `anyOf`, widen optional
properties to required-and-nullable, `const` → typed `enum`) and drop the
injected nulls on the way back, so the authoritative gate still sees the payload
the authored schema describes. That contradicts the current steering line that
Codex "receives the unmodified schema" and is therefore a design decision, not a
bug fix. A cheaper interim guard would flag incompatible authored schemas in the
schema editor when the context's implementer is Codex.
