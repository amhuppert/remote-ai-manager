import { describe, expect, it } from "vitest";
import {
  lookupRawContextOutput,
  type RawOutputLookupSource,
} from "./output-lookup";

/**
 * Characterization tests for the raw four-state lookup extracted out of
 * `context-outputs.ts` (D4 T3). They pin the behaviour the layered accessor
 * inherited, plus the own-property discipline the route projection depends on:
 * this is the read a guard evaluates against, so an inherited `Object.prototype`
 * member reaching a guard would be a routing decision made on a payload that
 * does not exist.
 */

interface TestOutput {
  value: Record<string, unknown>;
  iteration: number;
}

const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
};

const PLAN_OUTPUT: TestOutput = { value: { verdict: "ship" }, iteration: 1 };

function source(options: {
  contexts?: Array<{ id: string; outputSchema?: Record<string, unknown> }>;
  outputs?: Record<string, TestOutput>;
}): RawOutputLookupSource<TestOutput> {
  return {
    executionContexts: options.contexts ?? [],
    contextOutputs: options.outputs ?? {},
  };
}

describe("lookupRawContextOutput", () => {
  it("reports a declared schema with a banked payload as captured", () => {
    const result = lookupRawContextOutput(
      source({
        contexts: [{ id: "classify", outputSchema: PLAN_SCHEMA }],
        outputs: { classify: PLAN_OUTPUT },
      }),
      "classify",
    );

    expect(result).toEqual({
      kind: "captured",
      value: { verdict: "ship" },
      output: PLAN_OUTPUT,
    });
  });

  it("reports a declared schema with no banked payload as pending", () => {
    expect(
      lookupRawContextOutput(
        source({ contexts: [{ id: "classify", outputSchema: PLAN_SCHEMA }] }),
        "classify",
      ),
    ).toEqual({ kind: "pending", outputSchema: PLAN_SCHEMA });
  });

  it("reports a banked payload with no declaration as orphaned, never captured", () => {
    expect(
      lookupRawContextOutput(
        source({
          contexts: [{ id: "classify" }],
          outputs: { classify: PLAN_OUTPUT },
        }),
        "classify",
      ),
    ).toEqual({ kind: "orphaned", output: PLAN_OUTPUT });
  });

  it("reports a context with neither declaration nor payload as none", () => {
    expect(
      lookupRawContextOutput(
        source({ contexts: [{ id: "classify" }] }),
        "classify",
      ),
    ).toEqual({ kind: "none" });
  });

  it("reports an unknown context id as none rather than throwing", () => {
    expect(
      lookupRawContextOutput(source({}), "removed-by-a-live-edit"),
    ).toEqual({
      kind: "none",
    });
  });

  describe("own-property discipline", () => {
    it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
      "does not read the inherited %s member as a banked payload",
      (contextId) => {
        expect(
          lookupRawContextOutput(
            source({ contexts: [{ id: contextId }] }),
            contextId,
          ),
        ).toEqual({ kind: "none" });
      },
    );

    it("still reports a pending debt for an exotically named context that declares a schema", () => {
      expect(
        lookupRawContextOutput(
          source({
            contexts: [{ id: "constructor", outputSchema: PLAN_SCHEMA }],
          }),
          "constructor",
        ),
      ).toEqual({ kind: "pending", outputSchema: PLAN_SCHEMA });
    });

    it("reads a genuine OWN payload stored under an exotic key", () => {
      // A computed key defines an own property; the `{"__proto__": …}` literal
      // form would set the prototype instead, which is the trap being pinned.
      const outputs: Record<string, TestOutput> = {
        ["__proto__"]: PLAN_OUTPUT,
      };

      expect(
        lookupRawContextOutput(
          {
            executionContexts: [{ id: "__proto__", outputSchema: PLAN_SCHEMA }],
            contextOutputs: outputs,
          },
          "__proto__",
        ),
      ).toEqual({
        kind: "captured",
        value: { verdict: "ship" },
        output: PLAN_OUTPUT,
      });
    });
  });
});
