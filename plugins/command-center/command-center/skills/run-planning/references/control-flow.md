# Routes and loops

Reference for [run-planning](../SKILL.md). Read it when work runs only if an earlier result says so, or repeats until a result says it is done.

Agents supply judgment only as a structured result (`outputSchema`); the run evaluates routes and loop exits on it, durably. No agent decides which branch runs.

## Schemas the run evaluates

A route guard, a loop's `until` and the `outputSchema` they read use one JSON Schema subset: `type`, `enum`, `const` and `oneOf` at any node; `properties`, `required` and `additionalProperties` on objects; `items`, `minItems` and `maxItems` on arrays; `minLength`, `maxLength` and `pattern` on strings; `minimum` and `maximum` on numbers. `title`, `description`, `default` and `examples` are allowed as annotations. `$ref`, `anyOf`, `allOf`, `not`, `if`/`then`/`else` and `format` are refused; express the condition positively, with `oneOf` for exclusive branches.

The keywords also combine narrowly. Beside `const` only `enum` is allowed, and beside `oneOf` nothing but annotations, so write `{"const": "pass"}` without a `type`. Array, string and number keywords need an explicit `type`. Every root describes an object: `type: "object"`, `properties`, or a `oneOf` over object branches. `enum` and `const` values are primitives, and `additionalProperties` is a boolean. In a guard or `until`, always list the property you test in `required`: without it, a result that lacks the property matches.

## Routes

A dependency becomes a route with `when`:

- `{"key": "<source>", "when": {"schema": {...}}}` is taken when the source's accepted result matches the schema.
- `{"key": "<source>", "when": {"else": true}}` is taken when no guarded route from that source matched. A source has at most one, and only beside a guarded route.
- A plain dependency is always taken.

The source needs an `outputSchema`, and each guard must be able to match it; a misspelt property or a value outside its `enum` is refused. List a source once in a context's `dependsOn`.

**Skips.** A context whose route is not taken is skipped: not failed, and never revived. A context with any route not taken is skipped even when its other dependencies ran, and an `else` from a skipped source is not taken. A plain dependency on a skipped context drops out, so a context that joins alternative branches runs when one of them ran; it is skipped only when every dependency was skipped. Skips carry down a chain that way. Never route away the only context that delivers an obligation; guard a branch so it can run rather than planning to revive it.

**Cardinality.** By default a source's routes are independent: any number may be taken. Set `"routing": {"cardinality": "atLeastOne"}` or `"exactlyOne"` on the source to require it; only a source with guarded routes takes `routing`. A result that takes the wrong number of routes halts the run until you amend its routes ([amending.md](amending.md)). With `exactlyOne` and an `else`, under-selection is impossible, so a halt means two guards overlap.

```json
{
  "title": "Handle a failing build",
  "contexts": [
    {
      "key": "triage",
      "brief": "Find why the main build fails. Change nothing.",
      "scope": { "mode": "readOnly" },
      "outputSchema": {
        "type": "object",
        "properties": { "cause": { "type": "string", "enum": ["flaky-test", "defect"] }, "summary": { "type": "string" } },
        "required": ["cause", "summary"]
      },
      "routing": { "cardinality": "exactlyOne" }
    },
    {
      "key": "quarantine",
      "brief": "Mark the flaky test as quarantined and file it for follow-up.",
      "dependsOn": [{ "key": "triage", "when": { "schema": { "properties": { "cause": { "const": "flaky-test" } }, "required": ["cause"] } } }]
    },
    {
      "key": "fix",
      "brief": "Fix the defect the triage found.",
      "dependsOn": [{ "key": "triage", "when": { "else": true } }],
      "checks": ["test"]
    }
  ]
}
```

`quarantine` and `fix` both write the whole worktree without ordering, which is allowed only because one route excludes the other.

## Loops

`loops: [{key, body, entry, exit, until: {schema}, maxPasses}]` reruns a body of contexts until the exit's accepted result matches `until`, or `maxPasses` passes ran.

- `body` lists the member context keys; `entry` and `exit` are members. Each pass runs every member in fresh contexts.
- Only the entry depends on work outside the loop, and only the exit is depended on from outside. Every member is reached from the entry and leads to the exit.
- The body has no routes: route into the entry or out of the exit instead. Loops do not nest or overlap.
- The exit needs an `outputSchema` that `until` can match.
- From the second pass, the entry receives the exit's results from up to three recent passes, beside its own inputs. Write its brief to act on them: "fix the problems the judge's latest result lists".
- Work after the loop depends on the exit and sees only the final pass's result.
- An exhausted loop halts the run; amend it with a higher `maxPasses` to run more passes. An exit result the run cannot read halts it for good: cancel and relaunch.

A worker and a read-only judge make the usual body:

```json
{
  "title": "Harden the config parser",
  "loops": [
    {
      "key": "refine",
      "body": ["revise", "judge"],
      "entry": "revise",
      "exit": "judge",
      "until": { "schema": { "properties": { "verdict": { "const": "pass" } }, "required": ["verdict"] } },
      "maxPasses": 3
    }
  ],
  "contexts": [
    {
      "key": "revise",
      "brief": "Make the config parser reject the malformed inputs in the judge's latest problems, or the cases in tests/config if there are none yet."
    },
    {
      "key": "judge",
      "brief": "Try to break the config parser with malformed input. Report each input it accepts that it should refuse.",
      "dependsOn": ["revise"],
      "scope": { "mode": "readOnly" },
      "outputSchema": {
        "type": "object",
        "properties": { "verdict": { "type": "string", "enum": ["pass", "revise"] }, "problems": { "type": "array", "items": { "type": "string" } } },
        "required": ["verdict", "problems"]
      }
    },
    {
      "key": "summary",
      "brief": "Summarize what the parser now refuses in docs/config.md.",
      "dependsOn": ["judge"]
    }
  ]
}
```

Set `maxPasses` to the passes the work is worth: each pass costs a full implementation and review.

## Before launching, confirm

The check verb enforces the structural rules above. It cannot see guards that overlap or leave gaps, guards that a `pattern` or a bound makes unmatchable, an obligation that lives only on a context a route can skip, or a loop entry whose brief ignores the earlier passes' results.
