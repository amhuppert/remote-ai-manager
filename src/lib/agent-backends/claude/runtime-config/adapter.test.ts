import { describe, expect, it } from "vitest";

import type { ConversationBackendRuntime } from "../../conversation";
import type { ResolvedCapabilityCascade } from "../../runtime-config";
import { createClaudeRuntimeConfigAdapter } from "./adapter";
import type {
  ClaudeCapabilityApplyResult,
  ClaudeCapabilityApplyTarget,
} from "./adapter";
import type { ClaudePluginNativeRecord } from "./plugin-translator";
import type { ClaudeRuntimeCapabilityConfig } from "./translator";

type FakeRuntime = ConversationBackendRuntime &
  ClaudeCapabilityApplyTarget & {
    appliedConfigs: ClaudeRuntimeCapabilityConfig[];
  };

function fakeRuntime(input: {
  status?: "alive" | "dead";
  isTurnActive?: boolean;
  applyResult?: ClaudeCapabilityApplyResult;
}): FakeRuntime {
  const appliedConfigs: ClaudeRuntimeCapabilityConfig[] = [];
  return {
    backend: "claude",
    capabilityWorkingDirectory: "/repo",
    status: input.status ?? "alive",
    isTurnActive: input.isTurnActive ?? false,
    modelSelection: {
      modelId: "opus",
      parameters: { effort: "high" },
    },

    appliedConfigs,
    async sendTurn() {
      throw new Error("not used in this test");
    },
    async close() {},
    async applyCapabilityConfig(config) {
      appliedConfigs.push(config);
      if (input.isTurnActive) return { status: "skipped-turn-active" };
      return input.applyResult ?? { status: "applied" };
    },
  };
}

const resolved: ResolvedCapabilityCascade = {
  backend: "claude",
  kinds: [
    {
      kind: "plugins",
      items: [{ itemId: "p@mkt", enabled: false, originLayer: "global" }],
    },
    {
      kind: "skills",
      items: [
        { itemId: "commit-helper", enabled: true, originLayer: "global" },
      ],
    },
  ],
};

function adapterWithNativeRecords(
  records: readonly ClaudePluginNativeRecord[] = [],
) {
  return createClaudeRuntimeConfigAdapter({
    readNativePluginRecords: async () => records,
  });
}

describe("createClaudeRuntimeConfigAdapter", () => {
  it("translates the neutral cascade below the seam and applies it to the runtime", async () => {
    const runtime = fakeRuntime({});
    const adapter = adapterWithNativeRecords([
      { pluginId: "p@mkt", nativeEnabled: true, nativeRawValue: true },
    ]);

    const result = await adapter.apply({ runtime, resolved });

    expect(result).toEqual({ status: "applied" });
    expect(runtime.appliedConfigs).toHaveLength(1);
    expect(runtime.appliedConfigs[0]?.enabledPlugins).toEqual({
      "p@mkt": false,
    });
    expect(runtime.appliedConfigs[0]?.skillOverrides).toEqual({
      "commit-helper": "on",
    });
  });

  it("maps the runtime's skipped-turn-active to deferred/turn_active", async () => {
    const runtime = fakeRuntime({ isTurnActive: true });
    const adapter = adapterWithNativeRecords();

    const result = await adapter.apply({ runtime, resolved });

    expect(result).toEqual({ status: "deferred", reason: "turn_active" });
  });

  it("rejects when the runtime is dead without touching the apply surface", async () => {
    const runtime = fakeRuntime({ status: "dead" });
    const adapter = adapterWithNativeRecords();

    const result = await adapter.apply({ runtime, resolved });

    expect(result.status).toBe("rejected");
    expect(runtime.appliedConfigs).toHaveLength(0);
  });

  it("rejects an undeclared capability kind loudly (never a silent drop)", async () => {
    const runtime = fakeRuntime({});
    const adapter = adapterWithNativeRecords();

    const result = await adapter.apply({
      runtime,
      resolved: {
        backend: "claude",
        kinds: [{ kind: "widgets" as never, items: [] }],
      },
    });

    expect(result.status).toBe("rejected");
    expect(runtime.appliedConfigs).toHaveLength(0);
  });

  it("rejects when native plugin records cannot be read", async () => {
    const runtime = fakeRuntime({});
    const adapter = createClaudeRuntimeConfigAdapter({
      readNativePluginRecords: async () => {
        throw new Error("settings.json corrupted");
      },
    });

    const result = await adapter.apply({ runtime, resolved });

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toContain("settings.json corrupted");
    }
    expect(runtime.appliedConfigs).toHaveLength(0);
  });

  it("rejects a cascade addressed to another backend", async () => {
    const runtime = fakeRuntime({});
    const adapter = adapterWithNativeRecords();

    const result = await adapter.apply({
      runtime,
      resolved: { backend: "codex", kinds: [] },
    });

    expect(result.status).toBe("rejected");
  });
});
