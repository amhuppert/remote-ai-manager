import { describe, expect, it } from "vitest";
import {
  conversationAttachmentPayloadSchema,
  createTicketResponseSchema,
  createTicketInputSchema,
  effectiveSnapshotStatus,
  quickTicketDiagnosticsSchema,
  resolvedAttachmentSchema,
  ticketAttachmentPayloadSchema,
  ticketAttachmentSchema,
  ticketChangedEventSchema,
  ticketDetailSchema,
  ticketErrorSchema,
  ticketIdentitySchema,
  ticketListItemSchema,
  ticketListQuerySchema,
  ticketSchema,
  ticketSessionLinkSchema,
  ticketStatusSchema,
  ticketWorkTypeSchema,
} from "./schemas";

const validTicket = {
  id: "t-1",
  projectPath: "/repos/command-center",
  number: 12,
  title: "Add durable ticket context",
  description: "",
  workType: "feature",
  status: "not_started",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
} as const;

const validListItem = {
  id: "t-1",
  projectPath: "/repos/command-center",
  projectName: "command-center",
  number: 12,
  title: "Add durable ticket context",
  workType: "feature",
  status: "not_started",
  attachmentCount: 0,
  activeSessionName: null,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
} as const;

const filePayload = {
  kind: "file",
  fileName: "notes.md",
  snapshotKey: "ticket-content/t-1/a-1/notes.md",
  mediaType: "text/markdown",
  sizeBytes: 128,
  sha256: "abc123",
} as const;

describe("ticket enums", () => {
  it.each(["feature", "bug", "research", "tech_debt", "performance"] as const)(
    "accepts work type %s",
    (workType) => {
      expect(ticketWorkTypeSchema.safeParse(workType).success).toBe(true);
    },
  );

  it.each(["epic", "Feature", "chore", ""])(
    "rejects work type %j",
    (workType) => {
      expect(ticketWorkTypeSchema.safeParse(workType).success).toBe(false);
    },
  );

  it.each(["not_started", "in_progress", "done", "blocked", "closed"] as const)(
    "accepts status %s",
    (status) => {
      expect(ticketStatusSchema.safeParse(status).success).toBe(true);
    },
  );

  it.each(["archived", "Not Started", "open", ""])(
    "rejects status %j",
    (status) => {
      expect(ticketStatusSchema.safeParse(status).success).toBe(false);
    },
  );
});

describe("ticket entity", () => {
  it("parses a fully specified ticket", () => {
    expect(ticketSchema.parse(validTicket)).toEqual(validTicket);
  });

  it("requires an explicit status on the persisted entity (effect-free row schema)", () => {
    const withoutStatus: Record<string, unknown> = { ...validTicket };
    delete withoutStatus.status;
    expect(ticketSchema.safeParse(withoutStatus).success).toBe(false);
  });

  it("rejects a non-positive ticket number", () => {
    expect(ticketSchema.safeParse({ ...validTicket, number: 0 }).success).toBe(
      false,
    );
  });
});

describe("createTicketInput", () => {
  it("defaults status to not_started and description to empty when unspecified", () => {
    const parsed = createTicketInputSchema.parse({
      title: "Fix flaky merge",
      workType: "bug",
    });
    expect(parsed.status).toBe("not_started");
    expect(parsed.description).toBe("");
  });

  it("keeps an explicitly provided status", () => {
    const parsed = createTicketInputSchema.parse({
      title: "Fix flaky merge",
      workType: "bug",
      status: "blocked",
    });
    expect(parsed.status).toBe("blocked");
  });

  it("rejects an empty title via safeParse without throwing", () => {
    const result = createTicketInputSchema.safeParse({
      title: "",
      workType: "bug",
    });
    expect(result.success).toBe(false);
  });

  it("accepts cross-project conversation context and bounded diagnostics", () => {
    const parsed = createTicketInputSchema.parse({
      title: "Quick ticket loses the active pane",
      workType: "bug",
      conversationContext: {
        sourceProjectName: "observed-project",
        sessionName: null,
        conversationId: "conv-1",
        title: "Conversation title",
      },
      diagnostics: makeDiagnostics(),
      autoStartRequested: true,
    });

    expect(parsed.conversationContext?.sourceProjectName).toBe(
      "observed-project",
    );
    expect(parsed.diagnostics?.screenshot?.mediaType).toBe("image/png");
    expect(parsed.autoStartRequested).toBe(true);
  });

  it("rejects diagnostics for non-bug tickets", () => {
    const result = createTicketInputSchema.safeParse({
      title: "Feature with a diagnostic bundle",
      workType: "feature",
      diagnostics: makeDiagnostics(),
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["diagnostics"],
        message: "diagnostics are only available for bug tickets",
      }),
    );
  });
});

describe("attachment payload union", () => {
  it("accepts a file payload", () => {
    expect(ticketAttachmentPayloadSchema.parse(filePayload)).toEqual(
      filePayload,
    );
  });

  it("accepts a conversation payload", () => {
    const payload = {
      kind: "conversation",
      projectPath: "/repos/command-center",
      sessionName: "csm/ticket-work",
      conversationId: "c-9",
      snapshotKey: "ticket-content/t-1/a-2/compaction.md",
      snapshotCapturedAt: "2026-07-10T00:00:00.000Z",
    };
    expect(ticketAttachmentPayloadSchema.parse(payload)).toEqual(payload);
  });

  it.each([
    {
      label: "legacy captured",
      payload: {
        snapshotKey: "ticket-content/t-1/a-2/compaction.md",
        snapshotCapturedAt: "2026-07-10T00:00:00.000Z",
      },
      effective: "captured",
    },
    {
      label: "explicit captured",
      payload: {
        snapshotKey: "ticket-content/t-1/a-2/compaction.md",
        snapshotCapturedAt: "2026-07-10T00:00:00.000Z",
        snapshotStatus: "captured",
      },
      effective: "captured",
    },
    {
      label: "pending",
      payload: {
        snapshotKey: null,
        snapshotCapturedAt: null,
        snapshotStatus: "pending",
      },
      effective: "pending",
    },
    {
      label: "failed",
      payload: {
        snapshotKey: null,
        snapshotCapturedAt: null,
        snapshotStatus: "failed",
        snapshotError: "Conversation snapshot could not be captured.",
      },
      effective: "failed",
    },
  ] as const)("accepts the $label conversation snapshot state", (fixture) => {
    const payload = conversationAttachmentPayloadSchema.parse({
      kind: "conversation",
      projectPath: "/repos/command-center",
      sessionName: "csm/ticket-work",
      conversationId: "c-9",
      ...fixture.payload,
    });

    expect(effectiveSnapshotStatus(payload)).toBe(fixture.effective);
  });

  it.each([
    {
      snapshotKey: null,
      snapshotCapturedAt: null,
    },
    {
      snapshotKey: "ticket-content/t-1/a-2/compaction.md",
      snapshotCapturedAt: "2026-07-10T00:00:00.000Z",
      snapshotStatus: "pending",
    },
    {
      snapshotKey: null,
      snapshotCapturedAt: null,
      snapshotStatus: "failed",
    },
    {
      snapshotKey: null,
      snapshotCapturedAt: null,
      snapshotStatus: "pending",
      snapshotError: "not allowed",
    },
    {
      snapshotKey: "ticket-content/t-1/a-2/compaction.md",
      snapshotCapturedAt: "2026-07-10T00:00:00.000Z",
      snapshotStatus: "captured",
      snapshotError: "not allowed",
    },
  ])("rejects an impossible conversation snapshot state %#", (state) => {
    expect(
      conversationAttachmentPayloadSchema.safeParse({
        kind: "conversation",
        projectPath: "/repos/command-center",
        sessionName: null,
        conversationId: "c-9",
        ...state,
      }).success,
    ).toBe(false);
  });

  it("accepts a session payload", () => {
    const payload = {
      kind: "session",
      projectPath: "/repos/command-center",
      sessionName: "csm/ticket-work",
    };
    expect(ticketAttachmentPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("accepts a related_ticket payload", () => {
    const payload = {
      kind: "related_ticket",
      ticketId: "t-2",
      identifierSnapshot: "command-center#13",
    };
    expect(ticketAttachmentPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("accepts a note payload", () => {
    const payload = { kind: "note", markdown: "## context" };
    expect(ticketAttachmentPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("rejects an unknown kind", () => {
    expect(
      ticketAttachmentPayloadSchema.safeParse({ kind: "url", href: "http://x" })
        .success,
    ).toBe(false);
  });

  it("rejects a mixed payload carrying another kind's fields", () => {
    expect(
      ticketAttachmentPayloadSchema.safeParse({
        kind: "note",
        markdown: "## context",
        fileName: "notes.md",
      }).success,
    ).toBe(false);
  });

  it("rejects a payload whose kind does not match its fields", () => {
    expect(
      ticketAttachmentPayloadSchema.safeParse({
        kind: "file",
        markdown: "## context",
      }).success,
    ).toBe(false);
  });
});

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function makeDiagnostics() {
  return {
    capturedAt: "2026-07-19T12:00:00.000Z",
    route: {
      url: "/projects/observed/session?c=conv-1",
      viewState: "pane=chat; activeTab=conversation",
    },
    identities: {
      projectName: "observed",
      sessionName: "session",
      conversationId: "conv-1",
      workflowExecutionId: "workflow-1",
      deepLinks: [
        {
          label: "Conversation",
          href: "/projects/observed/session?c=conv-1",
        },
      ],
    },
    clientErrors: [
      {
        ts: "2026-07-19T11:59:00.000Z",
        kind: "console" as const,
        message: "Request failed",
        stackHead: ["at submit (QuickTicketDialog.tsx:1:1)"],
      },
    ],
    screenshot: {
      mediaType: "image/png" as const,
      base64: ONE_PIXEL_PNG_BASE64,
      width: 1,
      height: 1,
    },
    removed: ["build"] as const,
  };
}

describe("quickTicketDiagnosticsSchema", () => {
  it("accepts bounded, canonical diagnostic facts", () => {
    expect(quickTicketDiagnosticsSchema.parse(makeDiagnostics())).toEqual(
      makeDiagnostics(),
    );
  });

  it("rejects duplicate removed bundle keys", () => {
    expect(
      quickTicketDiagnosticsSchema.safeParse({
        ...makeDiagnostics(),
        removed: ["build", "build"],
      }).success,
    ).toBe(false);
  });

  it("rejects mismatched screenshot magic bytes", () => {
    expect(
      quickTicketDiagnosticsSchema.safeParse({
        ...makeDiagnostics(),
        screenshot: {
          ...makeDiagnostics().screenshot,
          mediaType: "image/webp",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects oversized client-error collections and fields", () => {
    const error = makeDiagnostics().clientErrors[0];
    expect(
      quickTicketDiagnosticsSchema.safeParse({
        ...makeDiagnostics(),
        clientErrors: Array.from({ length: 26 }, () => error),
      }).success,
    ).toBe(false);
    expect(
      quickTicketDiagnosticsSchema.safeParse({
        ...makeDiagnostics(),
        clientErrors: [{ ...error, message: "x".repeat(501) }],
      }).success,
    ).toBe(false);
  });
});

describe("createTicketResponseSchema", () => {
  it("keeps the created detail and safe warnings in separate fields", () => {
    const response = createTicketResponseSchema.parse({
      ticket: {
        ...validTicket,
        projectName: "command-center",
        attachments: [],
        sessions: [],
      },
      warnings: [
        {
          code: "conversation_source_unavailable",
          message: "Conversation context was omitted.",
        },
      ],
    });

    expect(response.ticket.id).toBe("t-1");
    expect(response.warnings[0]?.code).toBe("conversation_source_unavailable");
  });
});

describe("ticket attachment", () => {
  const validAttachment = {
    id: "a-1",
    ticketId: "t-1",
    description: "Design notes captured before kickoff",
    payload: filePayload,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };

  it("parses a valid attachment", () => {
    expect(ticketAttachmentSchema.parse(validAttachment)).toEqual(
      validAttachment,
    );
  });

  it.each(["", "   "])("rejects the empty description %j", (description) => {
    expect(
      ticketAttachmentSchema.safeParse({ ...validAttachment, description })
        .success,
    ).toBe(false);
  });
});

describe("session link", () => {
  const activeLink = {
    id: "l-1",
    ticketId: "t-1",
    projectPath: "/repos/command-center",
    sessionName: "csm/ticket-work",
    sessionCreatedAt: "2026-07-09T23:59:59.000Z",
    startMode: "agent",
    linkedAt: "2026-07-10T00:00:00.000Z",
    endedAt: null,
    endReason: null,
  };

  it("parses an active link", () => {
    expect(ticketSessionLinkSchema.parse(activeLink)).toEqual(activeLink);
  });

  it("parses a demoted historical link with a reason", () => {
    const historical = {
      ...activeLink,
      endedAt: "2026-07-10T01:00:00.000Z",
      endReason: "replaced",
    };
    expect(ticketSessionLinkSchema.parse(historical)).toEqual(historical);
  });

  it("parses an unknown legacy incarnation as null", () => {
    const legacy = { ...activeLink, sessionCreatedAt: null };
    expect(ticketSessionLinkSchema.parse(legacy)).toEqual(legacy);
  });

  it("rejects an unknown end reason", () => {
    expect(
      ticketSessionLinkSchema.safeParse({
        ...activeLink,
        endedAt: "2026-07-10T01:00:00.000Z",
        endReason: "abandoned",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown start mode", () => {
    expect(
      ticketSessionLinkSchema.safeParse({ ...activeLink, startMode: "manual" })
        .success,
    ).toBe(false);
  });
});

describe("list item and detail", () => {
  it("parses a list item", () => {
    expect(ticketListItemSchema.parse(validListItem)).toEqual(validListItem);
  });

  it("parses a detail with attachments and session history", () => {
    const detail = {
      ...validTicket,
      projectName: "command-center",
      attachments: [
        {
          id: "a-1",
          ticketId: "t-1",
          description: "Kickoff note",
          payload: { kind: "note", markdown: "## context" },
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
        },
      ],
      sessions: [
        {
          id: "l-1",
          ticketId: "t-1",
          projectPath: "/repos/command-center",
          sessionName: "csm/ticket-work",
          sessionCreatedAt: "2026-07-09T23:59:59.000Z",
          startMode: "prepared",
          linkedAt: "2026-07-10T00:00:00.000Z",
          endedAt: "2026-07-10T01:00:00.000Z",
          endReason: "finished",
        },
      ],
    };
    expect(ticketDetailSchema.parse(detail)).toEqual(detail);
  });
});

describe("list query", () => {
  it("defaults sort to updated", () => {
    expect(ticketListQuerySchema.parse({})).toEqual({ sort: "updated" });
  });

  it("accepts field-equality filters", () => {
    const query = {
      projectPath: "/repos/command-center",
      status: "in_progress",
      workType: "bug",
      sort: "created",
    };
    expect(ticketListQuerySchema.parse(query)).toEqual(query);
  });

  it("rejects an unknown sort field via safeParse without throwing", () => {
    const result = ticketListQuerySchema.safeParse({ sort: "priority" });
    expect(result.success).toBe(false);
  });
});

describe("ticket identity", () => {
  it("parses a project name + number identity", () => {
    expect(
      ticketIdentitySchema.parse({ projectName: "command-center", number: 12 }),
    ).toEqual({ projectName: "command-center", number: 12 });
  });

  it("rejects a fractional number", () => {
    expect(
      ticketIdentitySchema.safeParse({
        projectName: "command-center",
        number: 1.5,
      }).success,
    ).toBe(false);
  });
});

describe("ticket error union", () => {
  it("parses ticket_not_found", () => {
    const error = { code: "ticket_not_found", identifier: "command-center#99" };
    expect(ticketErrorSchema.parse(error)).toEqual(error);
  });

  it("parses validation_failed with issues", () => {
    const error = {
      code: "validation_failed",
      issues: [{ path: "workType", message: "invalid work type" }],
    };
    expect(ticketErrorSchema.parse(error)).toEqual(error);
  });

  it("rejects an unknown error code", () => {
    expect(
      ticketErrorSchema.safeParse({ code: "boom", reason: "x" }).success,
    ).toBe(false);
  });
});

describe("ticket-changed event", () => {
  const createdEvent = {
    type: "ticket-changed",
    change: "created",
    projectName: "command-center",
    ticketNumber: 12,
    listItem: validListItem,
    attachmentIndexChanged: false,
  };

  it("parses a created event carrying the lean list item", () => {
    expect(ticketChangedEventSchema.parse(createdEvent)).toEqual(createdEvent);
  });

  it("parses a deleted event with a null list item", () => {
    const deleted = { ...createdEvent, change: "deleted", listItem: null };
    expect(ticketChangedEventSchema.parse(deleted)).toEqual(deleted);
  });

  it("parses a session change carrying the linked session name", () => {
    const session = {
      ...createdEvent,
      change: "session",
      linkedSessionName: "csm/ticket-work",
    };
    expect(ticketChangedEventSchema.parse(session)).toEqual(session);
  });

  it("rejects an unknown change kind", () => {
    expect(
      ticketChangedEventSchema.safeParse({ ...createdEvent, change: "renamed" })
        .success,
    ).toBe(false);
  });

  it("is strict: rejects unknown extra keys so the envelope owns _sentAt", () => {
    expect(
      ticketChangedEventSchema.safeParse({ ...createdEvent, _sentAt: 123 })
        .success,
    ).toBe(false);
  });
});

describe("resolvedAttachmentSchema", () => {
  const attachment = {
    id: "a-1",
    ticketId: "t-1",
    description: "API contract notes",
    payload: filePayload,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
  const detail = {
    ...validTicket,
    projectName: "command-center",
    attachments: [],
    sessions: [],
  };

  it.each([
    [
      "file",
      {
        kind: "file",
        attachment,
        fileName: "notes.md",
        mediaType: "text/markdown",
        sizeBytes: 128,
        sha256: "abc123",
        encoding: "utf8",
        content: "# Notes",
      },
    ],
    [
      "conversation",
      {
        kind: "conversation",
        attachment,
        conversationId: "conv-1",
        sessionName: null,
        source: "retained_compaction",
        sourceAvailable: false,
        markdown: "## Compaction",
        capturedAt: "2026-07-10T00:00:00.000Z",
        readCommands: ["cctl conversation get conv-1"],
      },
    ],
    [
      "session",
      {
        kind: "session",
        attachment,
        projectName: "command-center",
        sessionName: "csm/spike",
        finished: true,
        conversationIds: ["conv-1", "conv-2"],
        readCommands: [],
      },
    ],
    [
      "available related ticket",
      {
        kind: "related_ticket",
        attachment,
        available: true,
        ticket: detail,
        followCommand: "cctl ticket get command-center#12",
      },
    ],
    [
      "unavailable related ticket",
      {
        kind: "related_ticket",
        attachment,
        available: false,
        identifierSnapshot: "command-center#9",
      },
    ],
    ["note", { kind: "note", attachment, markdown: "remember this" }],
  ])("accepts a resolved %s", (_label, resolved) => {
    expect(resolvedAttachmentSchema.safeParse(resolved).success).toBe(true);
  });

  it("rejects an unavailable related ticket that claims availability", () => {
    expect(
      resolvedAttachmentSchema.safeParse({
        kind: "related_ticket",
        attachment,
        available: true,
        identifierSnapshot: "command-center#9",
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      state: "pending",
      attachment: {
        ...attachment,
        payload: {
          kind: "conversation",
          projectPath: "/repos/source",
          sessionName: null,
          conversationId: "conv-1",
          snapshotKey: null,
          snapshotCapturedAt: null,
          snapshotStatus: "pending",
        },
      },
      conversationId: "conv-1",
      sessionName: null,
      retryCommand: "cctl ticket attachment refresh command-center#12 a-1",
    },
    {
      state: "failed",
      attachment: {
        ...attachment,
        payload: {
          kind: "conversation",
          projectPath: "/repos/source",
          sessionName: "session",
          conversationId: "conv-1",
          snapshotKey: null,
          snapshotCapturedAt: null,
          snapshotStatus: "failed",
          snapshotError: "Conversation snapshot could not be captured.",
        },
      },
      conversationId: "conv-1",
      sessionName: "session",
      error: "Conversation snapshot could not be captured.",
      retryCommand: "cctl ticket attachment refresh command-center#12 a-1",
    },
  ] as const)("accepts a resolved conversation in $state state", (resolved) => {
    expect(
      resolvedAttachmentSchema.safeParse({
        kind: "conversation",
        ...resolved,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(
      resolvedAttachmentSchema.safeParse({ kind: "url", attachment }).success,
    ).toBe(false);
  });
});
