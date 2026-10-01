import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { createSubscriptionSourceQueriesRepo } from "./subscription-source-queries-repo";
import { createTicketsRepo } from "./tickets-repo";
import { createSpecEventsRepo } from "./spec-events-repo";
import { createWriteQueue } from "./write-queue";

const projectPath = "/repos/source-queries";
const recipient = { projectPath, conversationId: "author" };
const occurredAt = "2026-09-30T10:00:00.000Z";
let fixture: PersistenceFixture;
beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(projectPath);
  fixture.seedSession(projectPath, "session");
});
afterEach(() => fixture.close());

// Every projection field is derived from canonical domain rows. This read-only
// repository has no persisted fields; maximal serialization contracts stay in
// the tickets, spec-events and executions repositories.
describe("source involvement query projections", () => {
  it("reloads scoped source identities, earliest involvement, and immutable launch ownership", async () => {
    const tickets = createTicketsRepo(fixture.db, createWriteQueue());
    await tickets.create({
      id: "ticket",
      projectPath,
      title: "Ticket",
      description: "Details",
      workType: "feature",
      status: "not_started",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    await tickets.addAttachment({
      id: "attachment",
      ticketId: "ticket",
      description: "Recorded conversation",
      payload: {
        kind: "conversation",
        projectPath,
        sessionName: null,
        conversationId: recipient.conversationId,
        snapshotKey: "snapshot",
        snapshotCapturedAt: occurredAt,
      },
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    await fixture.specs.create({
      spec: {
        id: "spec",
        projectPath,
        slug: "source-queries",
        name: "Spec",
        gatePolicy: { preset: "contract-bearing" },
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
      initialRevision: {
        id: "revision",
        authoringStage: "requirements",
        createdAt: occurredAt,
      },
    });
    const events = createSpecEventsRepo(fixture.db);
    const first = events.append({
      spec_id: "spec",
      occurred_at: occurredAt,
      event_type: "spec-review-commented",
      actor_json: JSON.stringify({
        kind: "agent",
        conversationId: recipient.conversationId,
      }),
      payload_json: "{}",
    });
    events.append({
      spec_id: "spec",
      occurred_at: occurredAt,
      event_type: "spec-review-revision-signed-off",
      actor_json: JSON.stringify({
        kind: "agent",
        conversationId: recipient.conversationId,
      }),
      payload_json: "{}",
    });
    const execution = createWorkflowExecution({
      id: "workflow",
      ownerConversationId: recipient.conversationId,
    });
    fixture.graphWorkflowExecutions.setActive(
      projectPath,
      "session",
      execution,
      occurredAt,
    );
    const reloaded = createSubscriptionSourceQueriesRepo(fixture.db);
    expect(reloaded.findTicketInvolvement(recipient, null)).toEqual([
      { id: "ticket", occurredAt },
    ]);
    expect(reloaded.findSpecInvolvement(recipient)).toEqual([
      { id: "spec", eventId: first.id },
    ]);
    expect(reloaded.findWorkflowAddress("workflow")).toEqual({
      projectPath,
      sessionName: "session",
    });
    expect(reloaded.findWorkflowInvolvement(recipient)).toEqual(["workflow"]);
    const other = {
      projectPath: "/repos/another",
      conversationId: recipient.conversationId,
    };
    expect(reloaded.findTicketInvolvement(other, "session")).toEqual([]);
    expect(reloaded.findSpecInvolvement(other)).toEqual([]);
    expect(reloaded.findWorkflowInvolvement(other)).toEqual([]);
    fixture.graphWorkflowArchivedExecutions.insert({
      projectPath,
      sessionName: "session",
      executionId: "workflow",
      archivedAt: occurredAt,
      status: "completed",
      startedAt: execution.startedAt,
      completedAt: occurredAt,
      execution: { ...execution, status: "completed", completedAt: occurredAt },
    });
    fixture.graphWorkflowExecutions.setActive(
      projectPath,
      "session",
      null,
      occurredAt,
    );
    const restarted = createSubscriptionSourceQueriesRepo(fixture.db);
    expect(restarted.findWorkflowAddress("workflow")).toEqual({
      projectPath,
      sessionName: "session",
    });
    expect(restarted.findWorkflowInvolvement(recipient)).toEqual(["workflow"]);
  });

  it("uses exact live session incarnations for ticket context and ignores search or refusal events", async () => {
    const tickets = createTicketsRepo(fixture.db, createWriteQueue());
    await tickets.create({
      id: "ticket",
      projectPath,
      title: "Ticket",
      description: "Details",
      workType: "feature",
      status: "not_started",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
    const linked = await tickets.linkStartedSession({
      id: "link",
      projectPath,
      number: 1,
      sessionName: "session",
      sessionCreatedAt: "2026-01-01T00:00:00Z",
      startMode: "prepared",
      linkedAt: occurredAt,
    });
    expect(
      createSubscriptionSourceQueriesRepo(fixture.db).findTicketInvolvement(
        recipient,
        "session",
      ),
    ).toEqual([{ id: "ticket", occurredAt: linked.sessions[0]?.linkedAt }]);
    fixture.seedSession(projectPath, "session", {
      createdAt: "2026-09-30T11:00:00.000Z",
    });
    expect(
      createSubscriptionSourceQueriesRepo(fixture.db).findTicketInvolvement(
        recipient,
        "session",
      ),
    ).toEqual([]);
    await fixture.specs.create({
      spec: {
        id: "spec",
        projectPath,
        slug: "intervention",
        name: "Spec",
        gatePolicy: { preset: "contract-bearing" },
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
      initialRevision: {
        id: "revision",
        authoringStage: "requirements",
        createdAt: occurredAt,
      },
    });
    createSpecEventsRepo(fixture.db).append({
      spec_id: "spec",
      occurred_at: occurredAt,
      event_type: "spec-intervention-recorded",
      actor_json: JSON.stringify({
        kind: "agent",
        conversationId: recipient.conversationId,
      }),
      payload_json: "{}",
    });
    expect(
      createSubscriptionSourceQueriesRepo(fixture.db).findSpecInvolvement(
        recipient,
      ),
    ).toEqual([]);
  });
});
