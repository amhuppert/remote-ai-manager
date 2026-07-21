// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  within,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import ConversationTabStrip, {
  type ConversationTabStripProps,
} from "./ConversationTabStrip";

const routerPushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
  }),
}));

function convo(
  id: string,
  overrides: Partial<SessionActiveConversation> = {},
): SessionActiveConversation {
  return {
    scope: "session",
    id,
    name: `Conversation ${id}`,
    status: "running",
    lastActivityAt: "2026-06-14T00:00:00.000Z",
    projectName: "proj",
    projectPath: "/tmp/proj",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/tmp/proj/.worktrees/x",
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    sessionName: `session-${id}`,
    branchName: `csm/${id}`,
    ...overrides,
  };
}

function renderStrip(overrides: Partial<ConversationTabStripProps> = {}): {
  onActivate: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  onAddClick: ReturnType<typeof vi.fn>;
} {
  const onActivate = vi.fn();
  const onClose = vi.fn();
  const onAddClick = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ConversationTabStrip
        workingSet={[convo("a"), convo("b"), convo("c")]}
        activeId="a"
        isAtCap={false}
        onActivate={onActivate}
        onClose={onClose}
        onAddClick={onAddClick}
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { onActivate, onClose, onAddClick };
}

describe("ConversationTabStrip", () => {
  it("renders a tablist with one tab per conversation, in working-set order (2.1)", () => {
    renderStrip();

    expect(screen.getByRole("tablist")).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(
      tabs.map((t) => within(t).getByText(/Conversation/).textContent),
    ).toEqual(["Conversation a", "Conversation b", "Conversation c"]);
  });

  it("marks only the active tab via aria-selected/data-active (2.5)", () => {
    renderStrip({ activeId: "b" });

    const tabs = screen.getAllByRole("tab");
    const selected = tabs.filter(
      (t) => t.getAttribute("aria-selected") === "true",
    );
    expect(selected).toHaveLength(1);
    expect(
      within(selected[0]!).getByText("Conversation b"),
    ).toBeInTheDocument();
    expect(selected[0]).toHaveAttribute("data-active", "true");
  });

  it("renders each tab's status dot with the right data-status (2.2)", () => {
    renderStrip({
      workingSet: [
        convo("a", { status: "running" }),
        convo("b", { status: "waiting_for_input" }),
        convo("c", { status: "awaiting" }),
      ],
    });

    const dots = screen
      .getAllByRole("tab")
      .map((t) => t.querySelector("[data-status]"));
    expect(dots.map((d) => d?.getAttribute("data-status"))).toEqual([
      "running",
      "waiting_for_input",
      "awaiting",
    ]);
  });

  it("shows ⌘1..⌘N hotkey hints for the first tabs (2.3)", () => {
    renderStrip();

    expect(screen.getByText("⌘1")).toBeInTheDocument();
    expect(screen.getByText("⌘2")).toBeInTheDocument();
    expect(screen.getByText("⌘3")).toBeInTheDocument();
  });

  it("falls back to a placeholder title for unnamed conversations", () => {
    renderStrip({
      workingSet: [convo("a", { name: null }), convo("b", { name: "  " })],
    });

    expect(screen.getAllByText("Untitled conversation")).toHaveLength(2);
  });

  it("activates a tab when its body is clicked (2.4)", () => {
    const { onActivate } = renderStrip();

    fireEvent.click(
      within(screen.getAllByRole("tab")[1]!).getByText("Conversation b"),
    );
    expect(onActivate).toHaveBeenCalledWith("b");
  });

  it("closes a tab without activating it (2.6/2.7 stopPropagation)", () => {
    const { onActivate, onClose } = renderStrip();

    const closers = screen.getAllByRole("button", { name: "Close tab" });
    expect(closers).toHaveLength(3);
    fireEvent.click(closers[1]!);
    expect(onClose).toHaveBeenCalledWith("b");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("enables the add control and fires onAddClick when not at cap (2.9)", () => {
    const { onAddClick } = renderStrip({ isAtCap: false });

    const add = screen.getByRole("button", { name: "Add conversation" });
    expect(add).toBeEnabled();
    expect(add).toHaveAttribute("title", "Add conversation");
    fireEvent.click(add);
    expect(onAddClick).toHaveBeenCalledTimes(1);
  });

  it("disables the add control with a limit tooltip at the cap (2.10)", () => {
    renderStrip({ isAtCap: true });

    const add = screen.getByRole("button", { name: "Add conversation" });
    expect(add).toBeDisabled();
    expect(add.getAttribute("title")).toContain("Tab limit reached");
  });

  describe("right-click rename", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function jsonOk(): Response {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    it("opens a context menu with a Rename action on right-click", () => {
      renderStrip();

      fireEvent.contextMenu(screen.getAllByRole("tab")[0]!);

      expect(screen.getByText("Rename…")).toBeInTheDocument();
    });

    it("renames a tab inline and PATCHes the rename endpoint on commit", async () => {
      const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(jsonOk());
      vi.stubGlobal("fetch", fetchSpy);

      renderStrip();

      fireEvent.contextMenu(screen.getAllByRole("tab")[0]!);
      fireEvent.click(screen.getByText("Rename…"));

      const input = screen.getByRole("textbox", {
        name: "Rename conversation",
      });
      fireEvent.change(input, { target: { value: "Renamed A" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          "/api/projects/proj/sessions/session-a/conversations/a/rename",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ name: "Renamed A" }),
          }),
        );
      });
    });

    it("cancels inline rename on Escape without calling the rename API", () => {
      const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(jsonOk());
      vi.stubGlobal("fetch", fetchSpy);

      renderStrip();

      fireEvent.contextMenu(screen.getAllByRole("tab")[0]!);
      fireEvent.click(screen.getByText("Rename…"));

      const input = screen.getByRole("textbox", {
        name: "Rename conversation",
      });
      fireEvent.change(input, { target: { value: "Discarded" } });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(
        screen.queryByRole("textbox", { name: "Rename conversation" }),
      ).toBeNull();
      expect(screen.getByText("Conversation a")).toBeInTheDocument();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("context menu parity with the Active Conversations menu", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function jsonResponse(body: unknown): Response {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    it("shows the full conversation menu on right-click", () => {
      renderStrip();

      fireEvent.contextMenu(screen.getAllByRole("tab")[0]!);

      for (const label of [
        "Open conversation",
        "Open project page",
        "Filter sidebar to session: session-a",
        "Copy branch name",
        "Copy worktree path",
        "Copy context",
        "Copy Conversation Reference",
        "Rename…",
        "Archive conversation",
        "Archive Other Conversations",
        "Archive session",
      ]) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
    });

    it("activates the tab through Open conversation", () => {
      const { onActivate } = renderStrip();

      fireEvent.contextMenu(screen.getAllByRole("tab")[1]!);
      fireEvent.click(screen.getByText("Open conversation"));

      expect(onActivate).toHaveBeenCalledWith("b");
    });

    it("routes Open project page through the router", () => {
      renderStrip();

      fireEvent.contextMenu(screen.getAllByRole("tab")[0]!);
      fireEvent.click(screen.getByText("Open project page"));

      expect(routerPushMock).toHaveBeenCalledWith("/projects/proj");
    });

    it("archives the clicked conversation via the archive endpoint", async () => {
      const fetchSpy = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ ok: true }));
      vi.stubGlobal("fetch", fetchSpy);

      renderStrip();

      fireEvent.contextMenu(screen.getAllByRole("tab")[0]!);
      fireEvent.click(screen.getByText("Archive conversation"));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          "/api/projects/proj/sessions/session-a/conversations/a/archive",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ archived: true }),
          }),
        );
      });
    });

    it("archives every sibling via the archive-others endpoint", async () => {
      const fetchSpy = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ ok: true, archivedIds: [] }));
      vi.stubGlobal("fetch", fetchSpy);

      renderStrip();

      fireEvent.contextMenu(screen.getAllByRole("tab")[0]!);
      fireEvent.click(screen.getByText("Archive Other Conversations"));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          "/api/projects/proj/sessions/session-a/conversations/a/archive-others",
          expect.objectContaining({ method: "POST" }),
        );
      });
    });

    it("copies the canonical conversation-ref XML to the clipboard", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });
      const lookupItem = {
        projectName: "proj",
        projectPath: "/tmp/proj",
        sessionName: "session-a",
        worktreePath: "/tmp/proj/.worktrees/x",
        conversationId: "a",
        conversationName: "Conversation a",
        summary: null,
        firstPromptSnippet: null,
        backend: "claude",
        backendRef: { backend: "claude", ref: "claude-sess-a" },
        transcriptPath: null,
        debugLogPath: null,
        status: "running",
        lastActivityAt: "2026-06-14T00:00:00.000Z",
        archived: false,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: RequestInfo | URL) => {
          if (String(url).includes("/api/conversations/a")) {
            return jsonResponse(lookupItem);
          }
          return jsonResponse([]);
        }),
      );

      renderStrip();

      fireEvent.contextMenu(screen.getAllByRole("tab")[0]!);
      fireEvent.click(screen.getByText("Copy Conversation Reference"));

      await waitFor(() => {
        expect(writeText).toHaveBeenCalled();
      });
      const copied = writeText.mock.calls[0]![0];
      expect(copied).toContain("<conversation-ref ");
      expect(copied).toContain('conversation-id="a"');
      expect(copied).toContain(
        'read-command="cctl conversation read a --outline"',
      );
    });

    it("archives the session only after confirmation", async () => {
      const fetchSpy = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ ok: true }));
      vi.stubGlobal("fetch", fetchSpy);

      renderStrip();

      fireEvent.contextMenu(screen.getAllByRole("tab")[0]!);
      fireEvent.click(screen.getByText("Archive session"));

      // No mutation before the confirm dialog is accepted.
      expect(fetchSpy).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Archive session" }));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          "/api/projects/proj/sessions/session-a/archive",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ archived: true }),
          }),
        );
      });
    });
  });
});
