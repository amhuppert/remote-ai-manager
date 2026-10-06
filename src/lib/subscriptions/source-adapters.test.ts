import { createNotepadCommentsRepo } from "@/lib/state-store/notepad-comments-repo";
import { createNotepadDeliveryWatermarksRepo } from "@/lib/state-store/notepad-delivery-watermarks-repo";
import { createGraphWorkflowResultDeliveriesRepo } from "@/lib/state-store/graph-workflow-result-deliveries-repo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJobsRepo } from "@/lib/jobs/repo";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createNotepadsRepo } from "@/lib/state-store/notepads-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createTicketsRepo } from "@/lib/state-store/tickets-repo";
import { createValidationRunsRepo } from "@/lib/state-store/validation-runs-repo";
import { createSubscriptionSourceQueriesRepo } from "@/lib/state-store/subscription-source-queries-repo";
import { createTicketStatusChangesRepo } from "@/lib/state-store/ticket-status-changes-repo";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createSubscriptionSourceReader } from "./source-adapters";

const projectPath = "/repos/source-adapters";
const recipient = { projectPath, conversationId: "ordinary-session" };
let fixture: PersistenceFixture;

function reader() {
  return createSubscriptionSourceReader({
    notepads: createNotepadsRepo(fixture.db, createWriteQueue()),
    comments: createNotepadCommentsRepo(fixture.db, createWriteQueue()),
    watermarks: createNotepadDeliveryWatermarksRepo(
      fixture.db,
      createWriteQueue(),
    ),
    resultDeliveries: createGraphWorkflowResultDeliveriesRepo(fixture.db),
    tickets: createTicketsRepo(fixture.db, createWriteQueue()),
    specs: fixture.specs,
    specEvents: createSpecEventsRepo(fixture.db),
    workflows: fixture.graphWorkflowExecutions,
    archivedWorkflows: fixture.graphWorkflowArchivedExecutions,
    workflowEvents: fixture.graphWorkflowEvents,
    validations: createValidationRunsRepo(fixture.db),
    jobs: createJobsRepo(fixture.db),
    queries: createSubscriptionSourceQueriesRepo(fixture.db),
    ticketChanges: createTicketStatusChangesRepo(fixture.db),
    runs: { run: () => null, boundaries: () => [], question: () => null },
  });
}

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(projectPath);
});
afterEach(() => fixture.close());

async function notepad(
  scope: "global" | "project" = "project",
  path = projectPath,
) {
  const repo = createNotepadsRepo(fixture.db, createWriteQueue());
  await repo.create({
    id: "pad",
    revisionId: "pad-r1",
    scope,
    projectPath: scope === "global" ? null : path,
    name: "Decision notes",
    content: "Original",
    writeMode: "full-edit",
    authorKind: "user",
    authorConversationId: null,
    createdAt: "2026-09-30T10:00:00.000Z",
  });
  return repo;
}

describe("durable subscription sources", () => {
  it("baselines a notepad then reads committed revisions through a fresh reader", async () => {
    const repo = await notepad();
    const source = { kind: "notepad", id: "pad" } as const;
    const baseline = await reader()(recipient, source, null);
    expect(baseline).toEqual({
      cursor: JSON.stringify({ revision: 1, commentIds: [] }),
      facts: [],
      missing: false,
    });
    await repo.writeContent({
      notepadId: "pad",
      revisionId: "pad-r2",
      operation: "update",
      content: "Revised",
      authorKind: "agent",
      authorConversationId: "other-conversation",
      baseRevision: 1,
      enforceBaseRevision: true,
      permittedWriteModes: null,
      restoredFromRevision: null,
      writtenAt: "2026-09-30T10:01:00.000Z",
      coalesceWindowMs: null,
    });
    const updated = await reader()(recipient, source, baseline.cursor);
    expect(JSON.parse(updated.cursor ?? "null")).toEqual({
      revision: 2,
      commentIds: [],
    });
    expect(updated.facts).toMatchObject([
      {
        occurrenceId: "pad-r2:2",
        category: "revision",
        revision: "2",
        actorConversationId: "other-conversation",
      },
    ]);
    expect(await reader()(recipient, source, updated.cursor)).toMatchObject({
      cursor: updated.cursor,
      facts: [],
      missing: false,
    });
  });

  it("allows global sources and refuses another project's content", async () => {
    await notepad("global");
    expect(
      (await reader()(recipient, { kind: "notepad", id: "pad" }, null)).missing,
    ).toBe(false);
    const other = "/repos/other-project";
    fixture.seedProject(other);
    const repo = createNotepadsRepo(fixture.db, createWriteQueue());
    await repo.create({
      id: "private",
      revisionId: "private-r1",
      scope: "project",
      projectPath: other,
      name: "Private",
      content: "Secret",
      writeMode: "full-edit",
      authorKind: "user",
      authorConversationId: null,
      createdAt: "2026-09-30T10:00:00.000Z",
    });
    const result = await reader()(
      recipient,
      { kind: "notepad", id: "private" },
      "0",
    );
    expect(result).toEqual({ cursor: "0", facts: [], missing: true });
  });

  it("returns a missing-source outcome after durable deletion", async () => {
    const repo = await notepad();
    await repo.delete("pad");
    expect(
      await reader()(recipient, { kind: "notepad", id: "pad" }, "1"),
    ).toEqual({ cursor: "1", facts: [], missing: true });
  });

  it("keeps distinct spec decisions after an event baseline and retains their actor", async () => {
    await fixture.specs.create({
      spec: {
        id: "spec",
        projectPath,
        slug: "shipping",
        name: "Shipping",
        gatePolicy: { preset: "contract-bearing" },
        createdAt: "2026-09-30T10:00:00.000Z",
        updatedAt: "2026-09-30T10:00:00.000Z",
      },
      initialRevision: {
        id: "spec-r1",
        authoringStage: "requirements",
        createdAt: "2026-09-30T10:00:00.000Z",
      },
    });
    const events = createSpecEventsRepo(fixture.db);
    events.append({
      spec_id: "spec",
      occurred_at: "2026-09-30T10:00:00.000Z",
      event_type: "spec-revision-changed",
      actor_json: JSON.stringify({
        kind: "agent",
        conversationId: recipient.conversationId,
      }),
      payload_json: JSON.stringify({
        kind: "element-upserted",
        revisionId: "spec-r1",
      }),
    });
    const source = { kind: "spec", id: "spec" } as const;
    const baseline = await reader()(recipient, source, null);
    expect(baseline.missing).toBe(false);
    events.append({
      spec_id: "spec",
      occurred_at: "2026-09-30T10:00:30.000Z",
      event_type: "spec-revision-changed",
      actor_json: JSON.stringify({ kind: "system" }),
      payload_json: JSON.stringify({ kind: "execution-changed" }),
    });
    events.append({
      spec_id: "spec",
      occurred_at: "2026-09-30T10:01:00.000Z",
      event_type: "spec-review-changes-requested",
      actor_json: JSON.stringify({ kind: "human" }),
      payload_json: JSON.stringify({
        revisionId: "spec-r1",
        comment: "Add rollback behavior",
      }),
    });
    events.append({
      spec_id: "spec",
      occurred_at: "2026-09-30T10:02:00.000Z",
      event_type: "spec-review-revision-signed-off",
      actor_json: JSON.stringify({ kind: "human" }),
      payload_json: JSON.stringify({
        revisionId: "spec-r1",
        gate: "requirements",
      }),
    });
    const updated = await reader()(recipient, source, baseline.cursor);
    expect(updated.facts[0]).toMatchObject({ actorConversationId: null });
    expect(updated.facts.map((fact) => fact.category)).toEqual([
      "revision",
      "decision",
      "decision",
    ]);
    expect((await reader()(recipient, source, updated.cursor)).facts).toEqual(
      [],
    );
    expect(new Set(updated.facts.map((fact) => fact.occurrenceId)).size).toBe(
      3,
    );
    expect(updated.facts[1]?.summary).toContain("Add rollback behavior");
  });

  it("reads validation terminal snapshots once without suppressing the submitter's result", async () => {
    const repo = createValidationRunsRepo(fixture.db);
    repo.submit({
      runId: "validation",
      source: "agent_cli",
      commandName: "test",
      cost: 1,
      queueOrder: 0,
      status: "queued",
      nonce: "nonce",
      leaseToken: "lease",
      leaseExpiresAt: "2026-09-30T10:02:00.000Z",
      processGroupPid: null,
      projectPath,
      worktreePath: projectPath,
      sessionName: null,
      conversationId: recipient.conversationId,
      workflowExecutionId: null,
      workflowContextId: null,
      workflowRole: null,
      submittedAt: "2026-09-30T10:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      queueMs: null,
      execMs: null,
      requestedScope: "changed",
      effectiveScope: "changed",
      scopedPathCount: 1,
      exitCode: null,
      timedOut: false,
    });
    const source = { kind: "validation", id: "validation" } as const;
    const baseline = await reader()(recipient, source, null);
    expect(baseline.missing).toBe(false);
    repo.admit("validation");
    repo.markFailed("validation", {
      finishedAt: "2026-09-30T10:01:00.000Z",
      execMs: 10,
      exitCode: 1,
    });
    const updated = await reader()(recipient, source, baseline.cursor);
    expect(updated.facts).toMatchObject([
      {
        occurrenceId: "one-time-terminal:validation:validation",
        category: "outcome",
        outcome: "failed",
        actorConversationId: recipient.conversationId,
      },
    ]);
    expect((await reader()(recipient, source, updated.cursor)).facts).toEqual(
      [],
    );
  });

  it("reads exact git jobs durably and enforces project visibility", async () => {
    const jobs = createJobsRepo(fixture.db);
    jobs.createJobRecord({
      jobId: "git-job",
      jobType: "commit",
      status: "running",
      projectName: "source-adapters",
      sessionName: "session",
      branchName: "session",
      startedAt: "2026-09-30T10:00:00.000Z",
    });
    const source = { kind: "git_job", id: "git-job" } as const;
    const baseline = await reader()(recipient, source, null);
    expect(baseline.missing).toBe(false);
    jobs.updateJobRecord("git-job", {
      status: "failed",
      errorMessage: "Commit rejected",
    });
    expect(
      (await reader()(recipient, source, baseline.cursor)).facts,
    ).toMatchObject([
      {
        occurrenceId: "one-time-terminal:git_job:git-job",
        category: "outcome",
        outcome: "failed",
        actorConversationId: null,
      },
    ]);
    const jobFact = (await reader()(recipient, source, baseline.cursor))
      .facts[0];
    expect(jobFact?.occurredAt).toMatch(/T.*Z$/);
    expect(jobFact?.retrievalHandle).toContain("cctl inbox list");
    expect(jobFact?.sourceText).toContain('"jobId":"git-job"');
    expect(
      (
        await reader()(
          { ...recipient, projectPath: "/repos/other" },
          source,
          null,
        )
      ).missing,
    ).toBe(true);
  });

  it("reads workflow boundary IDs across keyset pages and after archival", async () => {
    fixture.seedSession(projectPath, "session");
    const execution = createWorkflowExecution({
      id: "workflow",
      ownerConversationId: recipient.conversationId,
    });
    fixture.graphWorkflowExecutions.setActive(
      projectPath,
      "session",
      execution,
      "2026-09-30T10:00:00.000Z",
    );
    const source = { kind: "workflow", id: "workflow" } as const;
    const baseline = await reader()(recipient, source, null);
    expect(baseline.missing).toBe(false);
    fixture.graphWorkflowEvents.appendMany(
      projectPath,
      "session",
      "workflow",
      "2026-09-30T10:01:00.000Z",
      Array.from({ length: 501 }, () => ({
        occurredAt: "2026-09-30T10:01:00.000Z",
        preReset: false,
        event: {
          type: "graph-workflow-status",
          projectName: "source-adapters",
          sessionName: "session",
          executionId: "workflow",
          workflowStatus: "running",
          activeContextIds: [],
          activeBatchIds: [],
          activeJoinIds: [],
          haltReason: null,
          pendingHaltReason: null,
          secondaryHaltReasons: [],
        },
      })),
    );
    const boundary = fixture.graphWorkflowEvents.append(
      projectPath,
      "session",
      "workflow",
      "2026-09-30T10:02:00.000Z",
      {
        occurredAt: "2026-09-30T10:02:00.000Z",
        preReset: false,
        event: {
          type: "graph-workflow-boundary",
          projectName: "source-adapters",
          sessionName: "session",
          executionId: "workflow",
          boundaryKind: "completion",
          workflowStatus: "completed",
          completedAt: "2026-09-30T10:02:00.000Z",
          contextId: null,
          pendingActions: [],
          outputProjection: { kind: "no_declared_structured_result" },
        },
      },
    );
    const updated = await reader()(recipient, source, baseline.cursor);
    expect(updated.cursor).toBe(String(boundary.id));
    expect(updated.facts).toMatchObject([
      {
        occurrenceId: String(boundary.id),
        category: "outcome",
        outcome: "completed",
      },
    ]);
    fixture.graphWorkflowArchivedExecutions.insert({
      projectPath,
      sessionName: "session",
      executionId: "workflow",
      archivedAt: "2026-09-30T10:03:00.000Z",
      status: "completed",
      startedAt: execution.startedAt,
      completedAt: "2026-09-30T10:02:00.000Z",
      execution: {
        ...execution,
        status: "completed",
        completedAt: "2026-09-30T10:02:00.000Z",
      },
    });
    fixture.graphWorkflowExecutions.setActive(
      projectPath,
      "session",
      null,
      "2026-09-30T10:03:00.000Z",
    );
    expect((await reader()(recipient, source, updated.cursor)).missing).toBe(
      false,
    );
  });

  it("retains committed ticket status provenance and every post across pages", async () => {
    const tickets = createTicketsRepo(fixture.db, createWriteQueue());
    await tickets.create({
      id: "ticket",
      projectPath,
      title: "Shipping",
      description: "Details",
      workType: "feature",
      status: "not_started",
      createdAt: "2026-09-30T10:00:00.000Z",
      updatedAt: "2026-09-30T10:00:00.000Z",
    });
    const source = { kind: "ticket", id: "ticket" } as const;
    const baseline = await reader()(recipient, source, null);
    expect(baseline.missing).toBe(false);
    await tickets.update({
      projectPath,
      number: 1,
      status: "in_progress",
      actorConversationId: recipient.conversationId,
      updatedAt: "2026-09-30T10:01:00.000Z",
    });
    await tickets.update({
      projectPath,
      number: 1,
      title: "Renamed",
      updatedAt: "2026-09-30T10:02:00.000Z",
    });
    for (let i = 0; i < 102; i++)
      await tickets.addStatusUpdate({
        id: `post-${String(i).padStart(3, "0")}`,
        ticketId: "ticket",
        bodyMarkdown: `Status note ${i}`,
        author: { kind: "user" },
        createdAt: "2026-09-30T10:03:00.000Z",
      });
    const updated = await reader()(recipient, source, baseline.cursor);
    expect(updated.facts).toHaveLength(103);
    expect(updated.facts[0]).toMatchObject({
      category: "decision",
      outcome: "in_progress",
      actorConversationId: recipient.conversationId,
    });
    expect(new Set(updated.facts.map((fact) => fact.occurrenceId)).size).toBe(
      103,
    );
    expect((await reader()(recipient, source, updated.cursor)).facts).toEqual(
      [],
    );
  });
});
