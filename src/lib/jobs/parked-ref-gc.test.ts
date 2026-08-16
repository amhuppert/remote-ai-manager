import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultGitClient } from "../git/client";
import { listParkedMergeRefs, deleteParkedMergeRef } from "../git/worktree";
import { _createTestDb } from "../state-store/state-db";
import { createJobsRepo, type JobsRepo } from "./repo";
import { collectOrphanedParkedRefs } from "./parked-ref-gc";
import type { Db } from "../state-store/schemas";

let repo: string;
let db: Db;
let jobsRepo: JobsRepo;
let parkedSha: string;

async function repoGit(args: string[]): Promise<string> {
  const { stdout } = await defaultGitClient.git(args, repo);
  return stdout.trim();
}

/** Register a job and drive it to the given terminal status. */
function recordJob(
  jobId: string,
  status: "ready-to-land" | "completed" | "discarded" | "running",
): void {
  jobsRepo.createJobRecord({
    jobId,
    jobType: "merge",
    status: "running",
    projectName: "proj",
    sessionName: "s1",
    branchName: "csm/s1",
    startedAt: "2026-08-15 09:00:00",
  });
  if (status === "running") return;
  jobsRepo.updateJobRecord(jobId, {
    status,
    ...(status === "ready-to-land"
      ? {
          parkedRef: `refs/cc-merges/${jobId}`,
          preparedSha: parkedSha,
          expectedTargetSha: parkedSha,
        }
      : {}),
  });
}

async function park(jobId: string): Promise<void> {
  await repoGit(["update-ref", `refs/cc-merges/${jobId}`, parkedSha]);
}

/**
 * The GC composes the production git ops and the production jobs repo; only the
 * project enumeration (config/state concern) is supplied by the caller.
 */
function runGc(): Promise<{
  scannedProjects: number;
  deleted: number;
  retained: number;
}> {
  return collectOrphanedParkedRefs({
    listProjectPaths: async () => [repo],
    listParkedMergeRefs,
    deleteParkedMergeRef,
    listJobIdsHoldingParkedRefs: () => jobsRepo.listJobIdsHoldingParkedRefs(),
  });
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "cc-parked-gc-"));
  await repoGit(["init", "--initial-branch=main", "."]);
  await repoGit(["config", "user.email", "engine@command-center.test"]);
  await repoGit(["config", "user.name", "Command Center"]);
  await writeFile(path.join(repo, "a.txt"), "base\n", "utf-8");
  await repoGit(["add", "-A"]);
  await repoGit(["commit", "-m", "base"]);
  parkedSha = await repoGit(["rev-parse", "HEAD"]);

  db = _createTestDb({ inMemory: true });
  jobsRepo = createJobsRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(repo, { recursive: true, force: true });
});

describe("collectOrphanedParkedRefs", () => {
  it("deletes refs whose job is finished and keeps the parked candidate's", async () => {
    recordJob("job-parked", "ready-to-land");
    recordJob("job-landed", "completed");
    recordJob("job-dropped", "discarded");
    await park("job-parked");
    await park("job-landed");
    await park("job-dropped");

    const summary = await runGc();

    expect(summary).toEqual({ scannedProjects: 1, deleted: 2, retained: 1 });
    expect(await listParkedMergeRefs(repo)).toEqual([
      { ref: "refs/cc-merges/job-parked", jobId: "job-parked" },
    ]);
    // The candidate's commit is still there to land.
    expect(await repoGit(["rev-parse", "refs/cc-merges/job-parked"])).toBe(
      parkedSha,
    );
  });

  /**
   * A ref whose job row is gone entirely — the session was deleted, or the row
   * aged out — is the leak this exists to close.
   */
  it("deletes a ref with no job row at all", async () => {
    await park("job-forgotten");

    const summary = await runGc();

    expect(summary.deleted).toBe(1);
    expect(await listParkedMergeRefs(repo)).toEqual([]);
  });

  /**
   * A merge running in another worker has already written its ref but has not
   * reached ready-to-land; collecting it would delete the commit that worker is
   * about to publish.
   */
  it("keeps the ref of a job still running", async () => {
    recordJob("job-in-flight", "running");
    await park("job-in-flight");

    const summary = await runGc();

    expect(summary).toEqual({ scannedProjects: 1, deleted: 0, retained: 1 });
    expect(await listParkedMergeRefs(repo)).toEqual([
      { ref: "refs/cc-merges/job-in-flight", jobId: "job-in-flight" },
    ]);
  });

  /**
   * The sweep runs at startup in every worker sharing the database, so a merge
   * another worker dispatches while this one walks — writing its ref between
   * prepare and publish — must not have that commit collected out from under
   * it. The question is only safe to answer at the moment of deletion.
   */
  it("keeps a ref whose job appears while the sweep is walking", async () => {
    await park("job-mid-sweep");

    const summary = await collectOrphanedParkedRefs({
      listProjectPaths: async () => [repo],
      listParkedMergeRefs: async (projectPath) => {
        recordJob("job-mid-sweep", "running");
        return listParkedMergeRefs(projectPath);
      },
      deleteParkedMergeRef,
      listJobIdsHoldingParkedRefs: () => jobsRepo.listJobIdsHoldingParkedRefs(),
    });

    expect(summary).toEqual({ scannedProjects: 1, deleted: 0, retained: 1 });
    expect(await repoGit(["rev-parse", "refs/cc-merges/job-mid-sweep"])).toBe(
      parkedSha,
    );
  });

  it("reports a clean sweep for a project with no parked refs", async () => {
    expect(await runGc()).toEqual({
      scannedProjects: 1,
      deleted: 0,
      retained: 0,
    });
  });

  /**
   * Startup must not be held hostage by one unreadable project: a path that no
   * longer exists is skipped, and the remaining projects are still collected.
   */
  it("skips a project whose repository cannot be read", async () => {
    recordJob("job-landed", "completed");
    await park("job-landed");
    const missing = path.join(tmpdir(), "cc-parked-gc-missing-repo");

    const summary = await collectOrphanedParkedRefs({
      listProjectPaths: async () => [missing, repo],
      listParkedMergeRefs,
      deleteParkedMergeRef,
      listJobIdsHoldingParkedRefs: () => jobsRepo.listJobIdsHoldingParkedRefs(),
    });

    expect(summary.deleted).toBe(1);
    expect(await listParkedMergeRefs(repo)).toEqual([]);
  });
});
