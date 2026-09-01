import { describe, expect, it } from "vitest";
import type {
  TicketDetail,
  TicketRelationshipView,
  TicketStatusUpdate,
} from "@/lib/tickets/schemas";
import type { CliHost } from "../shared";
import {
  buildRelationshipOutline,
  buildRelationshipPageProjection,
  buildStatusUpdateOutline,
  buildStatusUpdatePageProjection,
  buildTicketGetProjection,
  emitTicketDisclosure,
  relationshipGetCommand,
  relationshipListCommand,
  renderRelationshipPageText,
  renderStatusUpdatePageText,
  statusUpdateGetCommand,
  statusUpdateListCommand,
  ticketDisclosureMetadataSchema,
  ticketGetProjectionSchema,
  ticketRelationshipOutlineSchema,
  ticketStatusUpdateOutlineSchema,
} from "./ticket-disclosure";

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

function host(
  writeTextFile?: (path: string, content: string) => Promise<void>,
): CliHost {
  return {
    async fetch() {
      throw new Error("network is outside disclosure tests");
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    ...(writeTextFile === undefined ? {} : { writeTextFile }),
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

describe("ticket disclosure command builders", () => {
  it("shell-quotes stable handles and preserves every active page filter", () => {
    expect(relationshipGetCommand("other repo#12", "rel $1")).toBe(
      "cctl ticket relation get 'other repo#12' 'rel $1'",
    );
    expect(statusUpdateGetCommand("other repo#12", "update $1")).toBe(
      "cctl ticket status-update get 'other repo#12' 'update $1'",
    );
    expect(
      relationshipListCommand("other repo#12", {
        role: "depends_on",
        limit: 37,
        cursor: "opaque_cursor",
      }),
    ).toBe(
      "cctl ticket relation list 'other repo#12' --role depends_on --limit 37 --cursor 'opaque_cursor'",
    );
    expect(
      statusUpdateListCommand("other repo#12", {
        limit: 40,
        cursor: "opaque_cursor",
      }),
    ).toBe(
      "cctl ticket status-update list 'other repo#12' --limit 40 --cursor 'opaque_cursor'",
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
      getCommand: "cctl ticket relation get 'cc#12' 'rel-1'",
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
      getCommand: "cctl ticket status-update get 'cc#12' 'update-2'",
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
          "cctl ticket relation list 'cc#12' --role depends_on --limit 1 --cursor 'next_relation'",
      },
    });
    expect(renderRelationshipPageText(relationProjection)).toContain(
      "relationships: total=4 returned=1 truncated=true — next: cctl ticket relation list 'cc#12' --role depends_on --limit 1 --cursor 'next_relation'",
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
          "cctl ticket status-update list 'cc#12' --limit 1 --cursor 'next_update'",
      },
    });
    expect(renderStatusUpdatePageText(updateProjection)).toContain(
      "status updates: total=3 returned=1 truncated=true — next: cctl ticket status-update list 'cc#12' --limit 1 --cursor 'next_update'",
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
      role: roles[index % roles.length]!,
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
      command: "cctl ticket relation list 'cc#12' --limit 20",
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
            command: "cctl ticket status-update list 'cc#12' --limit 20",
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

describe("ticket disclosure stdout budget", () => {
  it("keeps content below 60,000 UTF-8 bytes inline", async () => {
    const writes: string[] = [];
    const result = await emitTicketDisclosure({
      host: host(async (_path, content) => {
        writes.push(content);
      }),
      json: false,
      command: "ticket relation get",
      namePrefix: "ticket-relation",
      text: "x".repeat(59_999),
      payload: { relationship: { id: "rel-1" } },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(59_999);
    expect(writes).toEqual([]);
  });

  it("spills text at 60,000 bytes and returns only an artifact receipt", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const body = "sensitive rationale ".repeat(3_000);
    const result = await emitTicketDisclosure({
      host: host(async (path, content) => {
        writes.push({ path, content });
      }),
      json: false,
      command: "ticket relation get",
      namePrefix: "ticket-relation",
      text: body,
      payload: { relationship: { description: body } },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("artifact:");
    expect(result.stdout).not.toContain("sensitive rationale");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.content).toBe(body);
  });

  it("measures JSON independently so structured output cannot bypass the budget", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const body = "sensitive update ".repeat(4_000);
    const result = await emitTicketDisclosure({
      host: host(async (path, content) => {
        writes.push({ path, content });
      }),
      json: true,
      command: "ticket status-update get",
      namePrefix: "ticket-update",
      text: "short text mode",
      payload: { update: { bodyMarkdown: body } },
    });

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      ok: true,
      command: "ticket status-update get",
      storage: "artifact",
      artifact: { reason: "stdout_budget_exceeded", format: "json" },
    });
    expect(result.stdout).not.toContain("sensitive update");
    expect(writes[0]?.content).toContain(body);
  });

  it("refuses unavailable and failed artifact writes without dumping content", async () => {
    const unavailable = await emitTicketDisclosure({
      host: host(),
      json: true,
      command: "ticket get",
      namePrefix: "ticket-get",
      text: "short text mode",
      payload: { ticket: { description: "x".repeat(60_000) } },
    });
    expect(unavailable.exitCode).toBe(1);
    expect(JSON.parse(unavailable.stdout).code).toBe("write_unavailable");

    const failed = await emitTicketDisclosure({
      host: host(async () => {
        throw new Error("disk full");
      }),
      json: false,
      command: "ticket get",
      namePrefix: "ticket-get",
      text: "x".repeat(60_000),
      payload: {},
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("could not write");
    expect(failed.stdout).not.toContain("x".repeat(100));
  });
});
