import { describe, expect, it } from "vitest";

import type {
  AgentCapabilityOverrideOperation,
  AgentCapabilityOverrides,
} from "./schemas";

import { applyCapabilityOperations } from "./patch";

function empty(): AgentCapabilityOverrides {
  return { cascades: {} };
}

function snapshot(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("applyCapabilityOperations", () => {
  it("does not mutate the input overrides for set-item-enabled", () => {
    const input = empty();
    const before = snapshot(input);
    applyCapabilityOperations({
      current: input,
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });
    expect(input).toEqual(before);
  });

  it("does not mutate a deeply populated input for reset-item", () => {
    const input: AgentCapabilityOverrides = {
      cascades: {
        "claude-skills": {
          items: {
            "skill:a": { enabled: false },
            "skill:b": { enabled: true },
          },
        },
        "claude-plugins": { items: { "plugin:p": { enabled: false } } },
      },
    };
    const before = snapshot(input);
    applyCapabilityOperations({
      current: input,
      cascadeKind: "claude-skills",
      operations: [{ type: "reset-item", itemId: "skill:a" }],
    });
    expect(input).toEqual(before);
  });

  it("set-item-enabled adds the item to the targeted cascade", () => {
    const { overrides, changedItemIds } = applyCapabilityOperations({
      current: empty(),
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });
    expect(changedItemIds).toEqual(["skill:a"]);
    expect(overrides.cascades["claude-skills"]).toEqual({
      items: { "skill:a": { enabled: false } },
    });
  });

  it("preserves sibling items in the same cascade when one item changes", () => {
    const input: AgentCapabilityOverrides = {
      cascades: {
        "claude-skills": {
          items: {
            "skill:a": { enabled: false },
            "skill:b": { enabled: true },
          },
        },
      },
    };
    const { overrides } = applyCapabilityOperations({
      current: input,
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: true },
      ],
    });
    expect(overrides.cascades["claude-skills"]?.items).toEqual({
      "skill:a": { enabled: true },
      "skill:b": { enabled: true },
    });
  });

  it("preserves parent plugins when a child skill cascade is patched", () => {
    const input: AgentCapabilityOverrides = {
      cascades: {
        "claude-plugins": { items: { "plugin:p": { enabled: false } } },
        "claude-skills": { items: { "skill:a": { enabled: true } } },
      },
    };
    const { overrides } = applyCapabilityOperations({
      current: input,
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });
    expect(overrides.cascades["claude-plugins"]).toEqual({
      items: { "plugin:p": { enabled: false } },
    });
  });

  it("preserves unrelated cascades when one cascade is patched", () => {
    const input: AgentCapabilityOverrides = {
      cascades: {
        "claude-skills": { items: { "skill:a": { enabled: false } } },
        "codex-skills": { items: { "codex:a": { enabled: false } } },
      },
    };
    const { overrides } = applyCapabilityOperations({
      current: input,
      cascadeKind: "claude-skills",
      operations: [{ type: "reset-item", itemId: "skill:a" }],
    });
    expect(overrides.cascades["codex-skills"]).toEqual({
      items: { "codex:a": { enabled: false } },
    });
  });

  it("reports no change when set-item-enabled applies the same value", () => {
    const input: AgentCapabilityOverrides = {
      cascades: {
        "claude-skills": { items: { "skill:a": { enabled: false } } },
      },
    };
    const result = applyCapabilityOperations({
      current: input,
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
      ],
    });
    expect(result.changedItemIds).toEqual([]);
    expect(result.overrides.cascades["claude-skills"]).toEqual({
      items: { "skill:a": { enabled: false } },
    });
  });

  it("reset-item is a no-op when no override exists at this layer", () => {
    const result = applyCapabilityOperations({
      current: empty(),
      cascadeKind: "claude-skills",
      operations: [{ type: "reset-item", itemId: "unknown" }],
    });
    expect(result.changedItemIds).toEqual([]);
    expect(result.overrides.cascades["claude-skills"]).toBeUndefined();
  });

  it("reset-item removes the item and prunes the empty cascade record", () => {
    const input: AgentCapabilityOverrides = {
      cascades: {
        "claude-skills": { items: { "skill:a": { enabled: false } } },
      },
    };
    const { overrides, changedItemIds } = applyCapabilityOperations({
      current: input,
      cascadeKind: "claude-skills",
      operations: [{ type: "reset-item", itemId: "skill:a" }],
    });
    expect(changedItemIds).toEqual(["skill:a"]);
    expect(overrides.cascades["claude-skills"]).toBeUndefined();
  });

  it("reset-item preserves siblings in the same cascade", () => {
    const input: AgentCapabilityOverrides = {
      cascades: {
        "claude-skills": {
          items: {
            "skill:a": { enabled: false },
            "skill:b": { enabled: true },
          },
        },
      },
    };
    const { overrides, changedItemIds } = applyCapabilityOperations({
      current: input,
      cascadeKind: "claude-skills",
      operations: [{ type: "reset-item", itemId: "skill:a" }],
    });
    expect(changedItemIds).toEqual(["skill:a"]);
    expect(overrides.cascades["claude-skills"]?.items).toEqual({
      "skill:b": { enabled: true },
    });
  });

  it("applies a batch of operations atomically and reports unique changed ids in insertion order", () => {
    const result = applyCapabilityOperations({
      current: empty(),
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:b", enabled: false },
        { type: "set-item-enabled", itemId: "skill:a", enabled: false },
        { type: "set-item-enabled", itemId: "skill:b", enabled: true },
      ],
    });
    expect(result.changedItemIds).toEqual(["skill:b", "skill:a"]);
    expect(result.overrides.cascades["claude-skills"]?.items).toEqual({
      "skill:b": { enabled: true },
      "skill:a": { enabled: false },
    });
  });

  it("accepts unknown item ids on set so stale overrides survive discovery loss", () => {
    const { overrides, changedItemIds } = applyCapabilityOperations({
      current: empty(),
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:gone", enabled: false },
      ],
    });
    expect(changedItemIds).toEqual(["skill:gone"]);
    expect(overrides.cascades["claude-skills"]?.items["skill:gone"]).toEqual({
      enabled: false,
    });
  });

  it("does not affect unrelated layers because input is replaced, not mutated", () => {
    const layerA: AgentCapabilityOverrides = {
      cascades: {
        "claude-skills": { items: { "skill:a": { enabled: false } } },
      },
    };
    const layerB: AgentCapabilityOverrides = {
      cascades: {
        "claude-skills": { items: { "skill:a": { enabled: true } } },
      },
    };
    const beforeB = snapshot(layerB);
    applyCapabilityOperations({
      current: layerA,
      cascadeKind: "claude-skills",
      operations: [
        { type: "set-item-enabled", itemId: "skill:a", enabled: true },
      ],
    });
    expect(layerB).toEqual(beforeB);
  });

  it("throws on invalid operation payload (extra fields rejected by schema)", () => {
    expect(() =>
      applyCapabilityOperations({
        current: empty(),
        cascadeKind: "claude-skills",
        operations: [
          {
            type: "set-item-enabled",
            itemId: "skill:a",
          } as unknown as AgentCapabilityOverrideOperation,
        ],
      }),
    ).toThrow();
  });
});
