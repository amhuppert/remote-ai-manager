// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture } from "@/test/fetch-fixture";
import { publicSessionStateSchema } from "@/lib/sessions/schemas";
import { toPublicConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";

// react-virtuoso is layout-driven and renders no items in jsdom (no real
// height/scroll). Replace it with a flat list renderer so the full data path
// (query → rows → renderMessageRow → MessageRow) can be exercised in the
// integration test below. This mirrors the pattern in ConversationWorkspace.test.tsx.
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

const SESSION_FIXTURE = publicSessionStateSchema.parse({
  sessionName: "sess",
  worktreePath: "/repo",
  branchName: "test",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  conversations: ["conv-1", "conv-codex-xyz", "conv-mixed"].map((id) =>
    toPublicConversationState(makeConversationState({ id })),
  ),
});

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
      return { ok: true, status: 200, json: async () => SESSION_FIXTURE };
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not label an unresolved conversation as another backend", () => {
    const api = installFetchFixture();
    api.pending("GET", "/api/projects/proj/sessions/sess");
    api.json(
      "GET",
      "/api/projects/proj/sessions/sess/conversations/conv-1/messages",
      [],
    );
    try {
      renderWithQuery(
        <WorkflowConversationViewer
          projectName="proj"
          sessionName="sess"
          conversationId="conv-1"
          role="Implementer"
          contextTitle="Build"
          isLive={false}
          onClose={vi.fn()}
        />,
      );
      expect(screen.queryByText("Claude")).not.toBeInTheDocument();
      expect(screen.getByText("Loading conversation…")).toBeInTheDocument();
    } finally {
      api.restore();
    }
  });

  it.each([
    ["cursor", "Cursor"],
    ["codex", "Codex"],
    ["claude", "Claude"],
  ] as const)(
    "identifies the persisted %s workflow conversation",
    async (backend, label) => {
      const api = installFetchFixture();
      api.json(
        "GET",
        "/api/projects/proj/sessions/sess",
        publicSessionStateSchema.parse({
          sessionName: "sess",
          worktreePath: "/repo",
          branchName: "test",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActivityAt: "2026-01-01T00:00:00.000Z",
          conversations: [
            toPublicConversationState(
              makeConversationState({
                id: "conv-1",
                agentBackend: backend,
              }),
            ),
          ],
        }),
      );
      api.json(
        "GET",
        "/api/projects/proj/sessions/sess/conversations/conv-1/messages",
        [],
      );
      try {
        const { container } = renderWithQuery(
          <WorkflowConversationViewer
            projectName="proj"
            sessionName="sess"
            conversationId="conv-1"
            role="Implementer"
            contextTitle="Build"
            isLive={false}
            onClose={vi.fn()}
          />,
        );
        expect(await screen.findByText(label)).toBeInTheDocument();
        expect(
          container
            .querySelector(".conversation")
            ?.getAttribute("data-backend"),
        ).toBe(backend);
      } finally {
        api.restore();
      }
    },
  );

  it("titles the Log surface with the conversation id and the role that owns it", async () => {
    const onClose = vi.fn();
    renderWithQuery(
      <WorkflowConversationViewer
        projectName="proj"
        sessionName="sess"
        conversationId="conv-1"
        role="Implementer"
        contextTitle="API Integration"
        taskTitle="Auth middleware"
        isLive={false}
        onClose={onClose}
      />,
    );

    const identity = screen.getByTestId("transcript-identity");
    expect(identity).toHaveTextContent("conv-1");
    expect(identity).toHaveTextContent("Implementer");
  });

  it("keeps the context / task breadcrumb so the transcript still says where it came from", () => {
    renderWithQuery(
      <WorkflowConversationViewer
        projectName="proj"
        sessionName="sess"
        conversationId="conv-1"
        role="Implementer"
        contextTitle="API Integration"
        taskTitle="Auth middleware"
        isLive={false}
        onClose={vi.fn()}
      />,
    );

    const breadcrumb = screen.getByTestId("transcript-breadcrumb");
    expect(breadcrumb).toHaveTextContent("API Integration");
    expect(breadcrumb).toHaveTextContent("Auth middleware");
  });

  it("names only the context when the transcript was opened from a conversation row rather than a task", () => {
    renderWithQuery(
      <WorkflowConversationViewer
        projectName="proj"
        sessionName="sess"
        conversationId="conv-1"
        role="Validator · security"
        contextTitle="API Integration"
        isLive={false}
        onClose={vi.fn()}
      />,
    );

    const breadcrumb = screen.getByTestId("transcript-breadcrumb");
    expect(breadcrumb).toHaveTextContent("API Integration");
    expect(screen.getByTestId("transcript-identity")).toHaveTextContent(
      "Validator · security",
    );
  });

  it("closes through a canonical SVG icon control, never a Unicode glyph", async () => {
    const onClose = vi.fn();
    const { container } = renderWithQuery(
      <WorkflowConversationViewer
        projectName="proj"
        sessionName="sess"
        conversationId="conv-1"
        role="Implementer"
        contextTitle="Ctx"
        taskTitle="Task"
        isLive={false}
        onClose={onClose}
      />,
    );

    const close = screen.getByRole("button", {
      name: "Close transcript and return to graph",
    });
    expect(close.querySelector("svg")).not.toBeNull();
    expect(close.textContent).toBe("");
    expect(container.textContent).not.toContain("✕");

    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a live pill when the conversation is still running", () => {
    renderWithQuery(
      <WorkflowConversationViewer
        projectName="proj"
        sessionName="sess"
        conversationId="conv-1"
        role="Implementer"
        contextTitle="Ctx"
        taskTitle="Task"
        isLive={true}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("transcript-status")).toHaveTextContent("live");
  });

  it("shows an ended pill when the conversation is no longer running", () => {
    renderWithQuery(
      <WorkflowConversationViewer
        projectName="proj"
        sessionName="sess"
        conversationId="conv-1"
        role="Implementer"
        contextTitle="Ctx"
        taskTitle="Task"
        isLive={false}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("transcript-status")).toHaveTextContent("ended");
  });

  it("hits the standard CC conversation-messages endpoint for the given conversationId", async () => {
    renderWithQuery(
      <WorkflowConversationViewer
        projectName="proj"
        sessionName="sess"
        conversationId="conv-codex-xyz"
        role="Implementer"
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
        return { ok: true, status: 200, json: async () => SESSION_FIXTURE };
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
          role="Implementer"
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

    // The Log surface's typographic split (README §11, M2 phone 3): only the
    // conversation's own prose is Manrope. Everything the reader uses to
    // identify or act on the transcript — the conv id, the role, the pill —
    // stays Geist Mono, so the chrome never reads as part of the transcript.
    it("renders conversation prose in the body font while the header identifiers stay mono", async () => {
      renderWithQuery(
        <WorkflowConversationViewer
          projectName="proj"
          sessionName="sess"
          conversationId="conv-mixed"
          role="Implementer"
          contextTitle="Auth"
          taskTitle="Refactor"
          isLive={false}
          onClose={vi.fn()}
        />,
      );

      const prose = await screen.findByText("Kick off the auth refactor.");
      expect(prose.closest(".font-body")).not.toBeNull();

      expect(screen.getByTestId("transcript-identity")).toHaveClass(
        "font-mono",
      );
      expect(screen.getByTestId("transcript-breadcrumb")).toHaveClass(
        "font-mono",
      );
    });
  });
});
