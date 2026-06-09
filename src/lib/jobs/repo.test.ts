import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createJobRecord,
  updateJobRecord,
  getJobRecord,
  recoverStaleJobs,
  deleteJobRecordsForSession,
  deleteJobRecordsForProject,
  deriveNotificationType,
  deriveNotificationTitle,
} from "./repo";
import { getNotifications } from "../notifications/repo";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting,
  getDb as getSharedStateDb,
} from "../state-store/state-db";
import { jobRecordSchema } from "./schemas";
import { PersistenceError } from "../shared/errors";

vi.mock("../push-notification/dispatcher");

function installFreshTestDb() {
  const db = _createTestDb({ inMemory: true });
  _installTestDb(db);
}

beforeEach(() => {
  installFreshTestDb();
});

afterEach(() => {
  _resetForTesting();
});

describe("createJobRecord", () => {
  it("inserts a running job record", () => {
    createJobRecord({
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
    createJobRecord({
      jobId: "job-1",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: new Date().toISOString(),
    });

    updateJobRecord("job-1", {
      status: "completed",
      mergeHash: "abc123",
    });

    const recovered = recoverStaleJobs();
    expect(recovered).toBe(0);
  });
});

describe("getJobRecord", () => {
  it("reads back every durable field including the generated completedAt", () => {
    createJobRecord({
      jobId: "job-1",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: "2026-06-09 12:00:00",
    });
    updateJobRecord("job-1", {
      status: "completed",
      mergeHash: "abc123",
      commitHash: "def456",
      conflictCount: 2,
      conflictFiles: ["a.ts", "b.ts"],
      errorMessage: "none",
    });

    const record = getJobRecord("job-1");

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
    createJobRecord({
      jobId: "job-1",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: "2026-06-09 12:00:00",
    });
    updateJobRecord("job-1", { status: "completed" });

    const record = getJobRecord("job-1");

    expect(record).not.toBeNull();
    expect(() => jobRecordSchema.parse(record)).not.toThrow();
    const keys = Object.keys(record!);
    expect(keys).not.toContain("targetBranch");
    expect(keys).not.toContain("phase");
  });

  it("returns null for an unknown id", () => {
    expect(getJobRecord("does-not-exist")).toBeNull();
  });
});

describe("recoverStaleJobs", () => {
  it("marks running jobs as failed and creates failure notifications", () => {
    createJobRecord({
      jobId: "stale-1",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: new Date().toISOString(),
    });

    createJobRecord({
      jobId: "stale-2",
      jobType: "commit",
      status: "running",
      projectName: "my-project",
      sessionName: "another",
      branchName: "csm/another",
      startedAt: new Date().toISOString(),
    });

    const recovered = recoverStaleJobs();

    expect(recovered).toBe(2);
    const result = getNotifications();
    expect(result.notifications).toHaveLength(2);
    expect(result.notifications.every((n) => n.errorMessage)).toBe(true);
  });

  it("does not affect completed jobs", () => {
    createJobRecord({
      jobId: "completed-1",
      jobType: "merge",
      status: "running",
      projectName: "my-project",
      sessionName: "feature",
      branchName: "csm/feature",
      startedAt: new Date().toISOString(),
    });
    updateJobRecord("completed-1", { status: "completed", mergeHash: "abc" });

    const recovered = recoverStaleJobs();
    expect(recovered).toBe(0);
  });

  it("returns 0 when no stale jobs exist", () => {
    const recovered = recoverStaleJobs();
    expect(recovered).toBe(0);
  });
});

describe("deleteJobRecordsForSession", () => {
  it("removes only job_records matching the project+session pair", () => {
    createJobRecord({
      jobId: "keep-1",
      jobType: "merge",
      status: "completed",
      projectName: "proj-a",
      sessionName: "keep",
      branchName: "csm/keep",
      startedAt: new Date().toISOString(),
    });
    createJobRecord({
      jobId: "doomed-1",
      jobType: "merge",
      status: "completed",
      projectName: "proj-a",
      sessionName: "doomed",
      branchName: "csm/doomed",
      startedAt: new Date().toISOString(),
    });
    createJobRecord({
      jobId: "doomed-2",
      jobType: "commit",
      status: "completed",
      projectName: "proj-a",
      sessionName: "doomed",
      branchName: "csm/doomed",
      startedAt: new Date().toISOString(),
    });
    createJobRecord({
      jobId: "other-project",
      jobType: "merge",
      status: "completed",
      projectName: "proj-b",
      sessionName: "doomed",
      branchName: "csm/doomed",
      startedAt: new Date().toISOString(),
    });

    const deleted = deleteJobRecordsForSession("proj-a", "doomed");

    expect(deleted).toBe(2);
    const db = getSharedStateDb();
    const survivors = db
      .prepare("SELECT job_id FROM job_records ORDER BY job_id")
      .all() as Array<{ job_id: string }>;
    expect(survivors.map((r) => r.job_id)).toEqual(["keep-1", "other-project"]);
  });

  it("returns 0 when no rows match", () => {
    expect(deleteJobRecordsForSession("nope", "nope")).toBe(0);
  });
});

describe("deleteJobRecordsForProject", () => {
  it("removes every job_record for the given project across all sessions", () => {
    createJobRecord({
      jobId: "a1",
      jobType: "merge",
      status: "completed",
      projectName: "proj-a",
      sessionName: "s1",
      branchName: "csm/s1",
      startedAt: new Date().toISOString(),
    });
    createJobRecord({
      jobId: "a2",
      jobType: "commit",
      status: "completed",
      projectName: "proj-a",
      sessionName: "s2",
      branchName: "csm/s2",
      startedAt: new Date().toISOString(),
    });
    createJobRecord({
      jobId: "b1",
      jobType: "merge",
      status: "completed",
      projectName: "proj-b",
      sessionName: "s1",
      branchName: "csm/s1",
      startedAt: new Date().toISOString(),
    });

    const deleted = deleteJobRecordsForProject("proj-a");

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
});

describe("deriveNotificationTitle", () => {
  it("returns human-readable titles for all types", () => {
    expect(deriveNotificationTitle("merge-completed")).toBe("Merge completed");
    expect(deriveNotificationTitle("merge-failed")).toBe("Merge failed");
    expect(deriveNotificationTitle("merge-conflicts")).toBe("Merge conflicts");
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
      recoverStaleJobs();
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
      createJobRecord({
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
    createJobRecord({
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
      updateJobRecord("job-update-target", {
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
