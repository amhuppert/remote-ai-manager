import { describe, expect, it } from "vitest";
import { STATUS_UPDATE_BODY_PREVIEW_CHARS } from "./disclosure-limits";
import type { TicketStatusUpdate } from "./schemas";
import {
  buildStatusUpdateIndex,
  renderStatusUpdateIndexLines,
  statusUpdateAttribution,
  statusUpdateBodyPreview,
} from "./status-update-index";

describe("statusUpdateBodyPreview", () => {
  it("normalizes whitespace and bounds the preview with an explicit ellipsis", () => {
    const preview = statusUpdateBodyPreview(
      `  shipped\n\nwith\t${"x".repeat(STATUS_UPDATE_BODY_PREVIEW_CHARS * 2)}  `,
    );

    expect(Array.from(preview)).toHaveLength(STATUS_UPDATE_BODY_PREVIEW_CHARS);
    expect(preview).toMatch(/^shipped with x+/);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("leaves a short normalized body intact", () => {
    expect(statusUpdateBodyPreview("  ready\nfor review  ")).toBe(
      "ready for review",
    );
  });
});

function update(
  id: string,
  author: TicketStatusUpdate["author"],
): TicketStatusUpdate {
  return {
    id,
    ticketId: "ticket-1",
    bodyMarkdown: `Update ${id} ${"private".repeat(80)}`,
    author,
    createdAt: `2026-01-01T00:00:0${id}.000Z`,
  };
}

describe("buildStatusUpdateIndex", () => {
  it("renders newest outlines with attribution, stable handles, and exact commands", () => {
    const user = update("2", { kind: "user" });
    const agent = update("1", {
      kind: "agent",
      conversationId: "conversation-1",
      conversationName: "Ticket work",
      projectName: "demo",
      scope: "project",
      backend: "codex",
      redactedProfileSnapshot: {
        tier: "project",
        id: "implementer",
        name: "Ticket Implementer",
        revision: 3,
        sourceContentHash: `sha256:${"a".repeat(64)}`,
        resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
      },
    });

    const index = buildStatusUpdateIndex({
      identifier: "demo project#2",
      statusUpdates: { total: 2, recent: [user, agent] },
    });

    expect(statusUpdateAttribution(user)).toBe("User");
    expect(statusUpdateAttribution(agent)).toBe("Ticket Implementer (codex)");
    expect(index.entries[1]).toMatchObject({
      updateId: "1",
      attribution: "Ticket Implementer (codex)",
      command: "cctl ticket status-update get 'demo project#2' '1'",
    });
    expect(Array.from(index.entries[0]?.bodyPreview ?? "")).toHaveLength(
      STATUS_UPDATE_BODY_PREVIEW_CHARS,
    );
    expect(index.entries[0]?.bodyPreview.endsWith("…")).toBe(true);
  });

  it("reports bounded summary omissions with the exact list command", () => {
    const recent = Array.from({ length: 5 }, (_, index) =>
      update(String(5 - index), { kind: "user" }),
    );

    const index = buildStatusUpdateIndex({
      identifier: "demo#1",
      statusUpdates: { total: 9, recent },
    });
    const lines = renderStatusUpdateIndexLines(index);

    expect(index).toMatchObject({
      total: 9,
      returned: 5,
      truncated: true,
      listCommand: "cctl ticket status-update list 'demo#1'",
    });
    expect(lines.at(-1)).toBe(
      "status updates: 9 total, 5 returned, truncated=yes; rest: cctl ticket status-update list 'demo#1'",
    );
  });
});
