import { describe, expect, it, vi } from "vitest";
import type { QuickTicketDiagnostics, TicketDetail } from "./schemas";
import {
  createCreateAttachmentPlanner,
  type CreateAttachmentPlannerDeps,
} from "./create-attachment-planner";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function diagnostics(
  overrides: Partial<QuickTicketDiagnostics> = {},
): QuickTicketDiagnostics {
  return {
    capturedAt: "2026-07-19T12:00:00.000Z",
    route: {
      url: "/projects/source/work?c=conv-1",
      viewState: "pane=chat",
    },
    identities: {
      projectName: "source",
      sessionName: "work",
      conversationId: "conv-1",
      deepLinks: [],
    },
    clientErrors: [],
    screenshot: {
      mediaType: "image/png",
      base64: ONE_PIXEL_PNG_BASE64,
      width: 1,
      height: 1,
    },
    removed: [],
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<CreateAttachmentPlannerDeps> = {},
): CreateAttachmentPlannerDeps {
  let id = 0;
  return {
    async resolveAvailableProjectPath(projectName) {
      return projectName === "source" ? "/repos/source" : null;
    },
    async conversationExists() {
      return true;
    },
    async captureScreenshot(input) {
      return {
        snapshotKey: `${input.ticketId}/${input.attachmentId}/${input.fileName}`,
        fileName: input.fileName,
        sizeBytes: input.bytes.byteLength,
        sha256: "screenshot-sha",
      };
    },
    async deleteSnapshot() {},
    diagnosticEnvironment() {
      return {
        sha: "abc123",
        buildTime: "2026-07-19T10:00:00.000Z",
        appVersion: "0.1.0",
        platform: "darwin-arm64-node22.11.0",
      };
    },
    scheduleConversationSnapshotRefresh() {},
    async prepareEnrichment() {
      return {
        status: "ready",
        backend: "codex",
        modelSelection: { modelId: "gpt-5.4", parameters: {} },
      };
    },
    scheduleEnrichment() {},
    generateId() {
      id += 1;
      return `attachment-${id}`;
    },
    now() {
      return "2026-07-19T12:00:01.000Z";
    },
    ...overrides,
  };
}

function ticketForPlan(attachments: TicketDetail["attachments"]): TicketDetail {
  return {
    id: "ticket-1",
    projectPath: "/repos/source",
    projectName: "source",
    number: 1,
    title: "Bug",
    description: "",
    workType: "bug",
    status: "not_started",
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    attachments,
    sessions: [],
    relationships: [],
    statusUpdates: { total: 0, recent: [] },
  };
}

describe("createCreateAttachmentPlanner", () => {
  it("keeps attachments and warns when optional enrichment cannot run", async () => {
    const scheduleEnrichment =
      vi.fn<CreateAttachmentPlannerDeps["scheduleEnrichment"]>();
    const plan = await createCreateAttachmentPlanner(
      makeDeps({
        scheduleEnrichment,
        async prepareEnrichment() {
          return {
            status: "unavailable",
            warning: {
              code: "enrichment_unavailable",
              message:
                "Ticket created. Automatic enrichment is unavailable with Cursor.",
            },
          };
        },
      }),
    ).plan({ ticketId: "ticket-1", diagnostics: diagnostics() });
    expect(plan.warnings).toMatchObject([{ code: "enrichment_unavailable" }]);
    expect(plan.attachments.map((a) => a.payload.kind)).toEqual([
      "note",
      "file",
    ]);
    plan.afterCommit(ticketForPlan(plan.attachments));
    expect(scheduleEnrichment).not.toHaveBeenCalled();
  });
  it("schedules the selection captured before commit even if preparation later changes", async () => {
    const scheduleEnrichment =
      vi.fn<CreateAttachmentPlannerDeps["scheduleEnrichment"]>();
    let backend: "codex" | "cursor" = "codex";
    const prepareEnrichment = vi.fn<
      CreateAttachmentPlannerDeps["prepareEnrichment"]
    >(async () => ({
      status: "ready",
      backend,
      modelSelection: {
        modelId: "captured-model",
        parameters: { fast: "false" },
      },
    }));
    const plan = await createCreateAttachmentPlanner(
      makeDeps({ prepareEnrichment, scheduleEnrichment }),
    ).plan({ ticketId: "ticket-1", diagnostics: diagnostics() });
    backend = "cursor";
    plan.afterCommit(ticketForPlan(plan.attachments));
    expect(prepareEnrichment).toHaveBeenCalledTimes(1);
    expect(scheduleEnrichment).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        modelSelection: {
          modelId: "captured-model",
          parameters: { fast: "false" },
        },
      }),
    );
  });

  it("plans report, screenshot, and pending conversation in deterministic order", async () => {
    const planner = createCreateAttachmentPlanner(makeDeps());

    const plan = await planner.plan({
      ticketId: "ticket-1",
      conversationContext: {
        sourceProjectName: "source",
        sessionName: "work",
        conversationId: "conv-1",
        title: "Observed conversation",
      },
      diagnostics: diagnostics(),
    });

    expect(plan.warnings).toEqual([]);
    expect(
      plan.attachments.map((attachment) => attachment.payload.kind),
    ).toEqual(["note", "file", "conversation"]);
    expect(plan.attachments.map((attachment) => attachment.createdAt)).toEqual([
      "2026-07-19T12:00:01.000Z",
      "2026-07-19T12:00:01.001Z",
      "2026-07-19T12:00:01.002Z",
    ]);
    expect(plan.pendingConversationAttachmentIds).toEqual(["attachment-3"]);
    expect(plan.attachments[0]?.payload).toMatchObject({
      kind: "note",
      markdown: expect.stringContaining("Command Center diagnostic report"),
    });
    expect(plan.attachments[1]?.payload).toEqual({
      kind: "file",
      fileName: "diagnostic-screenshot.png",
      snapshotKey: "ticket-1/attachment-2/diagnostic-screenshot.png",
      mediaType: "image/png",
      sizeBytes: 68,
      sha256: "screenshot-sha",
    });
    expect(plan.attachments[2]?.payload).toEqual({
      kind: "conversation",
      projectPath: "/repos/source",
      sessionName: "work",
      conversationId: "conv-1",
      snapshotKey: null,
      snapshotCapturedAt: null,
      snapshotStatus: "pending",
    });
  });

  it("honors removed screenshot and conversation keys", async () => {
    const captureScreenshot =
      vi.fn<CreateAttachmentPlannerDeps["captureScreenshot"]>();
    const scheduleEnrichment =
      vi.fn<CreateAttachmentPlannerDeps["scheduleEnrichment"]>();
    const planner = createCreateAttachmentPlanner(
      makeDeps({ captureScreenshot, scheduleEnrichment }),
    );

    const plan = await planner.plan({
      ticketId: "ticket-1",
      conversationContext: {
        sourceProjectName: "source",
        sessionName: null,
        conversationId: "conv-1",
      },
      diagnostics: diagnostics({
        removed: ["screenshot", "conversation"],
      }),
    });

    expect(
      plan.attachments.map((attachment) => attachment.payload.kind),
    ).toEqual(["note"]);
    expect(plan.pendingConversationAttachmentIds).toEqual([]);
    expect(captureScreenshot).not.toHaveBeenCalled();

    const ticket = {
      id: "ticket-1",
      projectPath: "/repos/command-center",
      projectName: "command-center",
      number: 7,
      title: "Bug",
      description: "",
      workType: "bug" as const,
      status: "not_started" as const,
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:00:00.000Z",
      attachments: plan.attachments,
      sessions: [],
      relationships: [],
      statusUpdates: { total: 0, recent: [] },
    };
    plan.afterCommit(ticket);

    expect(scheduleEnrichment).toHaveBeenCalledWith({
      backend: "codex",
      modelSelection: { modelId: "gpt-5.4", parameters: {} },
      ticket,
      diagnostics: diagnostics({
        removed: ["screenshot", "conversation"],
      }),
    });
  });

  it("omits stale source-project context and returns a safe warning", async () => {
    const scheduleEnrichment =
      vi.fn<CreateAttachmentPlannerDeps["scheduleEnrichment"]>();
    const planner = createCreateAttachmentPlanner(
      makeDeps({
        async resolveAvailableProjectPath() {
          return null;
        },
        scheduleEnrichment,
      }),
    );

    const plan = await planner.plan({
      ticketId: "ticket-1",
      conversationContext: {
        sourceProjectName: "gone",
        sessionName: null,
        conversationId: "conv-1",
      },
      diagnostics: diagnostics({ screenshot: undefined }),
    });

    expect(plan.attachments).toHaveLength(1);
    expect(plan.warnings).toEqual([
      {
        code: "conversation_source_unavailable",
        message:
          "Conversation context was not attached because project 'gone' is unavailable.",
      },
    ]);

    const ticket = {
      id: "ticket-1",
      projectPath: "/repos/command-center",
      projectName: "command-center",
      number: 7,
      title: "Bug",
      description: "",
      workType: "bug" as const,
      status: "not_started" as const,
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:00:00.000Z",
      attachments: plan.attachments,
      sessions: [],
      relationships: [],
      statusUpdates: { total: 0, recent: [] },
    };
    plan.afterCommit(ticket);

    expect(scheduleEnrichment).toHaveBeenCalledWith({
      backend: "codex",
      modelSelection: { modelId: "gpt-5.4", parameters: {} },
      ticket,
      diagnostics: diagnostics({ screenshot: undefined }),
    });
  });

  it("persists a retryable failed row when the conversation is unknown", async () => {
    const planner = createCreateAttachmentPlanner(
      makeDeps({
        async conversationExists() {
          return false;
        },
      }),
    );

    const plan = await planner.plan({
      ticketId: "ticket-1",
      conversationContext: {
        sourceProjectName: "source",
        sessionName: null,
        conversationId: "missing",
      },
    });

    expect(plan.pendingConversationAttachmentIds).toEqual([]);
    expect(plan.attachments[0]?.payload).toEqual({
      kind: "conversation",
      projectPath: "/repos/source",
      sessionName: null,
      conversationId: "missing",
      snapshotKey: null,
      snapshotCapturedAt: null,
      snapshotStatus: "failed",
      snapshotError: "The source conversation is unavailable.",
    });
  });

  it("compensates every captured blob once", async () => {
    const deleteSnapshot =
      vi.fn<CreateAttachmentPlannerDeps["deleteSnapshot"]>();
    const planner = createCreateAttachmentPlanner(makeDeps({ deleteSnapshot }));
    const plan = await planner.plan({
      ticketId: "ticket-1",
      diagnostics: diagnostics(),
    });

    await plan.compensate();
    await plan.compensate();

    expect(deleteSnapshot).toHaveBeenCalledTimes(1);
    expect(deleteSnapshot).toHaveBeenCalledWith(
      "ticket-1/attachment-2/diagnostic-screenshot.png",
    );
  });

  it("compensates captured blobs when later planning fails", async () => {
    const deleteSnapshot =
      vi.fn<CreateAttachmentPlannerDeps["deleteSnapshot"]>();
    const planner = createCreateAttachmentPlanner(
      makeDeps({
        deleteSnapshot,
        async resolveAvailableProjectPath() {
          throw new Error("project discovery failed");
        },
      }),
    );

    await expect(
      planner.plan({
        ticketId: "ticket-1",
        diagnostics: diagnostics(),
        conversationContext: {
          sourceProjectName: "source",
          sessionName: "work",
          conversationId: "conv-1",
        },
      }),
    ).rejects.toThrow("project discovery failed");
    expect(deleteSnapshot).toHaveBeenCalledWith(
      "ticket-1/attachment-2/diagnostic-screenshot.png",
    );
  });

  it("schedules snapshots and enrichment only after commit", async () => {
    const scheduleConversationSnapshotRefresh =
      vi.fn<
        CreateAttachmentPlannerDeps["scheduleConversationSnapshotRefresh"]
      >();
    const scheduleEnrichment =
      vi.fn<CreateAttachmentPlannerDeps["scheduleEnrichment"]>();
    const planner = createCreateAttachmentPlanner(
      makeDeps({
        scheduleConversationSnapshotRefresh,
        scheduleEnrichment,
      }),
    );
    const plan = await planner.plan({
      ticketId: "ticket-1",
      diagnostics: diagnostics(),
      conversationContext: {
        sourceProjectName: "source",
        sessionName: "work",
        conversationId: "conv-1",
      },
    });
    expect(scheduleConversationSnapshotRefresh).not.toHaveBeenCalled();
    expect(scheduleEnrichment).not.toHaveBeenCalled();

    const ticket = {
      id: "ticket-1",
      projectPath: "/repos/command-center",
      projectName: "command-center",
      number: 7,
      title: "Bug",
      description: "",
      workType: "bug" as const,
      status: "not_started" as const,
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:00:00.000Z",
      attachments: plan.attachments,
      sessions: [],
      relationships: [],
      statusUpdates: { total: 0, recent: [] },
    };
    plan.afterCommit(ticket);

    expect(scheduleConversationSnapshotRefresh).toHaveBeenCalledWith({
      projectName: "command-center",
      number: 7,
      attachmentId: "attachment-3",
    });
    expect(scheduleEnrichment).toHaveBeenCalledWith({
      backend: "codex",
      modelSelection: { modelId: "gpt-5.4", parameters: {} },
      ticket,
      diagnostics: diagnostics(),
      conversationContext: {
        sourceProjectName: "source",
        sessionName: "work",
        conversationId: "conv-1",
      },
    });
  });

  it("skips enrichment when auto-start intent is present", async () => {
    const scheduleEnrichment =
      vi.fn<CreateAttachmentPlannerDeps["scheduleEnrichment"]>();
    const planner = createCreateAttachmentPlanner(
      makeDeps({ scheduleEnrichment }),
    );
    const plan = await planner.plan({
      ticketId: "ticket-1",
      diagnostics: diagnostics(),
      autoStartRequested: true,
    });

    plan.afterCommit({
      id: "ticket-1",
      projectPath: "/repos/command-center",
      projectName: "command-center",
      number: 7,
      title: "Bug",
      description: "",
      workType: "bug",
      status: "not_started",
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:00:00.000Z",
      attachments: plan.attachments,
      sessions: [],
      relationships: [],
      statusUpdates: { total: 0, recent: [] },
    });

    expect(scheduleEnrichment).not.toHaveBeenCalled();
  });
});
