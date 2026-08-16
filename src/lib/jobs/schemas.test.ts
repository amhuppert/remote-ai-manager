import { describe, expect, it } from "vitest";
import {
  backgroundJobSchema,
  jobRecordSchema,
  jobStatusEventSchema,
  jobStatusSchema,
} from "./schemas";

describe("jobStatusSchema", () => {
  it.each([
    "running",
    "completed",
    "failed",
    "conflicts",
    "ready-to-land",
    "discarded",
  ])("accepts status %s", (status) => {
    const result = jobStatusSchema.safeParse(status);
    expect(result.success).toBe(true);
  });

  it("rejects unknown status", () => {
    const result = jobStatusSchema.safeParse("squashing");
    expect(result.success).toBe(false);
  });
});

describe("backgroundJobSchema", () => {
  const base = {
    jobId: "job-1",
    jobType: "merge" as const,
    status: "running" as const,
    projectName: "demo",
    sessionName: "feature",
    branchName: "csm/feature",
    startedAt: new Date().toISOString(),
  };

  it("round-trips ready-to-land status with parked-ref fields", () => {
    const job = {
      ...base,
      status: "ready-to-land" as const,
      parkedRef: "refs/cc-merges/job-1",
      preparedSha: "abc123",
      phase: "awaiting-land",
    };
    const parsed = backgroundJobSchema.parse(job);
    expect(parsed.status).toBe("ready-to-land");
    expect(parsed.parkedRef).toBe("refs/cc-merges/job-1");
    expect(parsed.preparedSha).toBe("abc123");
    expect(parsed.phase).toBe("awaiting-land");
  });

  it("round-trips discarded status", () => {
    const job = { ...base, status: "discarded" as const };
    const parsed = backgroundJobSchema.parse(job);
    expect(parsed.status).toBe("discarded");
  });

  it("round-trips refreshWarning field", () => {
    const job = {
      ...base,
      status: "completed" as const,
      mergeHash: "deadbeef",
      refreshWarning: "could not reset worktree",
    };
    const parsed = backgroundJobSchema.parse(job);
    expect(parsed.refreshWarning).toBe("could not reset worktree");
  });

  it("round-trips the progress stamp stale recovery reads", () => {
    const job = { ...base, lastProgressAt: "2026-01-01T00:03:00Z" };
    const parsed = backgroundJobSchema.parse(job);
    expect(parsed.lastProgressAt).toBe("2026-01-01T00:03:00Z");
  });

  it("accepts legacy jobs without new optional fields", () => {
    const job = { ...base };
    const parsed = backgroundJobSchema.parse(job);
    expect(parsed.parkedRef).toBeUndefined();
    expect(parsed.preparedSha).toBeUndefined();
    expect(parsed.refreshWarning).toBeUndefined();
    expect(parsed.lastProgressAt).toBeUndefined();
  });
});

describe("jobRecordSchema", () => {
  const base = {
    jobId: "job-1",
    jobType: "merge" as const,
    status: "completed" as const,
    projectName: "demo",
    sessionName: "feature",
    branchName: "csm/feature",
    startedAt: "2026-01-01T00:00:00Z",
  };

  it("accepts the durable job_records field set", () => {
    const parsed = jobRecordSchema.parse({
      ...base,
      completedAt: "2026-01-01T00:01:00Z",
      mergeHash: "merge-sha",
      commitHash: "commit-sha",
      conflictCount: 2,
      conflictFiles: ["a.ts", "b.ts"],
      errorMessage: "terminal details",
      finalPublish: true,
    });

    expect(parsed).toEqual({
      ...base,
      completedAt: "2026-01-01T00:01:00Z",
      mergeHash: "merge-sha",
      commitHash: "commit-sha",
      conflictCount: 2,
      conflictFiles: ["a.ts", "b.ts"],
      errorMessage: "terminal details",
      finalPublish: true,
    });
  });

  /**
   * A parked candidate outlives the process that prepared it, so the facts a
   * land or discard re-entry needs are durable rather than live-only.
   */
  it("accepts the parked-merge bookkeeping a land re-entry reconstructs from", () => {
    const parsed = jobRecordSchema.parse({
      ...base,
      status: "ready-to-land" as const,
      parkedRef: "refs/cc-merges/job-1",
      preparedSha: "abc123",
      expectedTargetSha: "def456",
      finalizeSessionOnPublish: false,
      resolutionContext: "kept the session's rename",
    });

    expect(parsed).toMatchObject({
      parkedRef: "refs/cc-merges/job-1",
      preparedSha: "abc123",
      expectedTargetSha: "def456",
      finalizeSessionOnPublish: false,
      resolutionContext: "kept the session's rename",
    });
  });

  it.each([
    ["targetBranch", "main"],
    ["phase", "awaiting-land"],
    ["refreshWarning", "target worktree could not be refreshed"],
    ["lastProgressAt", "2026-01-01T00:03:00Z"],
    ["upToDate", true],
    ["intentSource", "graph-join"],
  ])("rejects live-only field %s", (field, value) => {
    const result = jobRecordSchema.safeParse({ ...base, [field]: value });

    expect(result.success).toBe(false);
  });
});

describe("jobStatusEventSchema", () => {
  const base = {
    type: "job-status" as const,
    jobType: "merge" as const,
    status: "running" as const,
    projectName: "demo",
    sessionName: "feature",
    jobId: "job-1",
    branchName: "csm/feature",
  };

  it("round-trips ready-to-land event with parked-ref fields", () => {
    const event = {
      ...base,
      status: "ready-to-land" as const,
      parkedRef: "refs/cc-merges/job-1",
      preparedSha: "abc123",
      phase: "awaiting-land",
    };
    const parsed = jobStatusEventSchema.parse(event);
    expect(parsed.status).toBe("ready-to-land");
    expect(parsed.parkedRef).toBe("refs/cc-merges/job-1");
    expect(parsed.preparedSha).toBe("abc123");
  });

  // The frame is parsed against this schema on the client, so a field the
  // broadcaster stamps but the schema omits is a dropped event, not a degraded
  // one (the `_sentAt` incident).
  it("round-trips the dispatching surface stamped on a merge job", () => {
    const parsed = jobStatusEventSchema.parse({
      ...base,
      intentSource: "graph-join",
    });

    expect(parsed.intentSource).toBe("graph-join");
  });

  it("round-trips discarded event", () => {
    const event = { ...base, status: "discarded" as const };
    const parsed = jobStatusEventSchema.parse(event);
    expect(parsed.status).toBe("discarded");
  });

  it("round-trips refreshWarning on event", () => {
    const event = {
      ...base,
      status: "completed" as const,
      mergeHash: "deadbeef",
      refreshWarning: "worktree refresh failed",
    };
    const parsed = jobStatusEventSchema.parse(event);
    expect(parsed.refreshWarning).toBe("worktree refresh failed");
  });

  it("round-trips a typed delivery-gate halt reason", () => {
    const haltReason = {
      type: "delivery_gate_failed" as const,
      unmet: [
        {
          criterionId: "criterion-1",
          criterionHandle: "native-sdd/R18.4",
          outcome: "unmet",
          reason: "candidate proof is stale",
        },
      ],
      instruction: "Re-dispatch the merge to validate the candidate again.",
    };
    const parsed = jobStatusEventSchema.parse({
      ...base,
      status: "failed",
      haltReason,
    });

    // Rows persisted before the approval presentation existed carry neither
    // refusalCode nor spec — they must keep parsing unchanged.
    expect(parsed.haltReason).toEqual(haltReason);
  });

  it("round-trips the delivery-gate approval presentation fields", () => {
    const haltReason = {
      type: "delivery_gate_failed" as const,
      unmet: [
        {
          criterionId: "spec-execution-1:gate:1",
          criterionHandle: "audit-log",
          outcome: "gate_blocked",
          reason: "The delivery gate requires human approval.",
        },
      ],
      instruction: "Approve delivery in Spec Studio, then resume the merge.",
      refusalCode: "approval_required" as const,
      spec: {
        specSlug: "audit-log",
        specName: "Audit Log",
        projectName: "command-center",
      },
    };

    const parsed = jobStatusEventSchema.parse({
      ...base,
      status: "failed",
      haltReason,
    });

    expect(parsed.haltReason).toEqual(haltReason);
  });

  it("round-trips a resolution-infrastructure halt reason", () => {
    const haltReason = {
      type: "resolution_infrastructure" as const,
      failure: {
        kind: "quota_exhausted" as const,
        message:
          "You've hit your usage limit. Try again at Aug 19th, 2026 11:29 PM.",
        retryable: false,
        retryAfterHint: "Aug 19th, 2026 11:29 PM",
      },
      conflictFiles: ["src/lib/specs/execution-binding-service.ts"],
    };

    const parsed = jobStatusEventSchema.parse({
      ...base,
      status: "failed",
      haltReason,
    });

    expect(parsed.haltReason).toEqual(haltReason);
  });

  it.each([
    "preparing",
    "publishing",
    "awaiting-land",
    "validating",
    "merging-main",
  ])("round-trips phase value %s", (phase) => {
    const event = { ...base, phase };
    const parsed = jobStatusEventSchema.parse(event);
    expect(parsed.phase).toBe(phase);
  });

  it("round-trips the no-op merge flag, which the strict envelope would otherwise drop", () => {
    const parsed = jobStatusEventSchema.parse({
      ...base,
      status: "completed" as const,
      upToDate: true,
    });

    expect(parsed.upToDate).toBe(true);
    expect(parsed.mergeHash).toBeUndefined();
  });

  it("round-trips the progress stamp", () => {
    const parsed = jobStatusEventSchema.parse({
      ...base,
      lastProgressAt: "2026-01-01T00:03:00Z",
    });

    expect(parsed.lastProgressAt).toBe("2026-01-01T00:03:00Z");
  });

  it("accepts legacy events without new optional fields", () => {
    const parsed = jobStatusEventSchema.parse(base);
    expect(parsed.parkedRef).toBeUndefined();
    expect(parsed.preparedSha).toBeUndefined();
    expect(parsed.refreshWarning).toBeUndefined();
    expect(parsed.haltReason).toBeUndefined();
    expect(parsed.lastProgressAt).toBeUndefined();
  });
});
