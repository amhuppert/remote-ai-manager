import { expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createJobsRepo } from "./repo";

it("retains skipped completion bookkeeping when a parked merge is read after restart", () => {
  const fixture = createPersistenceFixture();
  try {
    const repo = createJobsRepo(fixture.db);
    repo.createJobRecord({
      jobId: "skip-marking",
      jobType: "merge",
      status: "running",
      projectName: "p",
      sessionName: "s",
      branchName: "csm/s",
      startedAt: "2026-09-13T00:00:00Z",
      finalizeSessionOnPublish: true,
      skipMarkMerged: true,
    });
    repo.updateJobRecord("skip-marking", {
      status: "ready-to-land",
      parkedRef: "refs/cc-merges/skip-marking",
      preparedSha: "prepared",
      expectedTargetSha: "target",
    });
    expect(
      createJobsRepo(fixture.db).getJobRecord("skip-marking"),
    ).toMatchObject({
      status: "ready-to-land",
      finalizeSessionOnPublish: true,
      skipMarkMerged: true,
    });
  } finally {
    fixture.close();
  }
});
