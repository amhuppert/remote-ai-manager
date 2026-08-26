/**
 * The Cursor runtime-config apply seam.
 *
 * Cursor declares an EMPTY capability-kind set: the worker attaches under
 * `settingSources: []`, so there is no skills/plugins/agents surface for a
 * cascade to reach. That makes the interesting behavior the refusals — a
 * cascade carrying any kind must be rejected loudly rather than silently
 * dropped, which is the difference between "this backend has no cascade" and
 * "this backend quietly ignored yours".
 */

import { describe, expect, it } from "vitest";
import { createCursorRuntimeConfigAdapter } from "./runtime-config";
import type { ConversationBackendRuntime } from "../conversation";
import type { ResolvedCapabilityCascade } from "../runtime-config";

const MODEL_SELECTION = {
  modelId: "composer-2.5",
  parameters: { fast: "true" },
} as const;

function stubRuntime(
  status: "alive" | "dead" = "alive",
): ConversationBackendRuntime {
  return {
    backend: "cursor",
    status,
    modelSelection: MODEL_SELECTION,
    outputFormat: undefined,
    alignmentVersion: null,
    async sendTurn(): Promise<never> {
      throw new Error("not driven in this test");
    },
    async close() {},
  };
}

const EMPTY_CASCADE: ResolvedCapabilityCascade = {
  backend: "cursor",
  kinds: [],
};

describe("createCursorRuntimeConfigAdapter", () => {
  it("carries the cursor backend id", () => {
    expect(createCursorRuntimeConfigAdapter().backend).toBe("cursor");
  });

  it("applies an empty cascade — there is nothing to translate", async () => {
    const result = await createCursorRuntimeConfigAdapter().apply({
      runtime: stubRuntime(),
      resolved: EMPTY_CASCADE,
    });
    expect(result).toEqual({ status: "applied" });
  });

  it("rejects every capability kind by name rather than dropping it", async () => {
    const adapter = createCursorRuntimeConfigAdapter();
    for (const kind of ["skills", "plugins", "agents"] as const) {
      const result = await adapter.apply({
        runtime: stubRuntime(),
        resolved: {
          backend: "cursor",
          kinds: [
            {
              kind,
              items: [{ itemId: "x", enabled: true, originLayer: "global" }],
            },
          ],
        },
      });
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.error).toContain(kind);
      }
    }
  });

  it("rejects a cascade addressed to another backend", async () => {
    const result = await createCursorRuntimeConfigAdapter().apply({
      runtime: stubRuntime(),
      resolved: { backend: "codex", kinds: [] },
    });
    expect(result.status).toBe("rejected");
  });

  it("rejects an apply against a closed runtime", async () => {
    const result = await createCursorRuntimeConfigAdapter().apply({
      runtime: stubRuntime("dead"),
      resolved: EMPTY_CASCADE,
    });
    expect(result.status).toBe("rejected");
  });
});
