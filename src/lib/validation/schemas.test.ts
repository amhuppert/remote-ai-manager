import { describe, expect, it } from "vitest";
import {
  globalValidationConfigSchema,
  repoValidationConfigSchema,
  validationCommandConfigSchema,
  validationLeaseSchema,
  validationRunRecordSchema,
  validationRunResultSchema,
  validationRunSourceSchema,
  validationRunStatusSchema,
} from "./schemas";

describe("validationCommandConfigSchema", () => {
  it("parses a minimal entry and defaults scopeArgs to forbid", () => {
    const parsed = validationCommandConfigSchema.parse({
      command: "scripts/validate/lint.sh",
      cost: 2,
    });

    expect(parsed).toEqual({
      command: "scripts/validate/lint.sh",
      cost: 2,
      scopeArgs: "forbid",
    });
  });

  it("retains optional timeoutMs, description, and scopeArgs paths", () => {
    const parsed = validationCommandConfigSchema.parse({
      command: "scripts/validate/test.sh",
      cost: 8,
      timeoutMs: 900_000,
      description: "Scoped test suite",
      scopeArgs: "paths",
    });

    expect(parsed.timeoutMs).toBe(900_000);
    expect(parsed.description).toBe("Scoped test suite");
    expect(parsed.scopeArgs).toBe("paths");
  });

  it("rejects a missing cost", () => {
    expect(
      validationCommandConfigSchema.safeParse({ command: "scripts/x.sh" })
        .success,
    ).toBe(false);
  });

  it.each([[0], [-1], [1.5]])(
    "rejects non-positive-integer cost %s",
    (cost) => {
      expect(
        validationCommandConfigSchema.safeParse({
          command: "scripts/x.sh",
          cost,
        }).success,
      ).toBe(false);
    },
  );

  it("rejects a non-positive timeoutMs", () => {
    expect(
      validationCommandConfigSchema.safeParse({
        command: "scripts/x.sh",
        cost: 1,
        timeoutMs: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown scopeArgs value", () => {
    expect(
      validationCommandConfigSchema.safeParse({
        command: "scripts/x.sh",
        cost: 1,
        scopeArgs: "flags",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty command path", () => {
    expect(
      validationCommandConfigSchema.safeParse({ command: "", cost: 1 }).success,
    ).toBe(false);
  });
});

describe("repoValidationConfigSchema", () => {
  const commands = {
    lint: { command: "scripts/validate/lint.sh", cost: 2 },
    "test-unit": { command: "scripts/validate/test.sh", cost: 8 },
  };

  it("parses a registry and defaults preMerge to an empty list", () => {
    const parsed = repoValidationConfigSchema.parse({ commands });

    expect(Object.keys(parsed.commands)).toEqual(["lint", "test-unit"]);
    expect(parsed.preMerge).toEqual([]);
    expect(parsed.laneMerge).toBeUndefined();
  });

  it("keeps preMerge order and an optional laneMerge list", () => {
    const parsed = repoValidationConfigSchema.parse({
      commands,
      preMerge: ["test-unit", "lint"],
      laneMerge: ["lint"],
    });

    expect(parsed.preMerge).toEqual(["test-unit", "lint"]);
    expect(parsed.laneMerge).toEqual(["lint"]);
  });

  it.each([["Test"], ["test_unit"], ["-lint"], ["lint-"], [""]])(
    "rejects the non-kebab-case command name %j",
    (name) => {
      expect(
        repoValidationConfigSchema.safeParse({
          commands: { [name]: { command: "scripts/x.sh", cost: 1 } },
        }).success,
      ).toBe(false);
    },
  );

  it("rejects a preMerge entry that names no registered command", () => {
    const result = repoValidationConfigSchema.safeParse({
      commands,
      preMerge: ["typecheck"],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["preMerge", 0],
        message: expect.stringContaining("typecheck"),
      }),
    );
  });

  it("rejects a laneMerge entry that names no registered command", () => {
    const result = repoValidationConfigSchema.safeParse({
      commands,
      laneMerge: ["format"],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["laneMerge", 0],
        message: expect.stringContaining("format"),
      }),
    );
  });
});

describe("globalValidationConfigSchema", () => {
  it("defaults concurrencyLimit to 8 and defaultTimeoutMs to 600000", () => {
    expect(globalValidationConfigSchema.parse({})).toEqual({
      concurrencyLimit: 8,
      defaultTimeoutMs: 600_000,
    });
  });

  it("accepts explicit overrides", () => {
    expect(
      globalValidationConfigSchema.parse({
        concurrencyLimit: 4,
        defaultTimeoutMs: 120_000,
      }),
    ).toEqual({ concurrencyLimit: 4, defaultTimeoutMs: 120_000 });
  });

  it.each([[0], [-2], [2.5]])(
    "rejects the non-positive-integer concurrencyLimit %s",
    (concurrencyLimit) => {
      expect(
        globalValidationConfigSchema.safeParse({ concurrencyLimit }).success,
      ).toBe(false);
    },
  );

  it("rejects a non-positive defaultTimeoutMs", () => {
    expect(
      globalValidationConfigSchema.safeParse({ defaultTimeoutMs: 0 }).success,
    ).toBe(false);
  });
});

describe("validationRunSourceSchema", () => {
  it.each([
    ["agent_cli"],
    ["graph_script_validator"],
    ["graph_lane_merge"],
    ["smart_merge"],
    ["smart_commit"],
  ])("accepts %s", (source) => {
    expect(validationRunSourceSchema.parse(source)).toBe(source);
  });

  it("rejects an unknown source", () => {
    expect(validationRunSourceSchema.safeParse("pre_commit").success).toBe(
      false,
    );
  });
});

describe("validationRunResultSchema", () => {
  it.each([
    [{ kind: "skipped_by_policy", message: 'Skipped "format".' }],
    [
      {
        kind: "capacity_unavailable",
        cost: 8,
        inUse: 3,
        limit: 8,
        queueDepth: 1,
        blockedByOlderWaiter: false,
      },
    ],
    [{ kind: "queued", runId: "run-1", position: 2 }],
    [{ kind: "passed", runId: "run-1", exitCode: 0, output: "ok" }],
    [{ kind: "failed", runId: "run-1", exitCode: 1, output: "boom" }],
    [
      {
        kind: "timed_out",
        runId: "run-1",
        timeoutMs: 600_000,
        output: "partial",
      },
    ],
    [{ kind: "cancelled", runId: "run-1" }],
    [{ kind: "interrupted", runId: "run-1" }],
    [
      {
        kind: "command_not_found",
        name: "tset",
        knownCommands: ["test", "lint"],
      },
    ],
    [{ kind: "cost_exceeds_limit", name: "test", cost: 9, limit: 8 }],
  ])("accepts the $0.kind result", (result) => {
    expect(validationRunResultSchema.parse(result)).toEqual(result);
  });

  it("models a spawn error as failed with a null exit code", () => {
    const parsed = validationRunResultSchema.parse({
      kind: "failed",
      runId: "run-1",
      exitCode: null,
      output: "spawn ENOENT",
    });

    expect(parsed.kind).toBe("failed");
  });

  it("rejects an unknown result kind", () => {
    expect(
      validationRunResultSchema.safeParse({ kind: "clamped" }).success,
    ).toBe(false);
  });
});

describe("validation run record and lease", () => {
  const record = {
    runId: "run-1",
    source: "agent_cli",
    commandName: "test-unit",
    cost: 8,
    queueOrder: 12,
    status: "passed",
    nonce: "nonce-abc",
    leaseToken: "lease-xyz",
    leaseExpiresAt: "2026-08-05T10:00:30.000Z",
    processGroupPid: 4321,
    projectPath: "/projects/app",
    worktreePath: "/projects/app/.worktrees/session",
    sessionName: "session",
    conversationId: "conv-1",
    workflowExecutionId: "exec-1",
    workflowContextId: "ctx-api",
    workflowRole: "implementer",
    submittedAt: "2026-08-05T10:00:00.000Z",
    startedAt: "2026-08-05T10:00:05.000Z",
    finishedAt: "2026-08-05T10:02:05.000Z",
    queueMs: 5_000,
    execMs: 120_000,
    scoped: true,
    scopedPathCount: 2,
    exitCode: 0,
    timedOut: false,
  };

  it("parses a complete terminal record", () => {
    expect(validationRunRecordSchema.parse(record)).toEqual(record);
  });

  it("parses a system-owned queued record with null lease and timing", () => {
    const queued = {
      ...record,
      source: "graph_lane_merge",
      status: "queued",
      leaseToken: null,
      leaseExpiresAt: null,
      processGroupPid: null,
      sessionName: null,
      conversationId: null,
      workflowRole: null,
      startedAt: null,
      finishedAt: null,
      queueMs: null,
      execMs: null,
      scoped: false,
      scopedPathCount: 0,
      exitCode: null,
    };

    expect(validationRunRecordSchema.parse(queued)).toEqual(queued);
  });

  it("rejects a record with a non-positive cost snapshot", () => {
    expect(
      validationRunRecordSchema.safeParse({ ...record, cost: 0 }).success,
    ).toBe(false);
  });

  it("rejects a record without a nonce", () => {
    expect(
      validationRunRecordSchema.safeParse({ ...record, nonce: "" }).success,
    ).toBe(false);
  });

  it("covers every ledger status", () => {
    for (const status of [
      "queued",
      "running",
      "passed",
      "failed",
      "timed_out",
      "cancelled",
      "interrupted",
    ]) {
      expect(validationRunStatusSchema.parse(status)).toBe(status);
    }
    expect(validationRunStatusSchema.safeParse("rejected").success).toBe(false);
  });

  it("parses a lease and rejects an empty token", () => {
    expect(
      validationLeaseSchema.parse({
        runId: "run-1",
        token: "lease-xyz",
        expiresAt: "2026-08-05T10:00:30.000Z",
      }).token,
    ).toBe("lease-xyz");
    expect(
      validationLeaseSchema.safeParse({
        runId: "run-1",
        token: "",
        expiresAt: "2026-08-05T10:00:30.000Z",
      }).success,
    ).toBe(false);
  });
});
