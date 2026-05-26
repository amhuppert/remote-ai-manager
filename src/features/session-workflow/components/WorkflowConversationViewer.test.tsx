// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";

// react-virtuoso is layout-driven and renders no items in jsdom (no real
// height/scroll). Replace it with a flat list renderer so the full data path
// (query → rows → renderMessageRow → MessageRow) can be exercised in the
// integration test below. This mirrors the pattern in SessionPage.test.tsx.
vi.mock("react-virtuoso", async () => {
  const React = await import("react");
  type VirtuosoMockProps = {
    data?: unknown[];
    itemContent?: (index: number, item: unknown) => React.ReactNode;
    components?: { Footer?: () => React.ReactNode };
  };
  const Virtuoso = React.forwardRef(function VirtuosoMock(
    props: VirtuosoMockProps,
    ref: React.Ref<unknown>,
  ) {
    const { data = [], itemContent, components } = props;
    React.useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    const Footer = components?.Footer;
    return (
      <div data-testid="virtuoso-mock">
        {data.map((item, index) => (
          <div key={index} data-index={index}>
            {itemContent?.(index, item)}
          </div>
        ))}
        {Footer ? <Footer /> : null}
      </div>
    );
  });
  return { Virtuoso };
});

import WorkflowConversationViewer from "./WorkflowConversationViewer";

const INTERLEAVED_FIXTURE = [
  {
    seq: 0,
    role: "user",
    content: [{ type: "text", text: "Kick off the auth refactor." }],
    timestamp: "2026-04-12T11:00:00Z",
    origin: { source: "user" },
  },
  {
    seq: 1,
    role: "assistant",
    content: [{ type: "text", text: "Drafting plan for iteration 1." }],
    timestamp: "2026-04-12T11:00:05Z",
    model: "opus",
    origin: {
      source: "workflow",
      workflow: {
        executionId: "exec-1",
        nodeId: "ctx-impl",
        iterationIndex: 1,
      },
    },
  },
  {
    seq: 2,
    role: "user",
    content: [{ type: "text", text: "Looks off — please retry." }],
    timestamp: "2026-04-12T11:01:00Z",
    origin: { source: "user" },
  },
  {
    seq: 3,
    role: "assistant",
    content: [{ type: "text", text: "Revised plan for iteration 2." }],
    timestamp: "2026-04-12T11:01:05Z",
    model: "opus",
    origin: {
      source: "workflow",
      workflow: {
        executionId: "exec-1",
        nodeId: "ctx-impl",
        iterationIndex: 2,
      },
    },
  },
] as const;

describe("WorkflowConversationViewer", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/conversations/") && url.includes("/messages")) {
        return {
          ok: true,
          status: 200,
          json: async () => [],
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the workflow chrome (close + context/task header) above the ConversationPanel", async () => {
    const onClose = vi.fn();
    renderWithQuery(
      <WorkflowConversationViewer
        projectName="proj"
        sessionName="sess"
        conversationId="conv-1"
        contextTitle="API Integration"
        taskTitle="Auth middleware"
        isLive={false}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("API Integration")).toBeInTheDocument();
    expect(screen.getByText("Auth middleware")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close transcript" }),
    ).toBeInTheDocument();
  });

  it("shows the live indicator when isLive=true", () => {
    renderWithQuery(
      <WorkflowConversationViewer
        projectName="proj"
        sessionName="sess"
        conversationId="conv-1"
        contextTitle="Ctx"
        taskTitle="Task"
        isLive={true}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("omits the live indicator when isLive=false", () => {
    renderWithQuery(
      <WorkflowConversationViewer
        projectName="proj"
        sessionName="sess"
        conversationId="conv-1"
        contextTitle="Ctx"
        taskTitle="Task"
        isLive={false}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText("Live")).toBeNull();
  });

  it("hits the standard CC conversation-messages endpoint for the given conversationId", async () => {
    renderWithQuery(
      <WorkflowConversationViewer
        projectName="proj"
        sessionName="sess"
        conversationId="conv-codex-xyz"
        contextTitle="Ctx"
        taskTitle="Task"
        isLive={false}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      const urls = fetchSpy.mock.calls.map(([u]) => String(u));
      expect(
        urls.some((u) =>
          u.includes(
            "/api/projects/proj/sessions/sess/conversations/conv-codex-xyz/messages",
          ),
        ),
      ).toBe(true);
    });
  });

  describe("interleaved-origin fixture (workflow smoke)", () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/conversations/") && url.includes("/messages")) {
          return {
            ok: true,
            status: 200,
            json: async () => INTERLEAVED_FIXTURE,
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      });
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    it("renders workflow-origin messages with the iteration badge and leaves user-origin messages unbadged", async () => {
      const { container } = renderWithQuery(
        <WorkflowConversationViewer
          projectName="proj"
          sessionName="sess"
          conversationId="conv-mixed"
          contextTitle="Auth"
          taskTitle="Refactor"
          isLive={false}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("iter 1")).toBeInTheDocument();
        expect(screen.getByText("iter 2")).toBeInTheDocument();
      });

      expect(container.querySelector(".panel-body")).not.toBeNull();
      expect(container.querySelector(".conversation")).not.toBeNull();

      const messageRows = container.querySelectorAll("[data-msg-index]");
      expect(messageRows.length).toBe(4);

      const rowsByIndex = new Map<string, Element>();
      for (const row of messageRows) {
        const idx = row.getAttribute("data-msg-index");
        if (idx) rowsByIndex.set(idx, row);
      }

      const userRow0 = rowsByIndex.get("0");
      const assistantRow1 = rowsByIndex.get("1");
      const userRow2 = rowsByIndex.get("2");
      const assistantRow3 = rowsByIndex.get("3");

      expect(userRow0).toBeDefined();
      expect(assistantRow1).toBeDefined();
      expect(userRow2).toBeDefined();
      expect(assistantRow3).toBeDefined();

      expect(within(userRow0 as HTMLElement).queryByText(/^iter /)).toBeNull();
      expect(within(userRow2 as HTMLElement).queryByText(/^iter /)).toBeNull();

      expect(
        within(assistantRow1 as HTMLElement).getByText("iter 1"),
      ).toBeInTheDocument();
      expect(
        within(assistantRow3 as HTMLElement).getByText("iter 2"),
      ).toBeInTheDocument();

      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
