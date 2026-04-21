import { describe, expect, it } from "vitest";

import type { McpOverrides } from "@/lib/schemas";

import { applyOperations } from "./overrides-patch";

function empty(): McpOverrides {
  return { servers: {} };
}

describe("applyOperations", () => {
  it("does not mutate the input overrides", () => {
    const input = empty();
    const snapshot = JSON.parse(JSON.stringify(input));
    applyOperations(input, [
      { type: "set-server-enabled", serverKey: "a", enabled: true },
    ]);
    expect(input).toEqual(snapshot);
  });

  it("set-server-enabled preserves an existing tools map", () => {
    const input: McpOverrides = {
      servers: {
        a: { enabled: true, tools: { t: { enabled: false } } },
      },
    };
    const { overrides } = applyOperations(input, [
      { type: "set-server-enabled", serverKey: "a", enabled: false },
    ]);
    expect(overrides.servers.a).toEqual({
      enabled: false,
      tools: { t: { enabled: false } },
    });
  });

  it("reports no change when set-server-enabled applies the same value", () => {
    const input: McpOverrides = {
      servers: { a: { enabled: false } },
    };
    const result = applyOperations(input, [
      { type: "set-server-enabled", serverKey: "a", enabled: false },
    ]);
    expect(result.changedServerKeys).toEqual([]);
  });

  it("reports no change when set-tool-enabled applies the same value", () => {
    const input: McpOverrides = {
      servers: {
        a: { tools: { t: { enabled: false } } },
      },
    };
    const result = applyOperations(input, [
      {
        type: "set-tool-enabled",
        serverKey: "a",
        toolName: "t",
        enabled: false,
      },
    ]);
    expect(result.changedServerKeys).toEqual([]);
  });

  it("preserves insertion order of first-seen changed server keys", () => {
    const input = empty();
    const result = applyOperations(input, [
      { type: "set-server-enabled", serverKey: "b", enabled: false },
      { type: "set-server-enabled", serverKey: "a", enabled: false },
      {
        type: "set-tool-enabled",
        serverKey: "b",
        toolName: "t",
        enabled: false,
      },
    ]);
    expect(result.changedServerKeys).toEqual(["b", "a"]);
  });

  it("reset-server with no existing override is a no-op", () => {
    const input = empty();
    const result = applyOperations(input, [
      { type: "reset-server", serverKey: "missing" },
    ]);
    expect(result.changedServerKeys).toEqual([]);
    expect(result.overrides.servers).toEqual({});
  });

  it("reset-tool preserves sibling tools and the enabled flag", () => {
    const input: McpOverrides = {
      servers: {
        a: {
          enabled: false,
          tools: { t1: { enabled: false }, t2: { enabled: true } },
        },
      },
    };
    const { overrides, changedServerKeys } = applyOperations(input, [
      { type: "reset-tool", serverKey: "a", toolName: "t1" },
    ]);
    expect(changedServerKeys).toEqual(["a"]);
    expect(overrides.servers.a).toEqual({
      enabled: false,
      tools: { t2: { enabled: true } },
    });
  });

  it("reset-tool drops the server entry when no fields remain", () => {
    const input: McpOverrides = {
      servers: { a: { tools: { t: { enabled: false } } } },
    };
    const { overrides, changedServerKeys } = applyOperations(input, [
      { type: "reset-tool", serverKey: "a", toolName: "t" },
    ]);
    expect(changedServerKeys).toEqual(["a"]);
    expect(overrides.servers.a).toBeUndefined();
  });
});
