import { describe, expect, it } from "vitest";
import {
  VALIDATION_POLL_MAX_WAIT_MS,
  validationActiveRunSchema,
  validationListCommandSchema,
  validationPollQuerySchema,
} from "./api-schemas";
import { DEFAULT_LEASE_TTL_MS } from "./lease";

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

describe("validationPollQuerySchema", () => {
  it("treats an absent waitMs as no hold so an older CLI still gets an instant answer", () => {
    expect(validationPollQuerySchema.parse({}).waitMs).toBe(0);
    expect(validationPollQuerySchema.parse({ waitMs: null }).waitMs).toBe(0);
  });

  it("treats an explicit zero or an empty value as no hold", () => {
    expect(validationPollQuerySchema.parse({ waitMs: "0" }).waitMs).toBe(0);
    expect(validationPollQuerySchema.parse({ waitMs: "" }).waitMs).toBe(0);
  });

  it("accepts an in-range budget verbatim", () => {
    expect(validationPollQuerySchema.parse({ waitMs: "5000" }).waitMs).toBe(
      5000,
    );
  });

  it("clamps an over-cap budget to the server ceiling instead of refusing it", () => {
    expect(validationPollQuerySchema.parse({ waitMs: "600000" }).waitMs).toBe(
      VALIDATION_POLL_MAX_WAIT_MS,
    );
    expect(VALIDATION_POLL_MAX_WAIT_MS).toBe(25_000);
  });

  // A held request renews the run's lease only at entry, so the hold budget
  // is the gap between renewals. Raising it toward the TTL would let the
  // lease sweep reap a run whose submitter is healthy and still waiting.
  it("keeps the hold budget far below the lease TTL it postpones renewal past", () => {
    expect(VALIDATION_POLL_MAX_WAIT_MS).toBeLessThan(DEFAULT_LEASE_TTL_MS / 2);
  });

  it.each(["soon", "1.5", "-1", "1e3", "25 000"])(
    "rejects the uninterpretable budget %j",
    (waitMs) => {
      expect(validationPollQuerySchema.safeParse({ waitMs }).success).toBe(
        false,
      );
    },
  );
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
