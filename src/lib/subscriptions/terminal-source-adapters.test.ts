import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJobsRepo } from "@/lib/jobs/repo";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createValidationRunsRepo } from "@/lib/state-store/validation-runs-repo";
import { createSubscriptionSourceQueriesRepo } from "@/lib/state-store/subscription-source-queries-repo";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import {
  validationRunRecordSchema,
  type ValidationRunStatus,
} from "@/lib/validation/schemas";
import { createTerminalSourceReader } from "./terminal-source-adapters";

const projectPath = "/repos/terminal-sources";
const recipient = { projectPath, conversationId: "conversation" };
let fixture: PersistenceFixture;
beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(projectPath);
});
afterEach(() => fixture.close());
function reader() {
  return createTerminalSourceReader({
    workflows: createGraphWorkflowExecutionsRepo(fixture.db),
    archivedWorkflows: fixture.graphWorkflowArchivedExecutions,
    validations: createValidationRunsRepo(fixture.db),
    jobs: createJobsRepo(fixture.db),
    queries: createSubscriptionSourceQueriesRepo(fixture.db),
    now: () => "2026-09-30T12:20:00.000Z",
  });
}
function validation(runId: string, status: ValidationRunStatus) {
  createValidationRunsRepo(fixture.db).submit(
    validationRunRecordSchema.parse({
      runId,
      source: "agent_cli",
      commandName: "test",
      cost: 1,
      queueOrder: 0,
      status,
      nonce: "nonce",
      leaseToken: null,
      leaseExpiresAt: null,
      processGroupPid: null,
      projectPath,
      worktreePath: projectPath,
      sessionName: null,
      conversationId: "conversation",
      workflowExecutionId: null,
      workflowContextId: null,
      workflowRole: null,
      submittedAt: "2026-09-30T12:00:00.000Z",
      startedAt: null,
      finishedAt: "2026-09-30T12:01:00.000Z",
      queueMs: null,
      execMs: null,
      requestedScope: "changed",
      effectiveScope: "changed",
      scopedPathCount: 0,
      exitCode: null,
      timedOut: false,
    }),
  );
}
describe("cursor-free terminal source projections", () => {
  it("uses observed time for terminal rows without a recorded finish time", async () => {
    fixture.seedSession(projectPath, "session");
    const execution = createWorkflowExecution({
      id: "unknown-finish",
      status: "halted",
      completedAt: null,
    });
    fixture.graphWorkflowExecutions.setActive(
      projectPath,
      "session",
      execution,
      execution.startedAt,
    );
    expect(
      await reader()(recipient, { kind: "workflow", id: "unknown-finish" }),
    ).toMatchObject({
      kind: "terminal",
      fact: { occurredAt: "2026-09-30T12:20:00.000Z" },
    });
  });
  it("normalizes SQLite UTC job finish timestamps for deadline comparisons", async () => {
    const jobs = createJobsRepo(fixture.db);
    jobs.createJobRecord({
      jobId: "utc",
      jobType: "commit",
      status: "running",
      projectName: "terminal-sources",
      sessionName: "session",
      branchName: "branch",
      startedAt: "2026-09-30T12:00:00.000Z",
    });
    jobs.updateJobRecord("utc", { status: "failed" });
    const completedAt = jobs.getJobRecord("utc")?.completedAt;
    if (!completedAt) throw new Error("Missing durable finish timestamp");
    expect(
      await reader()(recipient, { kind: "git_job", id: "utc" }),
    ).toMatchObject({
      kind: "terminal",
      fact: { occurredAt: `${completedAt.replace(" ", "T")}Z` },
    });
  });
  it("reads every durable validation verdict including cancellation, interruption and unrunnable queued work", async () => {
    const terminalStatuses = [
      "passed",
      "failed",
      "timed_out",
      "cancelled",
      "interrupted",
      "cost_exceeds_limit",
    ] as const;
    for (const status of terminalStatuses) {
      validation(status, status);
      expect(
        await reader()(recipient, { kind: "validation", id: status }),
      ).toMatchObject({
        kind: "terminal",
        fact: {
          occurrenceId: `one-time-terminal:validation:${status}`,
          outcome: status,
        },
      });
    }
    validation("pending", "queued");
    expect(
      await reader()(recipient, { kind: "validation", id: "pending" }),
    ).toEqual({ kind: "pending", status: "queued" });
    expect(
      await reader()(
        { ...recipient, projectPath: "/other" },
        { kind: "validation", id: "passed" },
      ),
    ).toEqual({ kind: "missing" });
  });
  it("treats halted as terminal and paused as pending and retrieves exact archived executions without boundary history", async () => {
    fixture.seedSession(projectPath, "session");
    const paused = createWorkflowExecution({ id: "paused", status: "paused" });
    fixture.graphWorkflowExecutions.setActive(
      projectPath,
      "session",
      paused,
      paused.startedAt,
    );
    expect(
      await reader()(recipient, { kind: "workflow", id: "paused" }),
    ).toEqual({ kind: "pending", status: "paused" });
    for (const status of ["halted", "completed", "aborted"] as const) {
      const execution = createWorkflowExecution({
        id: status,
        status,
        completedAt: "2026-09-30T12:01:00.000Z",
      });
      fixture.graphWorkflowArchivedExecutions.insert({
        projectPath,
        sessionName: "session",
        executionId: status,
        archivedAt: "2026-09-30T12:02:00.000Z",
        status,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        execution,
      });
      expect(
        await reader()(recipient, { kind: "workflow", id: status }),
      ).toMatchObject({
        kind: "terminal",
        fact: {
          outcome: status,
          retrievalHandle: expect.stringContaining("workflow wait"),
        },
      });
    }
    expect(
      await reader()(recipient, { kind: "workflow", id: "successor" }),
    ).toEqual({ kind: "missing" });
  });
  it("keeps every git actor outcome terminal, including ready-to-land and discarded", async () => {
    const jobs = createJobsRepo(fixture.db);
    for (const status of [
      "completed",
      "failed",
      "conflicts",
      "ready-to-land",
      "discarded",
    ] as const) {
      jobs.createJobRecord({
        jobId: status,
        jobType: "merge",
        status,
        projectName: "terminal-sources",
        sessionName: "session",
        branchName: "branch",
        startedAt: "2026-09-30T12:00:00.000Z",
      });
      expect(
        await reader()(recipient, { kind: "git_job", id: status }),
      ).toMatchObject({ kind: "terminal", fact: { outcome: status } });
    }
    expect(
      await reader()(
        { ...recipient, projectPath: "/other" },
        { kind: "git_job", id: "completed" },
      ),
    ).toEqual({ kind: "missing" });
  });
});
