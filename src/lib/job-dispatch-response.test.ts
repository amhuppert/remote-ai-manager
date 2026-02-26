import { describe, it, expect } from "vitest";
import { jobDispatchResponseSchema } from "./schemas";

describe("jobDispatchResponseSchema", () => {
  it("accepts a valid response", () => {
    const result = jobDispatchResponseSchema.safeParse({
      jobId: "abc-123",
      jobType: "merge",
      branchName: "csm/my-session",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.jobId).toBe("abc-123");
      expect(result.data.jobType).toBe("merge");
      expect(result.data.branchName).toBe("csm/my-session");
      expect(result.data.startedAt).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  it("accepts all job types", () => {
    for (const jobType of ["commit", "merge", "resolve-conflicts"]) {
      const result = jobDispatchResponseSchema.safeParse({
        jobId: "id",
        jobType,
        branchName: "csm/test",
        startedAt: new Date().toISOString(),
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects missing required fields", () => {
    expect(jobDispatchResponseSchema.safeParse({}).success).toBe(false);
    expect(jobDispatchResponseSchema.safeParse({ jobId: "id" }).success).toBe(
      false,
    );
    expect(
      jobDispatchResponseSchema.safeParse({ jobId: "id", jobType: "merge" })
        .success,
    ).toBe(false);
  });
});
