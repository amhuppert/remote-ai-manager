import { describe, expect, it } from "vitest";
import {
  globalValidationConfigSchema,
  repoValidationConfigSchema,
  validationCommandConfigSchema,
  validationCommandCostSchema,
  validationLeaseSchema,
  validationRunRecordSchema,
  validationRunResultSchema,
  validationRunSourceSchema,
  validationRunStatusSchema,
} from "./schemas";

describe("validationCommandConfigSchema", () => {
  it("parses a full-only entry and defaults pathArgs to forbid", () => {
    const parsed = validationCommandConfigSchema.parse({
      command: { full: "scripts/validate/lint-full.sh" },
      cost: 2,
    });

    expect(parsed).toEqual({
      command: { full: "scripts/validate/lint-full.sh" },
      cost: 2,
      pathArgs: "forbid",
    });
  });

  it("retains changed/full executables and optional shared fields", () => {
    const parsed = validationCommandConfigSchema.parse({
      command: {
        full: "scripts/validate/test-full-suite.sh",
        changed: "scripts/validate/test.sh",
      },
      cost: 8,
      timeoutMs: 900_000,
      description: "Unit tests",
      pathArgs: "paths",
    });

    expect(parsed.timeoutMs).toBe(900_000);
    expect(parsed.description).toBe("Unit tests");
    expect(parsed.pathArgs).toBe("paths");
  });

  it("rejects a missing cost", () => {
    expect(
      validationCommandConfigSchema.safeParse({
        command: { full: "scripts/x.sh" },
      }).success,
    ).toBe(false);
  });

  it.each([[0], [-1], [1.5]])(
    "rejects non-positive-integer cost %s",
    (cost) => {
      expect(
        validationCommandConfigSchema.safeParse({
          command: { full: "scripts/x.sh" },
          cost,
        }).success,
      ).toBe(false);
    },
  );

  it("rejects a non-positive timeoutMs", () => {
    expect(
      validationCommandConfigSchema.safeParse({
        command: { full: "scripts/x.sh" },
        cost: 1,
        timeoutMs: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects the old flat registration and scopeArgs field", () => {
    expect(
      validationCommandConfigSchema.safeParse({
        command: "scripts/x.sh",
        cost: 1,
      }).success,
    ).toBe(false);
    expect(
      validationCommandConfigSchema.safeParse({
        command: { full: "scripts/x.sh" },
        cost: 1,
        scopeArgs: "paths",
      }).success,
    ).toBe(false);
  });

  it("rejects missing or empty full executables and unknown variant keys", () => {
    expect(
      validationCommandConfigSchema.safeParse({ command: {}, cost: 1 }).success,
    ).toBe(false);
    expect(
      validationCommandConfigSchema.safeParse({
        command: { full: "" },
        cost: 1,
      }).success,
    ).toBe(false);
    expect(
      validationCommandConfigSchema.safeParse({
        command: { full: "scripts/x.sh", focused: "scripts/y.sh" },
        cost: 1,
      }).success,
    ).toBe(false);
  });

  it("parses a scope-aware cost table", () => {
    const parsed = validationCommandConfigSchema.parse({
      command: {
        full: "scripts/validate/test-full.sh",
        changed: "scripts/validate/test.sh",
      },
      cost: { full: 8, changed: 4, paths: { base: 1, perPath: 1 } },
      pathArgs: "paths",
    });

    expect(parsed.cost).toEqual({
      full: 8,
      changed: 4,
      paths: { base: 1, perPath: 1 },
    });
  });

  it("rejects a cost table with paths when pathArgs forbids paths", () => {
    const result = validationCommandConfigSchema.safeParse({
      command: {
        full: "scripts/validate/test-full.sh",
        changed: "scripts/validate/test.sh",
      },
      cost: { full: 8, changed: 4, paths: { base: 1, perPath: 1 } },
      pathArgs: "forbid",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ path: ["cost", "paths"] }),
    );
  });

  it("rejects a changed cost weight without a native changed executable", () => {
    const result = validationCommandConfigSchema.safeParse({
      command: { full: "scripts/x-full.sh" },
      cost: { full: 8, changed: 3 },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ path: ["cost", "changed"] }),
    );
  });

  it("accepts a full-only cost table on a command with no changed executable", () => {
    const parsed = validationCommandConfigSchema.parse({
      command: { full: "scripts/x-full.sh" },
      cost: { full: 8 },
    });

    expect(parsed.cost).toEqual({ full: 8 });
  });

  it("rejects path support without a native changed executable", () => {
    const result = validationCommandConfigSchema.safeParse({
      command: { full: "scripts/x-full.sh" },
      cost: 1,
      pathArgs: "paths",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ path: ["pathArgs"] }),
    );
  });
});

describe("validationCommandCostSchema", () => {
  it("parses the scalar form unchanged", () => {
    expect(validationCommandCostSchema.parse(3)).toBe(3);
  });

  it("parses a table with only full", () => {
    expect(validationCommandCostSchema.parse({ full: 8 })).toEqual({ full: 8 });
  });

  it("parses a table with changed and a paths block", () => {
    expect(
      validationCommandCostSchema.parse({
        full: 8,
        changed: 8,
        paths: { base: 2, perPath: 0 },
      }),
    ).toEqual({ full: 8, changed: 8, paths: { base: 2, perPath: 0 } });
  });

  it("rejects a table whose changed exceeds full", () => {
    const result = validationCommandCostSchema.safeParse({
      full: 4,
      changed: 5,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a paths base above the changed ceiling", () => {
    expect(
      validationCommandCostSchema.safeParse({
        full: 8,
        changed: 4,
        paths: { base: 5, perPath: 1 },
      }).success,
    ).toBe(false);
  });

  it("rejects a paths base above full when changed is absent", () => {
    expect(
      validationCommandCostSchema.safeParse({
        full: 4,
        paths: { base: 5, perPath: 1 },
      }).success,
    ).toBe(false);
  });

  it.each([
    [{ full: 0 }],
    [{ full: 1.5 }],
    [{ changed: 1 }],
    [{ full: 4, changed: 0 }],
    [{ full: 4, paths: { base: 0, perPath: 1 } }],
    [{ full: 4, paths: { base: 1, perPath: -1 } }],
    [{ full: 4, paths: { base: 1 } }],
    [{ full: 4, focused: 2 }],
  ])("rejects the malformed table %j", (cost) => {
    expect(validationCommandCostSchema.safeParse(cost).success).toBe(false);
  });

  it("allows a zero perPath as a flat scoped weight", () => {
    expect(
      validationCommandCostSchema.parse({
        full: 8,
        changed: 4,
        paths: { base: 2, perPath: 0 },
      }),
    ).toEqual({ full: 8, changed: 4, paths: { base: 2, perPath: 0 } });
  });
});

describe("repoValidationConfigSchema", () => {
  const commands = {
    lint: { command: { full: "scripts/validate/lint.sh" }, cost: 2 },
    "test-unit": {
      command: {
        full: "scripts/validate/test-full.sh",
        changed: "scripts/validate/test.sh",
      },
      cost: 8,
    },
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
          commands: { [name]: { command: { full: "scripts/x.sh" }, cost: 1 } },
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

  it.each([
    [{ kind: "passed", runId: "run-1", exitCode: 0, output: "ok" }, 0],
    [{ kind: "failed", runId: "run-1", exitCode: 1, output: "boom" }, 3],
  ])("carries the matched-file count on a $0.kind verdict", (result, count) => {
    const withCount = { ...result, filesMatched: count };

    expect(validationRunResultSchema.parse(withCount)).toEqual(withCount);
  });

  it("rejects a negative matched-file count", () => {
    expect(
      validationRunResultSchema.safeParse({
        kind: "passed",
        runId: "run-1",
        exitCode: 0,
        output: "ok",
        filesMatched: -1,
      }).success,
    ).toBe(false);
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
    requestedScope: "changed",
    effectiveScope: "changed",
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
      requestedScope: "changed",
      effectiveScope: "full",
      scopedPathCount: 0,
      exitCode: null,
    };

    expect(validationRunRecordSchema.parse(queued)).toEqual(queued);
  });

  it("accepts null scopes as legacy ledger ambiguity", () => {
    expect(
      validationRunRecordSchema.parse({
        ...record,
        requestedScope: null,
        effectiveScope: null,
      }),
    ).toMatchObject({ requestedScope: null, effectiveScope: null });
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
