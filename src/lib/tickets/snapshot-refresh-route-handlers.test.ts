import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  withTracing: (handler: unknown) => handler,
}));

import type { AgentAuth } from "@/lib/agent-gateway/token";
import {
  createConversationSnapshotRefreshRouteHandlers,
  type ConversationSnapshotRefreshRouteDeps,
} from "./snapshot-refresh-route-handlers";
import type { ConversationSnapshotRefreshService } from "./snapshot-refresh";
import type { TicketAttachment } from "./schemas";

const attachment: TicketAttachment = {
  id: "attachment-1",
  ticketId: "ticket-1",
  description: "Observed conversation",
  payload: {
    kind: "conversation",
    projectPath: "/repos/source",
    sessionName: "investigation",
    conversationId: "conversation-1",
    snapshotKey: "ticket-1/attachment-1/compaction-refresh-candidate-1.md",
    snapshotCapturedAt: "2026-07-19T12:01:00.000Z",
    snapshotStatus: "captured",
  },
  createdAt: "2026-07-19T12:00:00.000Z",
  updatedAt: "2026-07-19T12:01:00.000Z",
};

function auth(result: "absent" | "invalid" = "absent"): AgentAuth {
  return {
    async requireToken() {
      return null;
    },
    async validateOptionalToken() {
      return result === "invalid" ? { kind: "invalid" } : { kind: "absent" };
    },
  };
}

function routeContext(number = "7", attachmentId = "attachment-1") {
  return {
    params: Promise.resolve({
      name: "command-center",
      number,
      attachmentId,
    }),
  };
}

function makeDeps(
  refresh: ConversationSnapshotRefreshService["refresh"],
  authResult: "absent" | "invalid" = "absent",
): ConversationSnapshotRefreshRouteDeps {
  return {
    getService: () => ({ refresh, schedule: vi.fn() }),
    auth: auth(authResult),
  };
}

describe("conversation snapshot refresh POST", () => {
  it("returns the winning persisted attachment directly", async () => {
    const refresh = vi.fn(async () => ({
      ok: true as const,
      value: attachment,
    }));
    const handlers = createConversationSnapshotRefreshRouteHandlers(
      makeDeps(refresh),
    );

    const response = await handlers.refreshPOST(
      new Request(
        "http://localhost/api/projects/command-center/tickets/7/attachments/attachment-1/refresh-snapshot",
        { method: "POST" },
      ),
      routeContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(attachment);
    expect(refresh).toHaveBeenCalledWith({
      projectName: "command-center",
      number: 7,
      attachmentId: "attachment-1",
    });
  });

  it("maps failed capture to the canonical 422 response", async () => {
    const handlers = createConversationSnapshotRefreshRouteHandlers(
      makeDeps(async () => ({
        ok: false,
        error: {
          code: "context_preparation_failed",
          phase: "content",
          reason: "Conversation snapshot capture failed. Retry the snapshot.",
        },
      })),
    );

    const response = await handlers.refreshPOST(
      new Request("http://localhost/refresh-snapshot", { method: "POST" }),
      routeContext(),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "context_preparation_failed",
    });
  });

  it("validates every path segment before calling the service", async () => {
    const refresh = vi.fn<ConversationSnapshotRefreshService["refresh"]>();
    const handlers = createConversationSnapshotRefreshRouteHandlers(
      makeDeps(refresh),
    );

    const response = await handlers.refreshPOST(
      new Request("http://localhost/refresh-snapshot", { method: "POST" }),
      routeContext("not-a-number", ""),
    );

    expect(response.status).toBe(400);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("applies the optional-token gate", async () => {
    const refresh = vi.fn<ConversationSnapshotRefreshService["refresh"]>();
    const handlers = createConversationSnapshotRefreshRouteHandlers(
      makeDeps(refresh, "invalid"),
    );

    const response = await handlers.refreshPOST(
      new Request("http://localhost/refresh-snapshot", { method: "POST" }),
      routeContext(),
    );

    expect(response.status).toBe(401);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("contains unexpected service failures behind a stable 500", async () => {
    const handlers = createConversationSnapshotRefreshRouteHandlers(
      makeDeps(async () => {
        throw new Error("database details that must not escape");
      }),
    );

    const response = await handlers.refreshPOST(
      new Request("http://localhost/refresh-snapshot", { method: "POST" }),
      routeContext(),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Conversation snapshot refresh failed",
      code: "internal_error",
    });
  });
});
