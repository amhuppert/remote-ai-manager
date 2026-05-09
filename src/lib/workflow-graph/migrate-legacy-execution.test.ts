import { describe, expect, it } from "vitest";
import {
  LegacyExecutionMigrationError,
  migrateLegacyExecution,
  needsLegacyMigration,
} from "./migrate-legacy-execution";

function legacyRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "exec-1",
    seedDefinitionId: "wf-1",
    seedDefinitionRevision: 1,
    workingDefinition: {},
    status: "in-progress",
    activeContextId: "ctx-running",
    contextStates: {},
    taskStates: {},
    sharedDocuments: [],
    history: [],
    startedAt: "2026-04-04T00:00:00.000Z",
    ...overrides,
  };
}

function newSchemaRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "exec-2",
    seedDefinitionId: "wf-1",
    seedDefinitionRevision: 1,
    workingDefinition: {},
    status: "in-progress",
    activeContextIds: ["ctx-running"],
    contextStates: {},
    taskStates: {},
    sharedDocuments: [],
    history: [],
    startedAt: "2026-04-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("needsLegacyMigration", () => {
  it("returns true when raw record contains the legacy activeContextId field", () => {
    expect(needsLegacyMigration(legacyRecord())).toBe(true);
  });

  it("returns false for new-schema records with a legitimately running context (stale-running recovery is normalizeAfterRestart's job, not the persistence layer's)", () => {
    expect(
      needsLegacyMigration(
        newSchemaRecord({
          contextStates: {
            "ctx-a": { contextId: "ctx-a", status: "running" },
          },
        }),
      ),
    ).toBe(false);
  });

  it("returns false for clean new-schema records", () => {
    expect(
      needsLegacyMigration(
        newSchemaRecord({
          activeContextIds: [],
          status: "paused",
          contextStates: {
            "ctx-a": { contextId: "ctx-a", status: "ready" },
          },
        }),
      ),
    ).toBe(false);
  });

  it("returns false for non-object inputs", () => {
    expect(needsLegacyMigration(null)).toBe(false);
    expect(needsLegacyMigration("string")).toBe(false);
    expect(needsLegacyMigration([])).toBe(false);
  });
});

describe("migrateLegacyExecution", () => {
  it("legacy field + running: removes activeContextId, sets status=paused, activeContextIds=[], resets running→ready, preserves worktreePath/branchName", () => {
    const result = migrateLegacyExecution(
      legacyRecord({
        status: "in-progress",
        activeContextId: "ctx-a",
        contextStates: {
          "ctx-a": {
            contextId: "ctx-a",
            status: "running",
            worktreePath: "/wt/sub",
            branchName: "csm/feature",
            isolation: "worktree",
          },
          "ctx-b": {
            contextId: "ctx-b",
            status: "completed",
          },
        },
      }),
    );

    const upgraded = result.upgradedRecord;
    expect("activeContextId" in upgraded).toBe(false);
    expect(upgraded.status).toBe("paused");
    expect(upgraded.activeContextIds).toEqual([]);
    const ctxA = (upgraded.contextStates as Record<string, unknown>)[
      "ctx-a"
    ] as Record<string, unknown> | undefined;
    expect(ctxA?.status).toBe("ready");
    expect(ctxA?.worktreePath).toBe("/wt/sub");
    expect(ctxA?.branchName).toBe("csm/feature");
    expect(ctxA?.isolation).toBe("worktree");
    const ctxB = (upgraded.contextStates as Record<string, unknown>)["ctx-b"];
    expect(ctxB).toEqual({ contextId: "ctx-b", status: "completed" });

    expect(result.executionId).toBe("exec-1");
    expect(result.repairedFields).toContain("activeContextId");
    expect(result.repairedFields).toContain("status");
    expect(result.repairedFields).toContain("activeContextIds");
    expect(result.repairedFields).toContain("contextStates.running");
  });

  it("legacy field + no running: removes activeContextId, sets status=paused, activeContextIds=[], leaves contextStates untouched", () => {
    const result = migrateLegacyExecution(
      legacyRecord({
        status: "in-progress",
        activeContextId: "ctx-a",
        contextStates: {
          "ctx-a": { contextId: "ctx-a", status: "ready" },
        },
      }),
    );

    const upgraded = result.upgradedRecord;
    expect("activeContextId" in upgraded).toBe(false);
    expect(upgraded.status).toBe("paused");
    expect(upgraded.activeContextIds).toEqual([]);
    expect(upgraded.contextStates).toEqual({
      "ctx-a": { contextId: "ctx-a", status: "ready" },
    });
    expect(result.repairedFields).toContain("activeContextId");
    expect(result.repairedFields).not.toContain("contextStates.running");
  });

  it("no legacy field + interrupted running: status=paused, activeContextIds=[], resets running→ready", () => {
    const result = migrateLegacyExecution(
      newSchemaRecord({
        status: "in-progress",
        activeContextIds: ["ctx-a"],
        contextStates: {
          "ctx-a": {
            contextId: "ctx-a",
            status: "running",
            worktreePath: "/wt/sub",
            branchName: "csm/feature",
          },
        },
      }),
    );

    const upgraded = result.upgradedRecord;
    expect("activeContextId" in upgraded).toBe(false);
    expect(upgraded.status).toBe("paused");
    expect(upgraded.activeContextIds).toEqual([]);
    const ctxA = (upgraded.contextStates as Record<string, unknown>)[
      "ctx-a"
    ] as Record<string, unknown> | undefined;
    expect(ctxA?.status).toBe("ready");
    expect(ctxA?.worktreePath).toBe("/wt/sub");
    expect(ctxA?.branchName).toBe("csm/feature");
    expect(result.repairedFields).not.toContain("activeContextId");
    expect(result.repairedFields).toContain("contextStates.running");
  });

  it("no legacy field + no running: idempotent — no repaired fields when status and activeContextIds are already aligned", () => {
    const input = newSchemaRecord({
      status: "paused",
      activeContextIds: [],
      contextStates: {
        "ctx-a": { contextId: "ctx-a", status: "ready" },
      },
    });
    const result = migrateLegacyExecution(input);

    expect(result.upgradedRecord.status).toBe("paused");
    expect(result.upgradedRecord.activeContextIds).toEqual([]);
    expect(result.upgradedRecord.contextStates).toEqual({
      "ctx-a": { contextId: "ctx-a", status: "ready" },
    });
    expect(result.repairedFields).toEqual([]);
  });

  it("does not mutate the input record", () => {
    const input = legacyRecord({
      activeContextId: "ctx-a",
      contextStates: {
        "ctx-a": { contextId: "ctx-a", status: "running" },
      },
    });
    const snapshot = JSON.parse(JSON.stringify(input));
    migrateLegacyExecution(input);
    expect(input).toEqual(snapshot);
  });

  it("throws LegacyExecutionMigrationError for malformed (non-object) records", () => {
    expect(() => migrateLegacyExecution(null)).toThrow(
      LegacyExecutionMigrationError,
    );
    expect(() => migrateLegacyExecution("legacy")).toThrow(
      LegacyExecutionMigrationError,
    );
    expect(() => migrateLegacyExecution([1, 2, 3])).toThrow(
      LegacyExecutionMigrationError,
    );
    expect(() => migrateLegacyExecution(42)).toThrow(
      LegacyExecutionMigrationError,
    );
  });

  it("legacy-field detection runs on the raw object before any safeParse strips unknown keys", () => {
    const rawLegacy = legacyRecord({
      activeContextId: "ctx-z",
      status: "in-progress",
    });
    expect(needsLegacyMigration(rawLegacy)).toBe(true);

    const result = migrateLegacyExecution(rawLegacy);
    expect("activeContextId" in result.upgradedRecord).toBe(false);
    expect(result.repairedFields).toContain("activeContextId");
  });

  it("flat laneStates: groups entries by contextId into nested Record<contextId, Record<lane, LaneState>>", () => {
    const claudeImplementer = {
      contextId: "ctx-X",
      engine: "claude",
      lane: "implementer",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-1",
      },
      lastContextTokens: 100,
      lastContextWindowMax: 200000,
      rotateBeforeNextTurn: false,
      limitEvaluation: "supported",
      lastUsedAt: "2026-05-08T09:54:42.829Z",
    };
    const codexValidator = {
      contextId: "ctx-X",
      engine: "codex",
      lane: "context_validator",
      sessionRef: {
        engine: "codex",
        lane: "context_validator",
        threadId: "thread-1",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: "2026-05-08T09:57:14.649Z",
    };

    const result = migrateLegacyExecution(
      legacyRecord({
        laneStates: {
          implementer: claudeImplementer,
          context_validator: codexValidator,
        },
      }),
    );

    expect(result.upgradedRecord.laneStates).toEqual({
      "ctx-X": {
        implementer: claudeImplementer,
        context_validator: codexValidator,
      },
    });
    expect(result.repairedFields).toContain("laneStates");
  });

  it("flat laneStates with multiple contextIds: groups each lane under its own contextId", () => {
    const laneA = {
      contextId: "ctx-A",
      engine: "claude",
      lane: "implementer",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-A",
      },
      rotateBeforeNextTurn: false,
      limitEvaluation: "supported",
      lastUsedAt: "2026-05-08T00:00:00.000Z",
    };
    const laneB = {
      contextId: "ctx-B",
      engine: "claude",
      lane: "implementer",
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-B",
      },
      rotateBeforeNextTurn: false,
      limitEvaluation: "supported",
      lastUsedAt: "2026-05-08T00:00:00.000Z",
    };

    const result = migrateLegacyExecution(
      newSchemaRecord({
        laneStates: { implementer: laneA, "implementer-2": laneB },
      }),
    );

    expect(result.upgradedRecord.laneStates).toEqual({
      "ctx-A": { implementer: laneA },
      "ctx-B": { "implementer-2": laneB },
    });
    expect(result.repairedFields).toContain("laneStates");
  });

  it("nested laneStates: leaves already-migrated shape untouched", () => {
    const nested = {
      "ctx-A": {
        implementer: {
          contextId: "ctx-A",
          engine: "claude",
          lane: "implementer",
          sessionRef: {
            engine: "claude",
            lane: "implementer",
            conversationId: "conv-A",
          },
          rotateBeforeNextTurn: false,
          limitEvaluation: "supported",
          lastUsedAt: "2026-05-08T00:00:00.000Z",
        },
      },
    };
    const result = migrateLegacyExecution(
      newSchemaRecord({ laneStates: nested }),
    );

    expect(result.upgradedRecord.laneStates).toEqual(nested);
    expect(result.repairedFields).not.toContain("laneStates");
  });

  it("needsLegacyMigration: returns true for flat laneStates even without activeContextId", () => {
    expect(
      needsLegacyMigration(
        newSchemaRecord({
          laneStates: {
            implementer: {
              contextId: "ctx-A",
              engine: "claude",
              lane: "implementer",
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("needsLegacyMigration: returns false for empty laneStates", () => {
    expect(needsLegacyMigration(newSchemaRecord({ laneStates: {} }))).toBe(
      false,
    );
  });
});
