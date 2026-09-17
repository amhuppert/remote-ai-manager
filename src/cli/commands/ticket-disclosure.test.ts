import { beforeAll, describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../testing/framework";

import type {
  TicketDetail,
  TicketRelationshipView,
  TicketStatusUpdate,
} from "@/lib/tickets/schemas";
import {
  buildRelationshipOutline,
  buildRelationshipPageProjection,
  buildStatusUpdateOutline,
  buildStatusUpdatePageProjection,
  buildTicketGetProjection,
  relationshipListCommand,
  renderRelationshipPageText,
  renderStatusUpdatePageText,
  statusUpdateListCommand,
  ticketDisclosureMetadataSchema,
  ticketGetProjectionSchema,
  ticketRelationshipOutlineSchema,
  ticketStatusUpdateOutlineSchema,
} from "./ticket/disclosure";

beforeAll(() => {
  createCcRuntimeFixture({ respond: () => jsonReply({}) });
});

const relationship: TicketRelationshipView = {
  id: "rel-1",
  role: "depends_on",
  otherTicket: {
    id: "ticket-2",
    projectName: "other repo",
    number: 7,
    title: "Ship the prerequisite",
    status: "in_progress",
  },
  description: "Needs   the API\ncontract first",
  createdAt: "2026-08-31T12:00:00.000Z",
  updatedAt: "2026-08-31T13:00:00.000Z",
};

const userUpdate: TicketStatusUpdate = {
  id: "update-1",
  ticketId: "ticket-1",
  bodyMarkdown: "First   line\n\nsecond line",
  author: { kind: "user" },
  createdAt: "2026-08-31T14:00:00.000Z",
};

const agentUpdate: TicketStatusUpdate = {
  id: "update-2",
  ticketId: "ticket-1",
  bodyMarkdown: "Agent report",
  author: {
    kind: "agent",
    conversationId: "conversation-2",
    conversationName: "Implement tickets",
    projectName: "cc",
    scope: "session",
    sessionName: "ticket-work",
    backend: "codex",
    redactedProfileSnapshot: null,
  },
  createdAt: "2026-08-31T15:00:00.000Z",
};

const detail: TicketDetail = {
  id: "ticket-1",
  projectPath: "/repos/cc",
  projectName: "cc",
  number: 12,
  title: "Implement ticket relationships",
  description: "Ticket description",
  workType: "feature",
  status: "in_progress",
  createdAt: "2026-08-31T10:00:00.000Z",
  updatedAt: "2026-08-31T15:00:00.000Z",
  attachments: [],
  sessions: [],
  relationships: [relationship],
  statusUpdates: { total: 3, recent: [agentUpdate, userUpdate] },
};

describe("ticket disclosure command builders", () => {
  it("preserves every active page filter in ticket continuations", () => {
    expect(
      relationshipListCommand("other repo#12", {
        role: "depends_on",
        limit: 37,
        cursor: "opaque_cursor",
      }),
    ).toBe(
      "cctl ticket relation list --role=depends_on --limit=37 --cursor=opaque_cursor -- 'other repo#12'",
    );
    expect(
      statusUpdateListCommand("other repo#12", {
        limit: 40,
        cursor: "opaque_cursor",
      }),
    ).toBe(
      "cctl ticket status-update list --limit=40 --cursor=opaque_cursor -- 'other repo#12'",
    );
  });
});

describe("ticket bounded outline projections", () => {
  it("normalizes bounded previews and retains stable get handles", () => {
    const relationOutline = buildRelationshipOutline(relationship, "cc#12");
    expect(relationOutline).toEqual({
      id: "rel-1",
      role: "depends_on",
      otherTicket: "other repo#7",
      otherStatus: "in_progress",
      otherTitle: "Ship the prerequisite",
      descriptionPreview: "Needs the API contract first",
      updatedAt: "2026-08-31T13:00:00.000Z",
      getCommand: "cctl ticket relation get -- 'cc#12' rel-1",
    });

    const updateOutline = buildStatusUpdateOutline(agentUpdate, "cc#12");
    expect(updateOutline).toEqual({
      id: "update-2",
      createdAt: "2026-08-31T15:00:00.000Z",
      authorKind: "agent",
      authorLabel: "Agent",
      backend: "codex",
      conversationId: "conversation-2",
      bodyPreview: "Agent report",
      getCommand: "cctl ticket status-update get -- 'cc#12' update-2",
    });
  });

  it("keeps full Markdown fields structurally absent from strict outline schemas", () => {
    const relationOutline = buildRelationshipOutline(relationship, "cc#12");
    expect(
      ticketRelationshipOutlineSchema.safeParse({
        ...relationOutline,
        description: relationship.description,
      }).success,
    ).toBe(false);

    const updateOutline = buildStatusUpdateOutline(userUpdate, "cc#12");
    expect(
      ticketStatusUpdateOutlineSchema.safeParse({
        ...updateOutline,
        bodyMarkdown: userUpdate.bodyMarkdown,
      }).success,
    ).toBe(false);
  });

  it("builds primary list metadata and exact cursor continuations", () => {
    const relationProjection = buildRelationshipPageProjection(
      {
        items: [relationship],
        total: 4,
        nextCursor: "next_relation",
      },
      "cc#12",
      { role: "depends_on", limit: 1, cursor: "previous" },
    );
    expect(relationProjection).toMatchObject({
      total: 4,
      returned: 1,
      truncated: true,
      next: {
        cursor: "next_relation",
        command:
          "cctl ticket relation list --role=depends_on --limit=1 --cursor=next_relation -- 'cc#12'",
      },
    });
    expect(renderRelationshipPageText(relationProjection)).toContain(
      "relationships: total=4 returned=1 truncated=true — next: cctl ticket relation list --role=depends_on --limit=1 --cursor=next_relation -- 'cc#12'",
    );

    const updateProjection = buildStatusUpdatePageProjection(
      { items: [agentUpdate], total: 3, nextCursor: "next_update" },
      "cc#12",
      { limit: 1, cursor: "previous" },
    );
    expect(updateProjection).toMatchObject({
      total: 3,
      returned: 1,
      truncated: true,
      next: {
        cursor: "next_update",
        command:
          "cctl ticket status-update list --limit=1 --cursor=next_update -- 'cc#12'",
      },
    });
    expect(renderStatusUpdatePageText(updateProjection)).toContain(
      "status updates: total=3 returned=1 truncated=true — next: cctl ticket status-update list --limit=1 --cursor=next_update -- 'cc#12'",
    );

    const completeRelation = buildRelationshipPageProjection(
      { items: [relationship], total: 1, nextCursor: null },
      "cc#12",
      { limit: 20 },
    );
    expect(renderRelationshipPageText(completeRelation)).toContain(
      "relationships: total=1 returned=1 truncated=false",
    );
    const completeUpdate = buildStatusUpdatePageProjection(
      { items: [agentUpdate], total: 1, nextCursor: null },
      "cc#12",
      { limit: 20 },
    );
    expect(renderStatusUpdatePageText(completeUpdate)).toContain(
      "status updates: total=1 returned=1 truncated=false",
    );
  });

  it("groups ticket-get relationships in domain order and caps them at twenty", () => {
    const roles: TicketRelationshipView["role"][] = [
      "related",
      "blocks",
      "depends_on",
      "child",
      "parent",
    ];
    const relationships = Array.from({ length: 25 }, (_unused, index) => ({
      ...relationship,
      id: `rel-${String(index).padStart(2, "0")}`,
      role: roles[index % roles.length] ?? "related",
      updatedAt: `2026-08-31T13:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    const projection = buildTicketGetProjection(
      { ...detail, relationships },
      [],
    );
    const parsed = ticketGetProjectionSchema.parse(projection);

    expect(parsed.ticket.relationships.returned).toBe(20);
    expect(parsed.ticket.relationships.total).toBe(25);
    expect(parsed.ticket.relationships.truncated).toBe(true);
    if (!parsed.ticket.relationships.truncated) {
      throw new Error("expected the relationship outline to be truncated");
    }
    expect(parsed.ticket.relationships.next).toEqual({
      cursor: null,
      command: "cctl ticket relation list --limit=20 -- 'cc#12'",
    });
    expect(parsed.ticket.relationships.items.map((item) => item.role)).toEqual([
      ...Array(5).fill("parent"),
      ...Array(5).fill("child"),
      ...Array(5).fill("depends_on"),
      ...Array(5).fill("blocks"),
    ]);
  });

  it("replaces raw ticket detail bodies with bounded JSON projections", () => {
    const longRationale = "rationale secret ".repeat(30);
    const longBody = "body secret ".repeat(30);
    const projection = buildTicketGetProjection(
      {
        ...detail,
        relationships: [{ ...relationship, description: longRationale }],
        statusUpdates: {
          total: 2,
          recent: [{ ...agentUpdate, bodyMarkdown: longBody }],
        },
      },
      [],
    );
    const serialized = JSON.stringify(projection);

    expect(serialized).not.toContain(longRationale);
    expect(serialized).not.toContain(longBody);
    expect(projection).toMatchObject({
      ticket: {
        relationships: {
          total: 1,
          returned: 1,
          truncated: false,
        },
        statusUpdates: {
          total: 2,
          returned: 1,
          truncated: true,
          next: {
            cursor: null,
            command: "cctl ticket status-update list --limit=20 -- 'cc#12'",
          },
        },
      },
    });
  });

  it("rejects inconsistent omission metadata", () => {
    expect(
      ticketDisclosureMetadataSchema.safeParse({
        total: 2,
        returned: 1,
        truncated: true,
      }).success,
    ).toBe(false);
    expect(
      ticketDisclosureMetadataSchema.safeParse({
        total: 1,
        returned: 1,
        truncated: false,
        next: { cursor: null, command: "cctl ticket get 'cc#12'" },
      }).success,
    ).toBe(false);
  });
});
