import { describe, expect, it } from "vitest";
import {
  validationActiveRunSchema,
  validationListCommandSchema,
} from "./api-schemas";

const baseListCommand = {
  name: "test",
  description: null,
  pathArgs: "paths" as const,
  changedScope: "native" as const,
  timeoutMs: 600_000,
  enabled: true,
};

describe("validationListCommandSchema", () => {
  it("parses a scalar registration cost", () => {
    const parsed = validationListCommandSchema.parse({
      ...baseListCommand,
      cost: 4,
    });

    expect(parsed.cost).toBe(4);
  });

  it("carries the scope-aware registration cost table over the wire", () => {
    const parsed = validationListCommandSchema.parse({
      ...baseListCommand,
      cost: { full: 8, changed: 4, paths: { base: 1, perPath: 1 } },
    });

    expect(parsed.cost).toEqual({
      full: 8,
      changed: 4,
      paths: { base: 1, perPath: 1 },
    });
  });

  it("parses a table that omits the optional changed and paths weights", () => {
    const parsed = validationListCommandSchema.parse({
      ...baseListCommand,
      cost: { full: 5 },
    });

    expect(parsed.cost).toEqual({ full: 5 });
  });

  it.each([
    { full: 4, changed: 8 },
    { full: 8, changed: 2, paths: { base: 4, perPath: 1 } },
    { changed: 2 },
    { full: 8, paths: { base: 1 } },
    { full: 8, extra: 1 },
  ])("rejects the incoherent registration cost %j", (cost) => {
    expect(
      validationListCommandSchema.safeParse({ ...baseListCommand, cost })
        .success,
    ).toBe(false);
  });
});

describe("validationActiveRunSchema", () => {
  // The run row carries the weight resolved at submission, so a table here
  // would mean an unresolved reservation reached the scheduler.
  it("rejects a registration cost table on an active run row", () => {
    expect(
      validationActiveRunSchema.safeParse({
        runId: "vrun-1",
        commandName: "test",
        status: "running",
        cost: { full: 8, changed: 4 },
        source: "agent_cli",
        projectPath: "/tmp/project",
        conversationId: null,
        requestedScope: "changed",
        effectiveScope: "changed",
        position: null,
      }).success,
    ).toBe(false);
  });
});
