import { describe, expect, it } from "vitest";
import {
  backgroundJobSchema,
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

  it("accepts legacy jobs without new optional fields", () => {
    const job = { ...base };
    const parsed = backgroundJobSchema.parse(job);
    expect(parsed.parkedRef).toBeUndefined();
    expect(parsed.preparedSha).toBeUndefined();
    expect(parsed.refreshWarning).toBeUndefined();
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

  it("accepts legacy events without new optional fields", () => {
    const parsed = jobStatusEventSchema.parse(base);
    expect(parsed.parkedRef).toBeUndefined();
    expect(parsed.preparedSha).toBeUndefined();
    expect(parsed.refreshWarning).toBeUndefined();
  });
});
