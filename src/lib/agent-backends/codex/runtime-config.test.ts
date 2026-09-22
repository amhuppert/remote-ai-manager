import { describe, expect, it } from "vitest";

import type { ConversationBackendRuntime } from "../conversation";
import type { ResolvedCapabilityCascade } from "../runtime-config";
import {
  createCodexRuntimeConfigAdapter,
  mergeCodexNativeSkillSelectors,
  translateCodexRuntimeCapabilities,
  type CodexCapabilityApplyResult,
  type CodexCapabilityApplyTarget,
  type CodexRuntimeCapabilityConfig,
} from "./runtime-config";

function cascade(
  kinds: ResolvedCapabilityCascade["kinds"],
): ResolvedCapabilityCascade {
  return { backend: "codex", kinds };
}

describe("translateCodexRuntimeCapabilities", () => {
  it("returns an empty config when the cascade carries no kinds", () => {
    expect(translateCodexRuntimeCapabilities(cascade([]))).toEqual({
      config: {},
      capabilities: cascade([]),
    });
  });

  it("emits enabled skills into skills.config[] keyed by item id", () => {
    const result = translateCodexRuntimeCapabilities(
      cascade([
        {
          kind: "skills",
          items: [
            {
              itemId: "skill:absolute:%2Fskills%2Ffoo%2FSKILL.md",
              enabled: true,
              originLayer: "global",
            },
          ],
        },
      ]),
    );
    expect(result.config).toEqual({
      skills: { config: [{ enabled: true, path: "/skills/foo/SKILL.md" }] },
    });
  });

  it("emits a disabled skill (not omitted) so the override carries the disable", () => {
    const result = translateCodexRuntimeCapabilities(
      cascade([
        {
          kind: "skills",
          items: [
            {
              itemId: "skill:absolute:%2Fskills%2Ffoo%2FSKILL.md",
              enabled: false,
              originLayer: "session",
            },
          ],
        },
      ]),
    );
    expect(result.config).toEqual({
      skills: { config: [{ enabled: false, path: "/skills/foo/SKILL.md" }] },
    });
  });

  it("emits a mix of enabled and disabled skills in input order", () => {
    const result = translateCodexRuntimeCapabilities(
      cascade([
        {
          kind: "skills",
          items: [
            {
              itemId: "skill:absolute:%2Fskills%2Fspec-init%2FSKILL.md",
              enabled: true,
              originLayer: "global",
            },
            {
              itemId: "skill:absolute:%2Fskills%2Fspec-tasks%2FSKILL.md",
              enabled: false,
              originLayer: "native",
            },
          ],
        },
      ]),
    );
    expect(result.config).toEqual({
      skills: {
        config: [{ enabled: true, path: "/skills/spec-init/SKILL.md" }],
      },
    });
  });

  it("emits plugins as a record keyed by item id", () => {
    const result = translateCodexRuntimeCapabilities(
      cascade([
        {
          kind: "plugins",
          items: [
            { itemId: "alpha", enabled: true, originLayer: "native" },
            { itemId: "beta", enabled: false, originLayer: "project" },
          ],
        },
      ]),
    );
    expect(result.config).toEqual({
      plugins: {
        alpha: { enabled: true },
        beta: { enabled: false },
      },
    });
  });
});

type FakeRuntime = ConversationBackendRuntime &
  CodexCapabilityApplyTarget & {
    appliedConfigs: CodexRuntimeCapabilityConfig[];
  };

function fakeRuntime(input: {
  status?: "alive" | "dead";
  applyResult?: CodexCapabilityApplyResult;
}): FakeRuntime {
  const appliedConfigs: CodexRuntimeCapabilityConfig[] = [];
  return {
    backend: "codex",
    capabilityWorkingDirectory: "/repo",
    status: input.status ?? "alive",
    modelSelection: {
      modelId: "gpt-5.4",
      parameters: { reasoning: "high", fast: "false" },
    },

    appliedConfigs,
    async sendTurn() {
      throw new Error("not used in this test");
    },
    async close() {},
    async applyCapabilityConfig(config) {
      appliedConfigs.push(config);
      return input.applyResult ?? { status: "applied" };
    },
  };
}

describe("createCodexRuntimeConfigAdapter", () => {
  const resolved = cascade([
    {
      kind: "skills",
      items: [
        {
          itemId: "skill:absolute:%2Fskills%2Fspec-init%2FSKILL.md",
          enabled: true,
          originLayer: "global",
        },
      ],
    },
  ]);

  it("stores the translated config on the runtime for next-turn ingestion and returns applied", async () => {
    const runtime = fakeRuntime({});
    const adapter = createCodexRuntimeConfigAdapter();

    const result = await adapter.apply({ runtime, resolved });

    expect(result).toEqual({ status: "applied" });
    expect(runtime.appliedConfigs).toHaveLength(1);
    expect(runtime.appliedConfigs[0]?.config).toEqual({
      skills: {
        config: [{ enabled: true, path: "/skills/spec-init/SKILL.md" }],
      },
    });
  });

  it("rejects when the runtime is closed", async () => {
    const runtime = fakeRuntime({ status: "dead" });
    const adapter = createCodexRuntimeConfigAdapter();

    const result = await adapter.apply({ runtime, resolved });

    expect(result.status).toBe("rejected");
    expect(runtime.appliedConfigs).toHaveLength(0);
  });

  it("rejects codex+agents — an undeclared capability kind", async () => {
    const runtime = fakeRuntime({});
    const adapter = createCodexRuntimeConfigAdapter();

    const result = await adapter.apply({
      runtime,
      resolved: cascade([{ kind: "agents", items: [] }]),
    });

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toContain("agents");
    }
    expect(runtime.appliedConfigs).toHaveLength(0);
  });
});

it("preserves native disabled selectors when changing another skill", async () => {
  const config = { skills: { config: [{ name: "selected", enabled: true }] } };
  const merged = await mergeCodexNativeSkillSelectors(
    config,
    "/repo",
    async () => [{ name: "native-off", enabled: false }],
  );
  expect(merged.skills?.config).toEqual([
    { name: "native-off", enabled: false },
    { name: "selected", enabled: true },
  ]);
});
