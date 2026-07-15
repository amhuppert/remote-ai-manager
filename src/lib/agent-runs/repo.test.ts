import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createAgentRunsRepo, type AgentRunsRepo } from "./repo";
import { getStateDb } from "../state-store/store";
import {
  _createTestDb,
  _installTestDb,
  _resetForTesting,
} from "../state-store/state-db";

let repo: AgentRunsRepo;

beforeEach(() => {
  const db = _createTestDb({ inMemory: true });
  _installTestDb(db);
  repo = createAgentRunsRepo(db);
});

afterEach(() => {
  _resetForTesting();
});

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

describe("recoverStaleAgentRuns", () => {
  it("sweeps a running row whose owning process is dead", () => {
    repo.createAgentRunRecord({
      runId: "orphaned-run",
      backend: "codex",
      projectName: "proj",
      sessionName: "sess",
      startedAt: "2026-01-01T00:00:00.000Z",
      ownerPid: deadPid(),
    });

    const swept = repo.recoverStaleAgentRuns();

    expect(swept).toBe(1);
    const record = repo.getAgentRunRecord("orphaned-run");
    expect(record).not.toBeNull();
    expect(record?.status).toBe("failed");
    expect(record?.error).toBe(
      "Agent run interrupted: owning server process exited",
    );
    expect(record?.completedAt).toBeTypeOf("string");
  });

  it("spares another live worker's running row while sweeping a dead worker's row", () => {
    // Worker A (this very process, provably alive) owns a live run in the
    // shared file-backed DB.
    repo.createAgentRunRecord({
      runId: "live-worker-run",
      backend: "codex",
      projectName: "proj",
      sessionName: "sess",
      startedAt: "2026-01-01T00:00:00.000Z",
      ownerPid: process.pid,
    });
    // A run owned by a worker process that has since exited.
    repo.createAgentRunRecord({
      runId: "dead-worker-run",
      backend: "claude",
      projectName: "proj",
      sessionName: "sess",
      startedAt: "2026-01-01T00:00:00.000Z",
      ownerPid: deadPid(),
    });

    // Worker B starting up against the same DB runs its sweep.
    const swept = repo.recoverStaleAgentRuns();

    expect(swept).toBe(1);
    expect(repo.getAgentRunRecord("live-worker-run")?.status).toBe("running");
    expect(repo.getAgentRunRecord("dead-worker-run")?.status).toBe("failed");
  });

  it("sweeps a running row with no recorded owner pid", () => {
    // A row written without an owner pid (e.g. crashed mid-insert epoch).
    getStateDb()
      .prepare(
        `INSERT INTO agent_run_records
           (run_id, backend, project_name, session_name, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-run",
        "codex",
        "proj",
        "sess",
        "running",
        "2026-01-01T00:00:00.000Z",
      );

    const swept = repo.recoverStaleAgentRuns();

    expect(swept).toBe(1);
    expect(repo.getAgentRunRecord("legacy-run")?.status).toBe("failed");
  });

  it("leaves terminal rows untouched and returns 0 when nothing is running", () => {
    repo.createAgentRunRecord({
      runId: "settled-run",
      backend: "codex",
      projectName: "proj",
      sessionName: "sess",
      startedAt: "2026-01-01T00:00:00.000Z",
      ownerPid: deadPid(),
    });
    repo.updateAgentRunRecord("settled-run", {
      status: "completed",
      completedAt: "2026-01-01T00:05:00.000Z",
      summary: "done",
    });

    const swept = repo.recoverStaleAgentRuns();

    expect(swept).toBe(0);
    const record = repo.getAgentRunRecord("settled-run");
    expect(record?.status).toBe("completed");
    expect(record?.summary).toBe("done");
    expect(record?.error).toBeUndefined();
    expect(record?.completedAt).toBe("2026-01-01T00:05:00.000Z");
  });

  it("sweeps every dead-owner running row in one pass", () => {
    const pid = deadPid();
    for (const runId of ["run-a", "run-b", "run-c"]) {
      repo.createAgentRunRecord({
        runId,
        backend: "codex",
        projectName: "proj",
        sessionName: "sess",
        startedAt: "2026-01-01T00:00:00.000Z",
        ownerPid: pid,
      });
    }

    expect(repo.recoverStaleAgentRuns()).toBe(3);
    for (const runId of ["run-a", "run-b", "run-c"]) {
      expect(repo.getAgentRunRecord(runId)?.status).toBe("failed");
    }
  });
});

describe("record round-trip", () => {
  it("persists and reads back the backend a run was created for", () => {
    repo.createAgentRunRecord({
      runId: "claude-run",
      backend: "claude",
      projectName: "proj",
      sessionName: "sess",
      startedAt: "2026-01-01T00:00:00.000Z",
      ownerPid: process.pid,
    });

    const record = repo.getAgentRunRecord("claude-run");
    expect(record?.backend).toBe("claude");
    expect(record?.status).toBe("running");
  });
});
