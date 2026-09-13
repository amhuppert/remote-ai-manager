// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import {
  listBackendCatalogEntries,
  getStaticBackendModelCatalog,
} from "@/lib/agent-backends/catalog";
import { defaultSelectionForModel } from "@/lib/agent-backends/model-selection";
import { checkpointReceiptFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";
import { checkpointForkOriginFixture } from "@/lib/conversation-checkpoints/testing/fork-origin-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { toPublicConversationState } from "@/lib/conversations/schemas";
import CheckpointForkForm from "./CheckpointForkForm";
import CheckpointPanel from "./CheckpointPanel";
import { checkpointSurfaceFixture } from "./checkpoint-story-fixtures";

const target = {
  scope: "session",
  projectName: "test",
  sessionName: "session",
  conversationId: "source",
} as const;
const source = toPublicConversationState(
  makeConversationState({ id: "source", name: "Planning" }),
);
const receipt = checkpointReceiptFixture({
  operationId: "historical-2",
  ordinal: 2,
  phase: "applied",
});
const forkUrl =
  "/api/projects/test/sessions/session/conversations/source/checkpoints/historical-2/fork";

describe("checkpoint fork form", () => {
  let api: FetchFixture;
  beforeEach(() => {
    api = installFetchFixture();
    api.json("GET", "/api/agent-backends", {
      backends: listBackendCatalogEntries().map((entry) => ({
        ...entry,
        capabilities: { ...entry.capabilities, checkpointFork: true },
      })),
    });
    api.json("GET", "/api/projects/test/model-options", {
      backends: ["claude", "codex"].map((backend) => {
        const catalog = getStaticBackendModelCatalog(
          backend as "claude" | "codex",
        );
        return {
          backend,
          models: [],
          defaultModelId: catalog.defaultModelId,
          source: "catalog",
          modelCatalog: catalog,
          defaultSelection: defaultSelectionForModel(
            catalog,
            catalog.defaultModelId,
          ),
          diagnostics: [],
        };
      }),
    });
    api.json("GET", "/api/projects/test/tickets", []);
    api.json("GET", "/api/voice/health", { available: false });
  });
  afterEach(() => api.restore());

  it("does not replace an unavailable explicitly selected source checkpoint with the latest checkpoint", () => {
    renderWithQuery(
      <CheckpointPanel
        open
        onOpenChange={() => {}}
        sourceConversation={source}
        initialOperationId="deleted-checkpoint"
        surface={checkpointSurfaceFixture({ target, receipts: [receipt] })}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Fork from this checkpoint" }),
    ).not.toBeInTheDocument();
  });

  it("retains the edited task when viewing source evidence and returning to the same checkpoint", async () => {
    renderWithQuery(
      <CheckpointPanel
        open
        onOpenChange={() => {}}
        sourceConversation={source}
        initialForkTicket={131}
        surface={checkpointSurfaceFixture({ target, receipts: [receipt] })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Fork from this checkpoint" }),
    );
    fireEvent.change(await screen.findByLabelText("Next task"), {
      target: { value: "Retain my next task" },
    });
    expect(
      screen.getByRole("button", { name: "View source evidence" }),
    ).toHaveAttribute("type", "button");
    fireEvent.click(
      screen.getByRole("button", { name: "View source evidence" }),
    );
    const reopen = screen.getByRole("button", {
      name: "Fork from this checkpoint",
    });
    await waitFor(() => expect(reopen).toHaveFocus());
    fireEvent.click(reopen);
    expect(await screen.findByLabelText("Next task")).toHaveValue(
      "Retain my next task",
    );
  });

  it("creates a draft from the selected historical checkpoint and preserves inputs and request identity after refusal", async () => {
    let createdId: string | undefined;
    api.reply("POST", forkUrl, {
      status: 422,
      json: {
        error: "Selected work is unavailable",
        code: "related_work_not_found",
      },
    });
    renderWithQuery(
      <CheckpointForkForm
        target={target}
        receipt={receipt}
        source={source}
        initialTicket={131}
        onBack={() => {}}
        onCreated={(conversation) => {
          createdId = conversation.id;
        }}
      />,
    );
    expect(await screen.findByLabelText("Next task")).toHaveFocus();
    fireEvent.change(await screen.findByLabelText("Next task"), {
      target: { value: "Implement Q-137" },
    });
    const button = screen.getByRole("button", { name: "Create fork" });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.keyDown(screen.getByLabelText("Next task"), {
      key: "Enter",
      ctrlKey: true,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Selected work is unavailable",
    );
    expect(screen.getByLabelText("Next task")).toHaveValue("Implement Q-137");
    const first = api.requestsTo("POST", forkUrl)[0]!.jsonBody as Record<
      string,
      unknown
    >;
    expect(first).toMatchObject({
      task: "Implement Q-137",
      relatedWork: { kind: "ticket", ticketNumber: 131 },
    });
    expect(createdId).toBeUndefined();
    api.reply("POST", forkUrl, (request) => {
      const body = request.jsonBody as { requestId: string };
      return {
        json: {
          conversation: toPublicConversationState(
            makeConversationState({
              id: body.requestId,
              checkpointFork: checkpointForkOriginFixture(),
            }),
          ),
          receipt,
          reused: false,
        },
      };
    });
    fireEvent.click(button);
    await waitFor(() => expect(createdId).toBe(first.requestId));
    expect(api.requestsTo("POST", forkUrl)[1]?.jsonBody).toEqual(first);
    expect(api.unmatched).toEqual([]);
  });
});
