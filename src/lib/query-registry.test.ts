import { describe, it, expect, beforeEach } from "vitest";
import {
  registerQuery,
  getQuery,
  unregisterQuery,
  _resetForTesting,
} from "./query-registry";

beforeEach(() => {
  _resetForTesting();
});

describe("query-registry", () => {
  const fakeQuery = { streamInput: async () => {} } as never;

  it("getQuery returns undefined when no query registered", () => {
    expect(getQuery("conv-unknown")).toBeUndefined();
  });

  it("registerQuery stores query, getQuery retrieves it", () => {
    registerQuery("conv-1", fakeQuery);
    expect(getQuery("conv-1")).toBe(fakeQuery);
  });

  it("unregisterQuery removes the query", () => {
    registerQuery("conv-1", fakeQuery);
    unregisterQuery("conv-1");
    expect(getQuery("conv-1")).toBeUndefined();
  });

  it("unregisterQuery is idempotent for unknown ids", () => {
    expect(() => unregisterQuery("conv-nonexistent")).not.toThrow();
  });

  it("different conversations have independent queries", () => {
    const fakeQuery2 = { streamInput: async () => {} } as never;
    registerQuery("conv-a", fakeQuery);
    registerQuery("conv-b", fakeQuery2);

    expect(getQuery("conv-a")).toBe(fakeQuery);
    expect(getQuery("conv-b")).toBe(fakeQuery2);

    unregisterQuery("conv-a");
    expect(getQuery("conv-a")).toBeUndefined();
    expect(getQuery("conv-b")).toBe(fakeQuery2);

    unregisterQuery("conv-b");
  });

  it("_resetForTesting clears all entries", () => {
    registerQuery("conv-1", fakeQuery);
    registerQuery("conv-2", fakeQuery);
    _resetForTesting();

    expect(getQuery("conv-1")).toBeUndefined();
    expect(getQuery("conv-2")).toBeUndefined();
  });
});
