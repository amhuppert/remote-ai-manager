import { spawnSync } from "node:child_process";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createJobsRepo,
  deriveNotificationType,
  deriveNotificationTitle,
  type JobsRepo,
} from "./repo";
import { createNotificationsRepo } from "../notifications/repo";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting,
  getDb as getSharedStateDb,
} from "../state-store/state-db";
import { jobRecordSchema } from "./schemas";
import { PersistenceError } from "../shared/errors";

vi.mock("../push-notification/dispatcher");

let repo: JobsRepo;

function installFreshTestDb() {
  const db = _createTestDb({ inMemory: true });
  _installTestDb(db);
  repo = createJobsRepo(db);
}

beforeEach(() => {
  installFreshTestDb();
});

afterEach(() => {
  _resetForTesting();
});

describe("getJobRecord — production parse skip", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function insertRawJobRow(status: string): void {
    getSharedStateDb()
      .prepare(
        `INSERT INTO job_records (job_id, job_type, status, project_name, session_name, branch_name, started_at)
         VALUES (?, 'merge', ?, 'p', 's', 'csm/s', '2026-01-01T00:00:00Z')`,
      )
      .run("job-x", status);
  }

  it("throws on a schema-violating row outside production", () => {
    insertRawJobRow("bogus-status");
    expect(() => repo.getJobRecord("job-x")).toThrow(PersistenceError);
  });

  it("returns the row as-is without validating in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    insertRawJobRow("bogus-status");
    const job = repo.getJobRecord("job-x");
    expect(job).not.toBeNull();
    if (job) expect(job.status as string).toBe("bogus-status");
  });
});

describe("createJobRecord", () => {
  it("inserts a running job record", () => {
    repo.createJobRecord({
      jobId: "job-1",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: new Date().toISOString(),
    });

    const db = getSharedStateDb();
    const row = db
      .prepare("SELECT status FROM job_records WHERE job_id = ?")
      .get("job-1") as { status: string };
    expect(row.status).toBe("running");
  });
});

describe("updateJobRecord", () => {
  it("updates a job record to terminal state", () => {
    repo.createJobRecord({
      jobId: "job-1",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: new Date().toISOString(),
    });

    repo.updateJobRecord("job-1", {
      status: "completed",
      mergeHash: "abc123",
    });

    const recovered = repo.recoverStaleJobs();
    expect(recovered).toBe(0);
  });
});

describe("getJobRecord", () => {
  it("reads back every durable field including the generated completedAt", () => {
    repo.createJobRecord({
      jobId: "job-1",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: "2026-06-09 12:00:00",
    });
    repo.updateJobRecord("job-1", {
      status: "completed",
      mergeHash: "abc123",
      commitHash: "def456",
      conflictCount: 2,
      conflictFiles: ["a.ts", "b.ts"],
      errorMessage: "none",
    });

    const record = repo.getJobRecord("job-1");

    expect(record).not.toBeNull();
    expect(record!.jobId).toBe("job-1");
    expect(record!.jobType).toBe("merge");
    expect(record!.status).toBe("completed");
    expect(record!.projectName).toBe("my-project");
    expect(record!.sessionName).toBe("feature");
    expect(record!.branchName).toBe("csm/feature");
    expect(record!.startedAt).toBe("2026-06-09 12:00:00");
    expect(record!.mergeHash).toBe("abc123");
    expect(record!.commitHash).toBe("def456");
    expect(record!.conflictCount).toBe(2);
    expect(record!.conflictFiles).toEqual(["a.ts", "b.ts"]);
    expect(record!.errorMessage).toBe("none");
    expect(typeof record!.completedAt).toBe("string");
  });

  it("returns a JobRecord with no live-only keys that validates against jobRecordSchema", () => {
    repo.createJobRecord({
      jobId: "job-1",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: "2026-06-09 12:00:00",
    });
    repo.updateJobRecord("job-1", { status: "completed" });

    const record = repo.getJobRecord("job-1");

    expect(record).not.toBeNull();
    expect(() => jobRecordSchema.parse(record)).not.toThrow();
    const keys = Object.keys(record!);
    expect(keys).not.toContain("targetBranch");
    expect(keys).not.toContain("phase");
  });

  it("returns null for an unknown id", () => {
    expect(repo.getJobRecord("does-not-exist")).toBeNull();
  });
});

/**
 * A parked merge outlives the process that prepared it: after a restart the job
 * registry is empty, so the durable row is the only thing that still knows a
 * commit is waiting under `refs/cc-merges/` and what landing it would need.
 */
describe("findLatestJobRecordForSession and listParkedJobRecords", () => {
  function parkJob(
    jobId: string,
    overrides: {
      sessionName?: string;
      preparedSha?: string;
      finalizeSessionOnPublish?: boolean;
      resolutionContext?: string;
    } = {},
  ): void {
    repo.createJobRecord({
      jobId,
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: overrides.sessionName ?? "feature",
      branchName: "csm/feature",
      startedAt: "2026-06-09 12:00:00",
      ...(overrides.finalizeSessionOnPublish !== undefined
        ? { finalizeSessionOnPublish: overrides.finalizeSessionOnPublish }
        : {}),
      ...(overrides.resolutionContext !== undefined
        ? { resolutionContext: overrides.resolutionContext }
        : {}),
    });
    repo.updateJobRecord(jobId, {
      status: "ready-to-land",
      parkedRef: `refs/cc-merges/${jobId}`,
      preparedSha: overrides.preparedSha ?? `${jobId}-prepared`,
      expectedTargetSha: "target-sha",
    });
  }

  it("reconstructs the parked merge's bookkeeping for the session", () => {
    parkJob("job-parked", {
      finalizeSessionOnPublish: false,
      resolutionContext: "kept the session's rename",
    });

    const record = repo.findLatestJobRecordForSession("my-project", "feature");

    expect(record).toMatchObject({
      jobId: "job-parked",
      status: "ready-to-land",
      parkedRef: "refs/cc-merges/job-parked",
      preparedSha: "job-parked-prepared",
      expectedTargetSha: "target-sha",
      finalizeSessionOnPublish: false,
      resolutionContext: "kept the session's rename",
    });
  });

  it("returns the most recent parked merge when the session parked more than once", () => {
    parkJob("job-parked-old");
    parkJob("job-parked-new");

    expect(
      repo.findLatestJobRecordForSession("my-project", "feature")?.jobId,
    ).toBe("job-parked-new");
  });

  it("ignores other sessions", () => {
    parkJob("job-other-session", { sessionName: "other" });

    expect(
      repo.findLatestJobRecordForSession("my-project", "feature"),
    ).toBeNull();
  });

  /**
   * A land or discard runs as its own job for the session, so the candidate's
   * row stops being the latest the moment it is acted on. Answering with it
   * again would offer a merge that has already been landed or dropped.
   */
  it("answers with the job that took the session from a parked candidate", () => {
    parkJob("job-parked");
    repo.createJobRecord({
      jobId: "job-land",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: "2026-06-09 12:00:00",
    });
    repo.updateJobRecord("job-land", {
      status: "completed",
      mergeHash: "landed-sha",
    });

    expect(
      repo.findLatestJobRecordForSession("my-project", "feature"),
    ).toMatchObject({ jobId: "job-land", status: "completed" });
  });

  it("lists every parked candidate row the session still has on offer", () => {
    parkJob("job-parked-old");
    parkJob("job-parked-new");
    parkJob("job-other-session", { sessionName: "other" });
    parkJob("job-landed");
    repo.updateJobRecord("job-landed", {
      status: "completed",
      mergeHash: "landed-sha",
    });

    expect(
      repo
        .listParkedJobRecords("my-project", "feature")
        .map((record) => record.jobId),
    ).toEqual(["job-parked-new", "job-parked-old"]);
  });
});

/**
 * Startup GC input: which job ids may still own a `refs/cc-merges/` ref. A
 * `running` row survives the sweep only when its owner process is alive, so it
 * may be a merge mid-prepare in another worker sharing this database.
 */
describe("listJobIdsHoldingParkedRefs", () => {
  it("reports parked and in-flight jobs, not finished ones", () => {
    for (const [jobId, status] of [
      ["job-parked", "ready-to-land"],
      ["job-discarded", "discarded"],
      ["job-landed", "completed"],
    ] as const) {
      repo.createJobRecord({
        jobId,
        jobType: "merge",
        status: "running",
        projectName: "my-project",
        sessionName: "feature",
        branchName: "csm/feature",
        startedAt: "2026-06-09 12:00:00",
      });
      repo.updateJobRecord(jobId, { status });
    }
    repo.createJobRecord({
      jobId: "job-running",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "other",
      branchName: "csm/other",
      startedAt: "2026-06-09 12:00:00",
    });

    expect(new Set(repo.listJobIdsHoldingParkedRefs())).toEqual(
      new Set(["job-parked", "job-running"]),
    );
  });
});

describe("findLatestPublishedMergeByExecutionId", () => {
  it("ignores completed linked merges that do not close a final publish join", () => {
    repo.createJobRecord({
      jobId: "merge-intermediate",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: "2026-06-09 12:00:00",
      executionId: "workflow-execution-1",
    });
    repo.updateJobRecord("merge-intermediate", {
      status: "completed",
      mergeHash: "sha-intermediate",
    });

    expect(
      repo.findLatestPublishedMergeByExecutionId("workflow-execution-1"),
    ).toBeNull();
  });

  it("returns only the latest completed merge for the linked workflow execution", () => {
    for (const [jobId, mergeHash] of [
      ["merge-1", "sha-1"],
      ["merge-2", "sha-2"],
    ] as const) {
      repo.createJobRecord({
        jobId,
        jobType: "merge",
        status: "running",
        projectName: "my-project",
        sessionName: "feature",
        branchName: "csm/feature",
        startedAt: "2026-06-09 12:00:00",
        executionId: "workflow-execution-1",
        finalPublish: true,
      });
      repo.updateJobRecord(jobId, {
        status: "completed",
        mergeHash,
      });
    }
    getSharedStateDb()
      .prepare("UPDATE job_records SET completed_at = ? WHERE job_id = ?")
      .run("2026-06-09 12:01:00", "merge-1");
    getSharedStateDb()
      .prepare("UPDATE job_records SET completed_at = ? WHERE job_id = ?")
      .run("2026-06-09 12:02:00", "merge-2");

    expect(
      repo.findLatestPublishedMergeByExecutionId("workflow-execution-1"),
    ).toEqual({ mergeHash: "sha-2", deliveryGatePassed: true });
    expect(
      repo.findLatestPublishedMergeByExecutionId("unlinked-execution"),
    ).toBeNull();
  });

  it("counts a completed final-publish conflict-resolution retry as the published merge", () => {
    repo.createJobRecord({
      jobId: "retry-final",
      jobType: "resolve-conflicts",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: "2026-06-09 12:00:00",
      executionId: "workflow-execution-1",
      finalPublish: true,
    });
    repo.updateJobRecord("retry-final", {
      status: "completed",
      mergeHash: "sha-retry",
    });

    expect(
      repo.findLatestPublishedMergeByExecutionId("workflow-execution-1"),
    ).toEqual({ mergeHash: "sha-retry", deliveryGatePassed: true });
  });

  /**
   * A final publish that found the target already containing the branch landed
   * no commit, so the row carries no merge hash — but the work reached the
   * target, and the reconciliation read is the only thing left to say so after
   * a crash between the job's terminal and its Delivered marking.
   */
  it("reconciles a completed final publish that had nothing to land", () => {
    repo.createJobRecord({
      jobId: "merge-no-op",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: "2026-06-09 12:00:00",
      executionId: "workflow-execution-noop",
      finalPublish: true,
    });
    repo.updateJobRecord("merge-no-op", {
      status: "completed",
      expectedTargetSha: "target-tip-sha",
    });

    expect(
      repo.findLatestPublishedMergeByExecutionId("workflow-execution-noop"),
    ).toEqual({ mergeHash: "target-tip-sha", deliveryGatePassed: true });
  });

  it("ignores failed and ready-to-land jobs", () => {
    repo.createJobRecord({
      jobId: "parked",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: "2026-06-09 12:00:00",
      executionId: "workflow-execution-1",
      finalPublish: true,
    });
    repo.updateJobRecord("parked", {
      status: "ready-to-land",
      mergeHash: "not-published",
    });

    expect(
      repo.findLatestPublishedMergeByExecutionId("workflow-execution-1"),
    ).toBeNull();
  });
});

describe("findMergeValidationByExecutionIdAndRef", () => {
  it("resolves the durable candidate validation fact produced by the linked job", () => {
    const validation = {
      validationRef: "validation-1",
      validatedSha: "candidate-a",
      validatedTreeHash: "tree-a",
      commandIdentity: "bun:test",
      outcome: "pass" as const,
    };
    repo.createJobRecord({
      jobId: "merge-validation-job",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: "2026-06-09 12:00:00",
      executionId: "workflow-execution-1",
      candidateValidation: validation,
    });

    expect(
      repo.findMergeValidationByExecutionIdAndRef(
        "workflow-execution-1",
        "validation-1",
      ),
    ).toEqual({ mergeJobId: "merge-validation-job", validation });
    expect(
      repo.findMergeValidationByExecutionIdAndRef(
        "workflow-execution-1",
        "validation-other",
      ),
    ).toBeNull();
  });
});

describe("recoverStaleJobs", () => {
  /**
   * A real pid whose process has already exited: spawn a trivial child
   * synchronously so by the time this returns the pid is guaranteed dead
   * (`process.kill(pid, 0)` raises ESRCH).
   */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ["-e", "0"]);
    if (typeof child.pid !== "number") {
      throw new Error("failed to spawn a child process for a dead pid");
    }
    return child.pid;
  }

  /** Reassign a row's owner to a process that no longer exists. */
  function orphanJob(jobId: string): void {
    getSharedStateDb()
      .prepare("UPDATE job_records SET owner_pid = ? WHERE job_id = ?")
      .run(deadPid(), jobId);
  }

  it("marks dead-owner running jobs as failed and creates failure notifications", () => {
    repo.createJobRecord({
      jobId: "stale-1",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: new Date().toISOString(),
    });
    orphanJob("stale-1");

    repo.createJobRecord({
      jobId: "stale-2",
      jobType: "commit",
      status: "running",
      projectName: "my-project",
      sessionName: "another",
      branchName: "csm/another",
      startedAt: new Date().toISOString(),
    });
    orphanJob("stale-2");

    const recovered = repo.recoverStaleJobs();

    expect(recovered).toBe(2);
    const result =
      createNotificationsRepo(getSharedStateDb()).getNotifications();
    expect(result.notifications).toHaveLength(2);
    expect(
      result.notifications.every(
        (notification) =>
          notification.source === "job" && notification.errorMessage,
      ),
    ).toBe(true);
  });

  it("spares another live worker's running job while sweeping dead-owner and legacy rows", () => {
    // Worker A (this very process, provably alive) owns a live running job in
    // the shared file-backed DB — createJobRecord stamps the inserting pid.
    repo.createJobRecord({
      jobId: "live-worker-job",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "live",
      branchName: "csm/live",
      startedAt: new Date().toISOString(),
    });

    // A job owned by a worker process that has since exited.
    repo.createJobRecord({
      jobId: "dead-worker-job",
      jobType: "commit",
      status: "running",
      projectName: "my-project",
      sessionName: "dead",
      branchName: "csm/dead",
      startedAt: new Date().toISOString(),
    });
    orphanJob("dead-worker-job");

    // A row written by a build that predates the owner_pid column.
    getSharedStateDb()
      .prepare(
        `INSERT INTO job_records (job_id, job_type, status, project_name, session_name, branch_name, started_at)
         VALUES (?, 'merge', 'running', 'my-project', 'legacy', 'csm/legacy', ?)`,
      )
      .run("legacy-job", new Date().toISOString());

    // Worker B starting up against the same DB runs its sweep.
    const recovered = repo.recoverStaleJobs();

    expect(recovered).toBe(2);
    expect(repo.getJobRecord("live-worker-job")?.status).toBe("running");
    expect(repo.getJobRecord("dead-worker-job")?.status).toBe("failed");
    expect(repo.getJobRecord("legacy-job")?.status).toBe("failed");
  });

  it("creates no notification and returns zero when another worker wins the conditional update", () => {
    repo.createJobRecord({
      jobId: "contended-job",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "contended",
      branchName: "csm/contended",
      startedAt: new Date().toISOString(),
    });
    orphanJob("contended-job");

    getSharedStateDb().exec(`
      CREATE TRIGGER simulate_competing_stale_job_recovery
      BEFORE UPDATE OF status ON job_records
      WHEN OLD.job_id = 'contended-job'
        AND OLD.status = 'running'
        AND NEW.status = 'failed'
      BEGIN
        UPDATE job_records
           SET status = 'failed',
               completed_at = datetime('now'),
               error_message = 'recovered by another worker'
         WHERE job_id = OLD.job_id;
        SELECT RAISE(IGNORE);
      END;
    `);

    const recovered = repo.recoverStaleJobs();

    expect(recovered).toBe(0);
    expect(repo.getJobRecord("contended-job")?.errorMessage).toBe(
      "recovered by another worker",
    );
    expect(
      createNotificationsRepo(getSharedStateDb()).getNotifications()
        .notifications,
    ).toEqual([]);
  });

  it("does not affect completed jobs", () => {
    repo.createJobRecord({
      jobId: "completed-1",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: new Date().toISOString(),
    });
    repo.updateJobRecord("completed-1", {
      status: "completed",
      mergeHash: "abc",
    });

    const recovered = repo.recoverStaleJobs();
    expect(recovered).toBe(0);
  });

  it("returns 0 when no stale jobs exist", () => {
    const recovered = repo.recoverStaleJobs();
    expect(recovered).toBe(0);
  });
});

describe("deleteJobRecordsForSession", () => {
  it("removes only job_records matching the project+session pair", () => {
    repo.createJobRecord({
      jobId: "keep-1",
      jobType: "merge",
      status: "completed",
      projectName: "proj-a",
      sessionName: "keep",
      branchName: "csm/keep",
      startedAt: new Date().toISOString(),
    });
    repo.createJobRecord({
      jobId: "doomed-1",
      jobType: "merge",
      status: "completed",
      projectName: "proj-a",
      sessionName: "doomed",
      branchName: "csm/doomed",
      startedAt: new Date().toISOString(),
    });
    repo.createJobRecord({
      jobId: "doomed-2",
      jobType: "commit",
      status: "completed",
      projectName: "proj-a",
      sessionName: "doomed",
      branchName: "csm/doomed",
      startedAt: new Date().toISOString(),
    });
    repo.createJobRecord({
      jobId: "other-project",
      jobType: "merge",
      status: "completed",
      projectName: "proj-b",
      sessionName: "doomed",
      branchName: "csm/doomed",
      startedAt: new Date().toISOString(),
    });

    const deleted = repo.deleteJobRecordsForSession("proj-a", "doomed");

    expect(deleted).toBe(2);
    const db = getSharedStateDb();
    const survivors = db
      .prepare("SELECT job_id FROM job_records ORDER BY job_id")
      .all() as Array<{ job_id: string }>;
    expect(survivors.map((r) => r.job_id)).toEqual(["keep-1", "other-project"]);
  });

  it("returns 0 when no rows match", () => {
    expect(repo.deleteJobRecordsForSession("nope", "nope")).toBe(0);
  });
});

describe("deleteJobRecordsForProject", () => {
  it("removes every job_record for the given project across all sessions", () => {
    repo.createJobRecord({
      jobId: "a1",
      jobType: "merge",
      status: "completed",
      projectName: "proj-a",
      sessionName: "s1",
      branchName: "csm/s1",
      startedAt: new Date().toISOString(),
    });
    repo.createJobRecord({
      jobId: "a2",
      jobType: "commit",
      status: "completed",
      projectName: "proj-a",
      sessionName: "s2",
      branchName: "csm/s2",
      startedAt: new Date().toISOString(),
    });
    repo.createJobRecord({
      jobId: "b1",
      jobType: "merge",
      status: "completed",
      projectName: "proj-b",
      sessionName: "s1",
      branchName: "csm/s1",
      startedAt: new Date().toISOString(),
    });

    const deleted = repo.deleteJobRecordsForProject("proj-a");

    expect(deleted).toBe(2);
    const db = getSharedStateDb();
    const survivors = db
      .prepare("SELECT job_id FROM job_records")
      .all() as Array<{ job_id: string }>;
    expect(survivors.map((r) => r.job_id)).toEqual(["b1"]);
  });
});

describe("deriveNotificationType", () => {
  it("maps merge + completed to merge-completed", () => {
    expect(deriveNotificationType("merge", "completed")).toBe(
      "merge-completed",
    );
  });

  it("maps merge + conflicts to merge-conflicts", () => {
    expect(deriveNotificationType("merge", "conflicts")).toBe(
      "merge-conflicts",
    );
  });

  it("maps merge + failed to merge-failed", () => {
    expect(deriveNotificationType("merge", "failed")).toBe("merge-failed");
  });

  it("maps merge + ready-to-land to merge-ready-to-land", () => {
    expect(deriveNotificationType("merge", "ready-to-land")).toBe(
      "merge-ready-to-land",
    );
  });

  it("maps merge + discarded to merge-discarded", () => {
    expect(deriveNotificationType("merge", "discarded")).toBe(
      "merge-discarded",
    );
  });

  it("maps commit + completed to commit-completed", () => {
    expect(deriveNotificationType("commit", "completed")).toBe(
      "commit-completed",
    );
  });

  it("maps commit + failed to commit-failed", () => {
    expect(deriveNotificationType("commit", "failed")).toBe("commit-failed");
  });

  it("maps resolve-conflicts + completed to resolve-completed", () => {
    expect(deriveNotificationType("resolve-conflicts", "completed")).toBe(
      "resolve-completed",
    );
  });

  it("maps resolve-conflicts + failed to resolve-failed", () => {
    expect(deriveNotificationType("resolve-conflicts", "failed")).toBe(
      "resolve-failed",
    );
  });

  it("maps rebase + completed to rebase-completed", () => {
    expect(deriveNotificationType("rebase", "completed")).toBe(
      "rebase-completed",
    );
  });

  it("maps rebase + failed to rebase-failed", () => {
    expect(deriveNotificationType("rebase", "failed")).toBe("rebase-failed");
  });
});

describe("deriveNotificationTitle", () => {
  it("returns human-readable titles for all types", () => {
    expect(deriveNotificationTitle("merge-completed")).toBe("Merge completed");
    expect(deriveNotificationTitle("merge-failed")).toBe("Merge failed");
    expect(deriveNotificationTitle("merge-conflicts")).toBe("Merge conflicts");
    expect(deriveNotificationTitle("merge-ready-to-land")).toBe(
      "Merge ready to land",
    );
    expect(deriveNotificationTitle("merge-discarded")).toBe(
      "Prepared merge discarded",
    );
    expect(deriveNotificationTitle("commit-completed")).toBe(
      "Commit completed",
    );
    expect(deriveNotificationTitle("commit-failed")).toBe("Commit failed");
    expect(deriveNotificationTitle("resolve-completed")).toBe(
      "Conflicts resolved",
    );
    expect(deriveNotificationTitle("resolve-failed")).toBe(
      "Conflict resolution failed",
    );
    expect(deriveNotificationTitle("rebase-completed")).toBe(
      "Rebase completed",
    );
    expect(deriveNotificationTitle("rebase-failed")).toBe("Rebase failed");
  });
});

describe("schema validation at the persistence boundary", () => {
  it("surfaces a PersistenceError when a stale job_record row has an invalid jobType", () => {
    const db = getSharedStateDb();
    db.prepare(
      `INSERT INTO job_records (job_id, job_type, status, project_name, session_name, branch_name, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "job-stale-bad",
      "not-a-job-type",
      "running",
      "p",
      "s",
      "csm/s",
      new Date().toISOString(),
    );

    let caught: unknown;
    try {
      repo.recoverStaleJobs();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    const failure = (caught as PersistenceError).failure;
    expect(failure.kind).toBe("validation");
    if (failure.kind === "validation") {
      expect(failure.entity).toBe("job_record");
    }
  });
});

describe("schema validation on the write path", () => {
  it("rejects createJobRecord when input fails backgroundJobSchema BEFORE the INSERT commits", () => {
    const db = getSharedStateDb();

    let caught: unknown;
    try {
      repo.createJobRecord({
        jobId: "job-bad-create",
        jobType: "not-a-job-type" as unknown as "merge",
        status: "running",
        projectName: "p",
        sessionName: "s",
        branchName: "csm/s",
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    const failure = (caught as PersistenceError).failure;
    expect(failure.kind).toBe("validation");
    if (failure.kind === "validation") {
      expect(failure.entity).toBe("job_record");
    }

    const row = db
      .prepare("SELECT COUNT(*) AS count FROM job_records WHERE job_id = ?")
      .get("job-bad-create") as { count: number };
    expect(row.count).toBe(0);
  });

  it("rejects updateJobRecord when input fails the update schema BEFORE the UPDATE commits", () => {
    const db = getSharedStateDb();
    repo.createJobRecord({
      jobId: "job-update-target",
      jobType: "merge",
      status: "running",
      projectName: "p",
      sessionName: "s",
      branchName: "csm/s",
      startedAt: new Date().toISOString(),
    });

    let caught: unknown;
    try {
      repo.updateJobRecord("job-update-target", {
        status: "not-a-status" as unknown as "completed",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    const failure = (caught as PersistenceError).failure;
    expect(failure.kind).toBe("validation");
    if (failure.kind === "validation") {
      expect(failure.entity).toBe("job_record");
      expect(failure.identifier).toBe("job-update-target");
    }

    const row = db
      .prepare("SELECT status FROM job_records WHERE job_id = ?")
      .get("job-update-target") as { status: string };
    expect(row.status).toBe("running");
  });
});
