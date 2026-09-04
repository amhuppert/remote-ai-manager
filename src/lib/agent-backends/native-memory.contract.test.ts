/**
 * Contract over every REGISTERED backend: each one declares what Command
 * Center does about its native provider memory, and the client-safe catalog
 * projects the same answer the server registry holds (spec `memory` R14,
 * criterion memory-crit-native-disclosure).
 *
 * This is the "no backend silently runs two memory systems" backstop. It runs
 * over the registry rather than a hand-listed set, so a fourth backend
 * registering without a declaration fails here instead of quietly inheriting
 * whatever its provider does by default. The per-backend launched-configuration
 * proofs live beside each adapter — a declaration is a claim, and the claim is
 * checked where the provider payload is built.
 */

import { describe, expect, it } from "vitest";

import { bootstrapBackends } from "./registry";
import { listBackends } from "./registry-core";
import { getBackendCatalogEntry } from "./catalog";
import {
  backendNativeMemorySchema,
  listNativeMemoryExceptions,
} from "./native-memory";

bootstrapBackends();

describe("registered backends declare their native-memory disposition", () => {
  const descriptors = listBackends();

  it("registers the backends this delivery was written against", () => {
    expect(descriptors.map((d) => d.id).sort()).toEqual([
      "claude",
      "codex",
      "cursor",
    ]);
  });

  for (const descriptor of descriptors) {
    it(`${descriptor.id} declares a well-formed neutralization`, () => {
      const parsed = backendNativeMemorySchema.safeParse(
        descriptor.nativeMemory,
      );
      expect(parsed.success).toBe(true);
    });

    it(`${descriptor.id}'s catalog projection matches its descriptor`, () => {
      expect(getBackendCatalogEntry(descriptor.id).nativeMemory).toEqual(
        descriptor.nativeMemory,
      );
    });
  }

  it("claude and codex claim a disable mechanism; cursor admits none", () => {
    const byId = new Map(descriptors.map((d) => [d.id, d.nativeMemory]));
    expect(byId.get("claude")?.mechanism).toBe("disabled");
    expect(byId.get("codex")?.mechanism).toBe("disabled");
    expect(byId.get("cursor")?.mechanism).toBe("none");
  });

  it("derives the disclosure set from the declarations, naming only the exceptions", () => {
    const exceptions = listNativeMemoryExceptions(
      descriptors.map((d) => ({
        id: d.id,
        label: d.metadata.label,
        nativeMemory: d.nativeMemory,
      })),
    );
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.backend).toBe("cursor");
    expect(exceptions[0]?.label).toBe("Cursor");
    expect(exceptions[0]?.reason).not.toBe("");
  });
});
