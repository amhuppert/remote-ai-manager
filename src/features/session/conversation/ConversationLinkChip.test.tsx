// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery, createTestQueryClient } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import ConversationLinkChip from "./ConversationLinkChip";
import type { ConversationRefAttrs } from "@/lib/conversations/schemas";

const attrs: ConversationRefAttrs = {
  "project-name": "my-app",
  "project-path": "/repos/my-app",
  scope: "session",
  "session-name": "main",
  "worktree-path": "/repos/my-app/.worktrees/main",
  "conversation-id": "conv-123",
  "conversation-name": "Refactor parser",
  backend: "claude",
  "backend-ref": "claude-sess-abc",
  "debug-log-path": "",
  status: "running",
  "last-activity-at": "2024-06-01T12:00:00Z",
};
let api: FetchFixture;
let client: ReturnType<typeof createTestQueryClient>;
beforeEach(() => {
  client = createTestQueryClient();
  api = installFetchFixture();
  api.reply("POST", "/api/live-references", (req) => {
    const { targets } = req.jsonBody as { targets: unknown[] };
    return {
      json: {
        results: targets.map((target) => ({
          target,
          checkedAt: "2026-09-10T04:00:00Z",
          unavailableReason: null,
          summary: {
            title: "Current conversation",
            identity: "conv-123",
            status: "Waiting for input",
            tone: "amber",
            href: "/conversations?c=conv-123",
            readCommand: "cctl conversation read conv-123",
            attentionCount: 0,
            details: [
              { label: "Agent", value: "codex" },
              { label: "Scope", value: "Project conversation" },
            ],
          },
        })),
      },
    };
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  api.restore();
});

describe("ConversationLinkChip", () => {
  it("shows the captured name while current state is loading", () => {
    renderWithQuery(<ConversationLinkChip attrs={attrs} />, client);
    expect(screen.getByText("Refactor parser")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("falls back to the stable id when the captured name is empty", () => {
    renderWithQuery(
      <ConversationLinkChip attrs={{ ...attrs, "conversation-name": "" }} />,
      client,
    );
    expect(screen.getByText("conv-123")).toBeInTheDocument();
  });
  it("previews current activity and backend before opening the conversation", async () => {
    renderWithQuery(<ConversationLinkChip attrs={attrs} />, client);
    await userEvent
      .setup()
      .click(
        await screen.findByRole("button", { name: /Current conversation/ }),
      );
    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/conversations?c=conv-123",
    );
  });
  it("resolves a project conversation without requiring a session name", async () => {
    const { "session-name": _session, ...projectAttrs } = attrs;
    renderWithQuery(
      <ConversationLinkChip attrs={{ ...projectAttrs, scope: "project" }} />,
      client,
    );
    await userEvent
      .setup()
      .click(
        await screen.findByRole("button", { name: /Current conversation/ }),
      );
    expect(screen.getByText("Project conversation")).toBeInTheDocument();
    expect(api.requestsTo("POST", "/api/live-references")[0]?.jsonBody).toEqual(
      {
        targets: [
          { kind: "conversation", projectName: "my-app", id: "conv-123" },
        ],
      },
    );
  });
});
