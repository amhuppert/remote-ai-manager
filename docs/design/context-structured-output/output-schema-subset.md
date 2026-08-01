# Output-schema subset — the one source every surface must import

`src/lib/workflows/primitives/output-schema-subset.ts` is the single definition of
which JSON Schema keywords a context `outputSchema` may use. Import from it. Do not
re-derive a keyword list, and do not re-word the guidance messages — R1.3 requires that
every error an editor shows corresponds to a real server refusal, and a second list is
exactly the drift that breaks.

## What it exports

| export | what it is |
|---|---|
| `validateJsonSchemaSubset(schema, value)` | the runtime validator the structured-output gate runs against a produced value |
| `validateOutputSchemaDeclaration(schema)` | pure authoring-time walker → `{ path, message }[]`, `path` rooted at `$` (e.g. `$.properties.findings.items.format`); empty array = fully enforceable |
| `OUTPUT_SCHEMA_SUPPORTED_KEYWORDS` | enforced keywords grouped by the dispatch branch that reads them (`common` / `object` / `array` / `string` / `number`) |
| `OUTPUT_SCHEMA_ANNOTATION_KEYWORDS` | documentation-only keywords that are accepted (`title`, `description`, …) |
| `UNSUPPORTED_OUTPUT_SCHEMA_KEYWORDS` | `ReadonlyMap<string, string>`: keyword → guidance message for refused keywords (`$ref`, `anyOf`, `allOf`, `format`, …) |
| `outputSchemaKeywordGuidance(keyword)` | the refusal message for any out-of-subset keyword — specific when the map has one, generic otherwise |
| `OUTPUT_SCHEMA_SUPPORTED_TYPES` | the `type` values the validator can check |

`structured-output-gate.ts` re-exports all of it for server callers.

**Call `outputSchemaKeywordGuidance()` rather than indexing the map.** It is a `Map`, not a
plain object, on purpose: `constructor` and `toString` are legal JSON property names, and
indexing a plain object with them returns an inherited *function* instead of a message.
Any surface that renders "why was this refused" must go through the accessor.

## Why it is a separate module

It is dependency-free — no logger, no `node:` imports — so a `"use client"` component can
import it directly. The gate module creates a logger at module scope, which pulls in
`node:fs`; importing the descriptor through the gate breaks the browser bundle, and only
`bun run build` reports that. `output-schema-subset.arch.test.ts` pins the property.

## Rules the walker enforces (and why)

The subset validator silently ignores anything it does not implement, so the walker
refuses every such declaration fail-closed rather than shipping a constraint that never
runs:

- **Unsupported keywords** — `$ref`, `$defs`, `anyOf`, `allOf`, `not`, `if`/`then`/`else`,
  `format`, `prefixItems`, `uniqueItems`, `multipleOf`, `exclusive*`, … each with its own
  repair guidance. `oneOf` **is** supported.
- **Keywords the declared type never selects** — `minLength` on an array node, any
  type-specific keyword on a node with no `type` or a union `type`. A union type itself is
  fine; it just cannot carry type-specific constraints. This mirrors the runtime dispatch
  literally, including its asymmetry: object keywords reach `validateObjectSchema` no matter
  how `type` is written (so `type: ["object"]` **is** enforced and accepted), while a
  non-object type written as an array — `type: ["string"]` — reaches no branch at all,
  because the runtime compares `type === "string"` against the array itself.
- **Object keywords beside a type admitting a non-object** — `{type: ["object","null"],
  properties: …}` routes every value into object validation, which rejects `null`. The node
  cannot accept what it declares, so it is refused at `.type` as unsatisfiable rather than
  mislabelled "not read".
- **Siblings of a short-circuit keyword** — the validator returns at `oneOf` (before
  everything, including `type`) and at `const` (after `enum`), so shadowed siblings are
  refused. `enum` stays live beside `const`.
- **Object/array-valued `enum` entries and `const`** — compared by reference at runtime, so
  they can never match a parsed payload.
- **Root shape** — the root must describe an object (`type: "object"`, a singleton
  `type: ["object"]`, an implied object shape, or a `oneOf` over object branches), because a
  structured-output payload is a JSON object.

Property names are **not** restricted: `constructor`, `toString` and friends are legal JSON
keys, and both the runtime validator and the walker read payload keys as own properties so
they behave correctly. Locators bracket-quote any key that is not a plain identifier, so
`properties: { "http.status": … }` locates as `properties["http.status"]` and can never be
confused with a real nesting.

## Where refusals already happen

Every definition accept path runs the walker through `validateWorkflowDefinition`:
project-tier and global-tier validate/create/replace, saved-tier edits
(`applyDefinitionEdits`), live-tier edits (the execution-frontier check), and seed-time
re-validation. Refusals carry `contextId` plus a
`executionContexts[<i>].outputSchema.<schema path>` locator, which
`plan-validation.ts` renders as `definition.executionContexts[<i>].outputSchema.…`.

## Already wired (do not redo)

Both edit tiers accept the field: saved `add-context` / `update-context` and live
`add-context` / `update-context` in `src/lib/workflows/edit-schemas.ts`. Semantics: present
replaces the declaration wholesale (a JSON Schema document has no partial merge), `null`
clears it on `update-context`, absent leaves it untouched. It is never seeded from
`configFromContextId` — it is per-context identity, not inheritable config (D1).

The field also rides the ordinary lifecycle gate on the live tier: it gets no bypass, so a
frozen (completed) context refuses both a set and a clear with code `frozen`.

The server-side live outline carries the declaration in `LiveOutlineResolvedConfig`
(`live-outline.ts`), so the `--config` / `--context` / `--full` selectors read it back. The
compact outline row carries only its SHAPE (`summarizeOutputSchemaShape` in
`context-outputs.ts` → `{type, fieldCount}`, rendered `output schema: object · 4 fields`) —
the same discipline that sizes prose instead of inlining it. `iterationPolicy` /
`planRepair` / `circuitBreaker` stay section-tier-only.

## Named deferrals

No production UI consumes these exports yet. That is T8 (`OutputSchemaField` + builder
inspector) and T9 (ContextConfigTab live editing), both in lane `context-lane-ui-editing`.
T7 (edit tiers + live outline) and T14 (CLI read surfaces — the outline shape summary and
`cctl workflow live get --outputs`) are done.
