import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ticketStatusChangeSchema } from "@/lib/tickets/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { createWriteQueue } from "./write-queue";
import { createTicketsRepo } from "./tickets-repo";
import { createTicketStatusChangesRepo } from "./ticket-status-changes-repo";

const projectPath = "/repos/status-changes";
let fixture: PersistenceFixture;
beforeEach(async () => {
  fixture = createPersistenceFixture();
  fixture.seedProject(projectPath);
  await createTicketsRepo(fixture.db, createWriteQueue()).create({
    id: "ticket",
    projectPath,
    title: "Shipping",
    description: "Details",
    status: "not_started",
    workType: "feature",
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
  });
});
afterEach(() => fixture.close());

describe("committed ticket status provenance", () => {
  it("records only actual status changes and reloads their actor and occurrence", async () => {
    const tickets = createTicketsRepo(fixture.db, createWriteQueue());
    await tickets.update({
      projectPath,
      number: 1,
      status: "in_progress",
      actorConversationId: "conversation",
      updatedAt: "2026-09-30T10:01:00.000Z",
    });
    await tickets.update({
      projectPath,
      number: 1,
      title: "New title",
      updatedAt: "2026-09-30T10:02:00.000Z",
    });
    await tickets.update({
      projectPath,
      number: 1,
      status: "in_progress",
      updatedAt: "2026-09-30T10:03:00.000Z",
    });
    const reloaded = createTicketStatusChangesRepo(fixture.db).listAfter(
      "ticket",
      0,
    );
    expect(reloaded).toMatchObject([
      {
        ticketId: "ticket",
        status: "in_progress",
        actorConversationId: "conversation",
        occurredAt: "2026-09-30T10:01:00.000Z",
      },
    ]);
    expect(reloaded).toHaveLength(1);
    await tickets.update({
      projectPath,
      number: 1,
      status: "done",
      updatedAt: "2026-09-30T10:04:00.000Z",
    });
    expect(
      createTicketStatusChangesRepo(fixture.db).listAfter(
        "ticket",
        reloaded[0]?.id ?? 0,
      ),
    ).toMatchObject([{ status: "done", actorConversationId: null }]);
  });

  it("records the automatic started transition atomically with the session link", async () => {
    const createdAt = "2026-09-30T10:01:00.000Z";
    fixture.seedSession(projectPath, "started", { createdAt });
    const tickets = createTicketsRepo(fixture.db, createWriteQueue());
    const detail = await tickets.linkStartedSession({
      id: "started-link",
      projectPath,
      number: 1,
      sessionName: "started",
      sessionCreatedAt: createdAt,
      linkedAt: "2026-09-30T10:02:00.000Z",
      startMode: "agent",
    });
    expect(detail.status).toBe("in_progress");
    expect(
      createTicketStatusChangesRepo(fixture.db).listAfter("ticket", 0),
    ).toMatchObject([
      {
        ticketId: "ticket",
        status: "in_progress",
        actorConversationId: null,
        occurredAt: detail.updatedAt,
      },
    ]);
  });

  it("preserves every ledger field through a fresh repository", async () => {
    await assertRoundTripDurability({
      label: "ticket-status-change",
      schema: ticketStatusChangeSchema,
      buildMaximalFixture: () =>
        ticketStatusChangeSchema.parse({
          id: 29,
          ticketId: "ticket",
          status: "done",
          actorConversationId: "actor-maximal",
          occurredAt: "2026-09-30T10:05:00.000Z",
        }),
      persist: ({ id: _id, ...change }) =>
        createTicketStatusChangesRepo(fixture.db).appendInTransaction(change),
      reload: (expected) =>
        createTicketStatusChangesRepo(fixture.db).listAfter(
          "ticket",
          expected.id - 1,
        )[0] ?? null,
      fieldPolicies: { id: "derived-on-write" },
    });
  });
});
