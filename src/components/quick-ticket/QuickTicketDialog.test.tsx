// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import { pastedImageDescription } from "@/lib/tickets/description-images";
import type { TicketDetail } from "@/lib/tickets/schemas";
import {
  useQuickTicketStore,
  type QuickTicketStoreState,
} from "@/stores/quick-ticket.store";
import { useToastStoreForTesting } from "@/stores/toast.store";
import QuickTicketDialog from "./QuickTicketDialog";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));

const RESET_STATE: QuickTicketStoreState = {
  open: false,
  lifecycleRevision: 0,
  bugMode: false,
  draft: null,
  draftStashed: false,
  draftRestored: false,
  contextSnapshot: null,
  conversationRegistry: [],
};

const CREATED_TICKET: TicketDetail = {
  id: "ticket-14",
  projectPath: "/repos/command-center",
  projectName: "command-center",
  number: 14,
  title: "Capture the failure",
  description: "Observed while filing a ticket.",
  workType: "bug",
  status: "not_started",
  createdAt: "2026-07-19T12:00:00.000Z",
  updatedAt: "2026-07-19T12:00:00.000Z",
  attachments: [],
  sessions: [],
};

const SCREENSHOT = {
  mediaType: "image/webp" as const,
  base64: btoa("RIFF\u0004\u0000\u0000\u0000WEBP"),
  width: 1200,
  height: 800,
};

const SECOND_SCREENSHOT = {
  ...SCREENSHOT,
  width: 800,
  height: 600,
};

let api: FetchFixture;

function installBaseRoutes(): void {
  api.json("GET", "/api/projects", [
    {
      name: "command-center",
      path: "/repos/command-center",
      activeSessions: 1,
      hasRunningSession: true,
    },
    {
      name: "other-project",
      path: "/repos/other-project",
      activeSessions: 0,
      hasRunningSession: false,
    },
  ]);
  api.json("GET", "/api/command-center-project", {
    projectName: "command-center",
  });
  api.json("GET", "/api/config", {
    config: {
      baseDir: "/repos",
      ignorePatterns: [],
      agentBackends: {
        claude: { model: "opus", reasoningEffort: "medium", timeoutMs: null },
        codex: {
          model: "gpt-5.6-sol",
          reasoningEffort: "ultra",
          timeoutMs: null,
        },
        cursor: { model: "composer-2.5", timeoutMs: null },
      },
      defaultAgentBackend: "claude",
    },
    raw: {},
  });
  api.json("GET", "/api/agent-backends", {
    backends: listBackendCatalogEntries(),
  });
}

function open(location = "/tickets"): void {
  window.history.replaceState({}, "", location);
  useQuickTicketStore.getState().openQuickTicket({
    pathname: window.location.pathname,
    searchParams: new URLSearchParams(window.location.search),
  });
}

beforeEach(() => {
  api = installFetchFixture();
  installBaseRoutes();
  navigation.push.mockReset();
  useQuickTicketStore.setState(RESET_STATE);
  useToastStoreForTesting.setState({ toasts: [] });
  document.body.replaceChildren();
  // Tiptap (the rich description editor) needs DOM measurement APIs jsdom
  // does not implement.
  document.elementFromPoint = () => document.body;
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  URL.createObjectURL = () => "blob:quick-ticket-test";
  URL.revokeObjectURL = () => {};
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  api.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("QuickTicketDialog", () => {
  it("validates project before title and focuses the first invalid field", async () => {
    open();
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Create ticket" }),
    );
    expect(screen.getByText("Choose an owning project.")).toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Project")),
    );

    await user.click(screen.getByLabelText("Project"));
    await user.click(
      await screen.findByRole("option", { name: "other-project" }),
    );
    await user.click(screen.getByRole("button", { name: "Create ticket" }));
    expect(screen.getByText("Title is required.")).toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Title")),
    );
  });

  it("explains a project discovery failure and focuses the selector after retry", async () => {
    let projectRequestCount = 0;
    let resolveRetry:
      | ((reply: { status: number; json: unknown }) => void)
      | null = null;
    api.reply("GET", "/api/projects", () => {
      projectRequestCount += 1;
      if (projectRequestCount === 1) {
        return {
          status: 503,
          json: { error: "Project discovery unavailable" },
        };
      }
      return new Promise((resolve) => {
        resolveRetry = resolve;
      });
    });
    open();
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    const discoveryAlert = await screen.findByRole("alert");
    expect(discoveryAlert).toHaveTextContent("Couldn't load projects.");
    expect(
      screen.queryByText("Choose an owning project."),
    ).not.toBeInTheDocument();
    const project = screen.getByLabelText("Project");
    expect(project).toBeDisabled();
    expect(project).toHaveAccessibleDescription(/Couldn't load projects/);
    expect(
      screen.getByRole("button", { name: "Create ticket" }),
    ).toBeDisabled();
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.keyDown(screen.getByLabelText("Title"), {
      key: "Enter",
      ctrlKey: true,
    });
    await waitFor(() => expect(document.activeElement).toBe(retry));
    expect(
      screen.queryByText("Choose an owning project."),
    ).not.toBeInTheDocument();

    await user.click(retry);
    const retrying = screen.getByRole("button", { name: "Retrying…" });
    expect(retrying).toBeDisabled();
    expect(retrying).toHaveAttribute("aria-busy", "true");
    act(() => {
      resolveRetry?.({
        status: 200,
        json: [
          {
            name: "other-project",
            path: "/repos/other-project",
            activeSessions: 0,
            hasRunningSession: false,
          },
        ],
      });
    });

    await waitFor(() => expect(project).toBeEnabled());
    await waitFor(() => expect(document.activeElement).toBe(project));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.requestsTo("GET", "/api/projects")).toHaveLength(2);
  });

  it("distinguishes an empty project discovery result and retries it", async () => {
    api.json("GET", "/api/projects", []);
    open();
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    const emptyMessage = await screen.findByText(
      "No projects were discovered.",
    );
    expect(emptyMessage.closest('[role="status"]')).not.toBeNull();
    expect(
      screen.queryByText("Choose an owning project."),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Create ticket" }),
    ).toBeDisabled();

    api.json("GET", "/api/projects", [
      {
        name: "other-project",
        path: "/repos/other-project",
        activeSessions: 0,
        hasRunningSession: false,
      },
    ]);
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByLabelText("Project")).toBeEnabled());
    expect(
      screen.queryByText("No projects were discovered."),
    ).not.toBeInTheDocument();
    expect(api.requestsTo("GET", "/api/projects")).toHaveLength(2);
  });

  it("retargets bug mode, previews all seven bundle facts, and restores removals", async () => {
    useQuickTicketStore.getState().registerQuickTicketConversation({
      token: "test-owner",
      projectName: "other-project",
      sessionName: "investigate",
      conversationId: "conversation-1",
      title: "Investigate the failure",
    });
    open("/projects/other-project/investigate");
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    const mode = await screen.findByRole("switch", {
      name: "Command Center bug report mode",
    });
    const dialog = screen.getByRole("dialog", { name: "New ticket" });
    expect(dialog).toHaveClass("max-768:h-[100dvh]");
    expect(dialog.querySelector("form")).toHaveClass("max-768:h-full");
    expect(
      screen.getByRole("checkbox", { name: "Start agent after create" }),
    ).toHaveAccessibleDescription(
      "Creates a session and sends the ticket kickoff prompt using the project's configured backend, model, and effort defaults.",
    );
    await waitFor(() => expect(mode).toBeEnabled());
    await user.click(mode);

    expect(mode).toBeChecked();
    expect(screen.getByText("7 of 7")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "File bug report" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Route and view state/ }),
    ).toHaveClass(
      "appearance-none",
      "border-0",
      "bg-transparent",
      "p-0",
      "text-inherit",
    );
    expect(useQuickTicketStore.getState().draft).toMatchObject({
      projectName: "command-center",
      workType: "bug",
    });
    await screen.findByText("1200 × 800");
    const bundleStatus = screen.getByRole("status", {
      name: "Diagnostic bundle status",
    });
    expect(bundleStatus).toHaveTextContent(
      "Diagnostic bundle: 7 of 7 items. Screenshot: 1200 × 800.",
    );
    expect(bundleStatus.closest("button")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Remove Screenshot from bundle" }),
    );
    expect(screen.getByText("6 of 7")).toBeInTheDocument();
    expect(bundleStatus).toHaveTextContent(
      "Diagnostic bundle: 6 of 7 items. Screenshot: excluded.",
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /^Client errors/ }),
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "Restore removed bundle items" }),
    );
    expect(screen.getByText("7 of 7")).toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Diagnostic bundle" }),
      ),
    );

    await user.click(mode);
    expect(useQuickTicketStore.getState().draft).toMatchObject({
      projectName: "other-project",
      workType: "feature",
    });
  });

  it("previews every sanitized client fact that the bug payload sends", async () => {
    const app = document.createElement("main");
    app.className = "app";
    app.dataset.pane = "conversation";
    const workflow = document.createElement("div");
    workflow.dataset.workflowExecutionId = "workflow-7";
    app.append(workflow);
    document.body.append(app);
    useQuickTicketStore.getState().registerQuickTicketConversation({
      token: "diagnostic-owner",
      projectName: "other-project",
      sessionName: "investigate",
      conversationId: "conversation-1",
      title: "Investigate the failure",
    });
    open("/projects/other-project/investigate?pane=conversation");
    const expectedUrl = window.location.href;
    api.reply("POST", "/api/projects/command-center/tickets", {
      status: 201,
      json: { ticket: CREATED_TICKET, warnings: [] },
    });
    const firstStackFrame = "at request (client.ts:7)";
    const secondStackFrame = "at submit (form.tsx:9)";
    const clientError = {
      ts: "2026-07-19T12:34:56.000Z",
      kind: "window" as const,
      message: "Request failed after sanitization",
      stackHead: [firstStackFrame, secondStackFrame],
    };
    const clientErrors = [clientError];
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog
        captureScreenshot={async () => SCREENSHOT}
        readClientErrors={() => clientErrors}
      />,
    );

    const mode = await screen.findByRole("switch", {
      name: "Command Center bug report mode",
    });
    await waitFor(() => expect(mode).toBeEnabled());
    await user.click(mode);

    await user.click(
      screen.getByRole("button", { name: /^Route and view state/ }),
    );
    expect(screen.getByText(/"pane":"conversation"/)).toBeInTheDocument();
    expect(
      screen.getByText("URL").parentElement?.querySelector("dd"),
    ).toHaveTextContent(expectedUrl);

    await user.click(
      screen.getByRole("button", { name: /^Active identities/ }),
    );
    expect(screen.getByText("workflow-7")).toBeInTheDocument();
    expect(
      screen.getByText("/projects/other-project/investigate"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("/projects/other-project/investigate/workflow"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("/conversations?c=conversation-1"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Client errors/ }));
    expect(screen.getByText(clientError.ts)).toBeInTheDocument();
    expect(screen.getByText(firstStackFrame)).toBeInTheDocument();
    expect(screen.getByText(secondStackFrame)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Title"), "Capture the failure");
    await user.click(screen.getByRole("button", { name: "File bug report" }));
    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/projects/command-center/tickets"),
      ).toHaveLength(1),
    );
    expect(
      api.requestsTo("POST", "/api/projects/command-center/tickets")[0]
        ?.jsonBody,
    ).toMatchObject({
      diagnostics: {
        route: {
          url: expectedUrl,
          viewState: '{"pane":"conversation"}',
        },
        identities: {
          workflowExecutionId: "workflow-7",
          deepLinks: [
            { label: "Project", href: "/projects/other-project" },
            {
              label: "Session",
              href: "/projects/other-project/investigate",
            },
            {
              label: "Conversation",
              href: "/conversations?c=conversation-1",
            },
            {
              label: "Workflow execution",
              href: "/projects/other-project/investigate/workflow",
            },
          ],
        },
        clientErrors,
      },
    });
  });

  it("keeps a removed conversation out of the bug bundle and create payload", async () => {
    useQuickTicketStore.getState().registerQuickTicketConversation({
      token: "conversation-owner",
      projectName: "other-project",
      sessionName: "investigate",
      conversationId: "conversation-1",
      title: "Investigate the failure",
    });
    open("/projects/other-project/investigate");
    api.reply("POST", "/api/projects/command-center/tickets", {
      status: 201,
      json: { ticket: CREATED_TICKET, warnings: [] },
    });
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Remove conversation context",
      }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("checkbox", { name: "Start agent after create" }),
      ),
    );
    const mode = screen.getByRole("switch", {
      name: "Command Center bug report mode",
    });
    await waitFor(() => expect(mode).toBeEnabled());
    await user.click(mode);

    expect(screen.getByText("6 of 7")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove Conversation from bundle" }),
    ).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Title"), "Capture the failure");
    await user.click(screen.getByRole("button", { name: "File bug report" }));
    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/projects/command-center/tickets"),
      ).toHaveLength(1),
    );
    const body = api.requestsTo(
      "POST",
      "/api/projects/command-center/tickets",
    )[0]?.jsonBody as Record<string, unknown>;
    expect(body).not.toHaveProperty("conversationContext");
    expect(body).toMatchObject({ diagnostics: { removed: ["conversation"] } });
  });

  it("submits canonical diagnostics with Cmd+Enter", async () => {
    open("/projects/other-project");
    api.reply("POST", "/api/projects/command-center/tickets", (request) => ({
      status: 201,
      json: {
        ticket: {
          ...CREATED_TICKET,
          title: (request.jsonBody as { title: string }).title,
        },
        warnings: [],
      },
    }));
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    const mode = await screen.findByRole("switch", {
      name: "Command Center bug report mode",
    });
    await waitFor(() => expect(mode).toBeEnabled());
    await user.click(mode);
    const title = screen.getByLabelText("Title");
    await user.type(title, "Capture the failure");
    fireEvent.keyDown(title, { key: "Enter", metaKey: true });

    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/projects/command-center/tickets"),
      ).toHaveLength(1),
    );
    const body = api.requestsTo(
      "POST",
      "/api/projects/command-center/tickets",
    )[0]?.jsonBody as Record<string, unknown>;
    expect(body).toMatchObject({
      title: "Capture the failure",
      workType: "bug",
      diagnostics: {
        screenshot: SCREENSHOT,
        removed: [],
        identities: { projectName: "other-project" },
      },
    });
    expect(body).not.toHaveProperty("autoStartRequested");
    expect(useQuickTicketStore.getState().open).toBe(false);
  });

  it("supports Ctrl+Enter as the non-Mac primary action", async () => {
    open("/projects/other-project");
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    const title = await screen.findByLabelText("Title");
    fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });

    expect(await screen.findByText("Title is required.")).toBeInTheDocument();
  });

  it("finalizes active description dictation before a button submission", async () => {
    class Recorder {
      static isTypeSupported(): boolean {
        return true;
      }
      state: RecordingState = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      start(): void {
        this.state = "recording";
      }
      stop(): void {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"]) } as BlobEvent);
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", Recorder);
    // Override targeted navigator properties rather than replacing the global
    // — Tiptap reads prototype-hosted fields (userAgent) a spread would drop.
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "Linux",
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    api.json("GET", "/api/voice/health", { available: true });
    api.json("POST", "/api/voice/transcribe", { text: "dictated" });
    api.reply("POST", "/api/projects/other-project/tickets", (request) => ({
      status: 201,
      json: {
        ticket: {
          ...CREATED_TICKET,
          projectName: "other-project",
          description: (request.jsonBody as { description: string })
            .description,
        },
        warnings: [],
      },
    }));
    open("/projects/other-project");
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await user.type(await screen.findByLabelText("Title"), "Voice report");
    await user.type(screen.getByLabelText("Description"), "Observed");
    await user.click(await screen.findByTitle("Voice input"));
    await screen.findByTitle("Stop recording");
    now.mockReturnValue(2_000);
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/projects/other-project/tickets"),
      ).toHaveLength(1),
    );
    expect(
      api.requestsTo("POST", "/api/projects/other-project/tickets")[0]
        ?.jsonBody,
    ).toMatchObject({ description: "Observed\ndictated" });
  });

  it("discards a stale capture and restarts it for a restored bug draft", async () => {
    let resolveFirstCapture: ((value: typeof SCREENSHOT) => void) | null = null;
    const captureScreenshot = vi
      .fn<() => Promise<typeof SCREENSHOT>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstCapture = resolve;
          }),
      )
      .mockResolvedValueOnce(SECOND_SCREENSHOT);
    open("/projects/other-project");
    api.reply("POST", "/api/projects/command-center/tickets", {
      status: 201,
      json: { ticket: CREATED_TICKET, warnings: [] },
    });
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={captureScreenshot} />,
    );

    const mode = await screen.findByRole("switch", {
      name: "Command Center bug report mode",
    });
    await waitFor(() => expect(mode).toBeEnabled());
    await user.click(mode);
    expect(await screen.findByText("Capturing page…")).toBeInTheDocument();
    act(() => {
      useQuickTicketStore.getState().closeQuickTicket({ stashDraft: true });
    });
    await waitFor(() =>
      expect(useQuickTicketStore.getState().open).toBe(false),
    );

    act(() => open("/tickets"));
    expect(await screen.findByText("Draft restored")).toBeInTheDocument();
    act(() => resolveFirstCapture?.(SCREENSHOT));

    await waitFor(() => expect(captureScreenshot).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("800 × 600")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Title"), "Capture the failure");
    await user.click(screen.getByRole("button", { name: "File bug report" }));

    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/projects/command-center/tickets"),
      ).toHaveLength(1),
    );
    expect(
      api.requestsTo("POST", "/api/projects/command-center/tickets")[0]
        ?.jsonBody,
    ).toMatchObject({ diagnostics: { screenshot: SECOND_SCREENSHOT } });
  });

  it("recaptures a ready screenshot when a bug draft is restored", async () => {
    const captureScreenshot = vi
      .fn<() => Promise<typeof SCREENSHOT>>()
      .mockResolvedValueOnce(SCREENSHOT)
      .mockResolvedValueOnce(SECOND_SCREENSHOT);
    open("/projects/other-project");
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={captureScreenshot} />,
    );

    const mode = await screen.findByRole("switch", {
      name: "Command Center bug report mode",
    });
    await waitFor(() => expect(mode).toBeEnabled());
    await user.click(mode);
    expect(await screen.findByText("1200 × 800")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Title"), "Keep this bug draft");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(useQuickTicketStore.getState().open).toBe(false),
    );

    act(() => open("/tickets"));
    await waitFor(() => expect(captureScreenshot).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("800 × 600")).toBeInTheDocument();
  });

  it("keeps screenshot capture failure non-blocking", async () => {
    open("/projects/other-project");
    api.reply("POST", "/api/projects/command-center/tickets", {
      status: 201,
      json: { ticket: CREATED_TICKET, warnings: [] },
    });
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog
        captureScreenshot={async () => {
          throw new Error("canvas unavailable");
        }}
      />,
    );

    const mode = await screen.findByRole("switch", {
      name: "Command Center bug report mode",
    });
    await waitFor(() => expect(mode).toBeEnabled());
    await user.click(mode);
    expect(await screen.findByText("Capture failed")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Title"), "Capture the failure");
    await user.click(screen.getByRole("button", { name: "File bug report" }));

    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/projects/command-center/tickets"),
      ).toHaveLength(1),
    );
    const body = api.requestsTo(
      "POST",
      "/api/projects/command-center/tickets",
    )[0]?.jsonBody as Record<string, unknown>;
    expect(body).toHaveProperty("diagnostics");
    expect(body).not.toHaveProperty("diagnostics.screenshot");
  });

  it("freezes bundle restoration while create is pending", async () => {
    let resolveCreate:
      | ((reply: { status: number; json: unknown }) => void)
      | null = null;
    open("/projects/other-project");
    api.reply(
      "POST",
      "/api/projects/command-center/tickets",
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    const mode = await screen.findByRole("switch", {
      name: "Command Center bug report mode",
    });
    await waitFor(() => expect(mode).toBeEnabled());
    await user.click(mode);
    await user.click(
      screen.getByRole("button", { name: "Remove Screenshot from bundle" }),
    );
    await user.type(screen.getByLabelText("Title"), "Capture the failure");
    await user.click(screen.getByRole("button", { name: "File bug report" }));
    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/projects/command-center/tickets"),
      ).toHaveLength(1),
    );

    expect(
      screen.getByRole("button", { name: "Restore removed bundle items" }),
    ).toBeDisabled();
    expect(screen.getByText("6 of 7")).toBeInTheDocument();

    act(() => {
      resolveCreate?.({
        status: 201,
        json: { ticket: CREATED_TICKET, warnings: [] },
      });
    });
    await waitFor(() =>
      expect(useQuickTicketStore.getState().open).toBe(false),
    );
  });

  it("creates then reconciles auto-start using configured server defaults", async () => {
    useQuickTicketStore.getState().registerQuickTicketConversation({
      token: "conversation-owner",
      projectName: "command-center",
      sessionName: "capture-bug",
      conversationId: "conversation-source",
      title: "Capture the bug",
    });
    open("/projects/command-center/capture-bug");
    api.reply("POST", "/api/projects/command-center/tickets", (request) => ({
      status: 201,
      json: {
        ticket: {
          ...CREATED_TICKET,
          title: (request.jsonBody as { title: string }).title,
        },
        warnings: [],
      },
    }));
    api.json("POST", "/api/projects/command-center/tickets/14/start", {
      ticket: { ...CREATED_TICKET, status: "in_progress" },
      sessionName: "ticket-capture-the-failure",
      conversationId: "conversation-started",
      initialPromptQueued: true,
    });
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await user.type(
      await screen.findByLabelText("Title"),
      "Capture the failure",
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Start agent after create" }),
    );
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/projects/command-center/tickets/14/start"),
      ).toHaveLength(1),
    );
    expect(
      api.requestsTo("POST", "/api/projects/command-center/tickets")[0]
        ?.jsonBody,
    ).toMatchObject({
      autoStartRequested: true,
      conversationContext: {
        sourceProjectName: "command-center",
        sessionName: "capture-bug",
        conversationId: "conversation-source",
      },
    });
    expect(
      api.requestsTo("POST", "/api/projects/command-center/tickets/14/start")[0]
        ?.jsonBody,
    ).toEqual({
      mode: "agent",
      backend: "claude",
      model: "opus",
      reasoningEffort: "medium",
      // The untouched picker still names the Standard Agent on the wire (R7.1).
      profile: { tier: "builtin", id: "standard-agent" },
    });
    await waitFor(() =>
      expect(useToastStoreForTesting.getState().toasts.at(-1)).toMatchObject({
        message: "Agent queued on command-center#14",
        action: { label: "Open conversation" },
      }),
    );
    expect(
      useToastStoreForTesting
        .getState()
        .toasts.some(
          (toast) =>
            toast.message === "command-center#14 created — starting agent…",
        ),
    ).toBe(false);
    expect(useToastStoreForTesting.getState().toasts).toHaveLength(1);
    act(() => {
      useToastStoreForTesting.getState().toasts.at(-1)?.action?.onClick();
    });
    expect(navigation.push).toHaveBeenCalledWith(
      "/conversations?c=conversation-started",
    );
  });

  it("reveals kickoff controls prefilled from configured defaults while auto-start is checked", async () => {
    open("/projects/command-center");
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    const autoStart = await screen.findByRole("checkbox", {
      name: "Start agent after create",
    });
    expect(
      screen.queryByTestId("model-selector-trigger"),
    ).not.toBeInTheDocument();

    await user.click(autoStart);
    expect(await screen.findByTestId("model-selector-label")).toHaveTextContent(
      /^Opus 5$/,
    );
    expect(screen.getByTestId("effort-selector-label")).toHaveTextContent(
      /^Medium$/,
    );
    expect(screen.getByRole("button", { name: "Claude" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(autoStart).toHaveAccessibleDescription(
      "Creates a session and sends the ticket kickoff prompt with the agent configured below.",
    );

    await user.click(autoStart);
    expect(
      screen.queryByTestId("model-selector-trigger"),
    ).not.toBeInTheDocument();
  });

  // R7.1: the quick-ticket kickoff path offers the picker on its Standard Agent
  // default, beside — not merged into — the backend/model/effort controls.
  it("reveals a Standard-Agent-defaulted profile picker with the kickoff controls", async () => {
    open("/projects/command-center");
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    const autoStart = await screen.findByRole("checkbox", {
      name: "Start agent after create",
    });
    expect(
      screen.queryByRole("combobox", { name: /agent profile/i }),
    ).not.toBeInTheDocument();

    await user.click(autoStart);

    expect(
      await screen.findByRole("combobox", { name: /agent profile/i }),
    ).toHaveTextContent("Standard Agent");
    expect(screen.getByTestId("model-selector-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("effort-selector-trigger")).toBeInTheDocument();
  });

  it("switches kickoff defaults per backend, clamps effort per model, and sends the selection", async () => {
    open("/projects/command-center");
    api.reply("POST", "/api/projects/command-center/tickets", {
      status: 201,
      json: { ticket: CREATED_TICKET, warnings: [] },
    });
    api.json("POST", "/api/projects/command-center/tickets/14/start", {
      ticket: { ...CREATED_TICKET, status: "in_progress" },
      sessionName: "ticket-capture-the-failure",
      conversationId: "conversation-started",
      initialPromptQueued: true,
    });
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await user.type(
      await screen.findByLabelText("Title"),
      "Capture the failure",
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Start agent after create" }),
    );
    await user.click(await screen.findByRole("button", { name: "Codex" }));
    expect(screen.getByTestId("model-selector-label")).toHaveTextContent(
      /^GPT-5\.6 Sol$/,
    );
    expect(screen.getByTestId("effort-selector-label")).toHaveTextContent(
      /^Ultra$/,
    );

    await user.click(screen.getByTestId("model-selector-trigger"));
    await user.click(
      await screen.findByRole("option", { name: /GPT-5\.6 Terra/ }),
    );
    expect(screen.getByTestId("model-selector-label")).toHaveTextContent(
      /^GPT-5\.6 Terra$/,
    );
    expect(screen.getByTestId("effort-selector-label")).toHaveTextContent(
      /^High$/,
    );

    await user.click(screen.getByRole("button", { name: "Create ticket" }));
    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/projects/command-center/tickets/14/start"),
      ).toHaveLength(1),
    );
    expect(
      api.requestsTo("POST", "/api/projects/command-center/tickets/14/start")[0]
        ?.jsonBody,
    ).toEqual({
      mode: "agent",
      backend: "codex",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      profile: { tier: "builtin", id: "standard-agent" },
    });
  });

  it("omits kickoff overrides when the configuration is unavailable", async () => {
    api.reply("GET", "/api/config", {
      status: 500,
      json: { error: "Config unavailable" },
    });
    open("/projects/command-center");
    api.reply("POST", "/api/projects/command-center/tickets", {
      status: 201,
      json: { ticket: CREATED_TICKET, warnings: [] },
    });
    api.json("POST", "/api/projects/command-center/tickets/14/start", {
      ticket: { ...CREATED_TICKET, status: "in_progress" },
      sessionName: "ticket-capture-the-failure",
      conversationId: "conversation-started",
      initialPromptQueued: true,
    });
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await user.type(
      await screen.findByLabelText("Title"),
      "Capture the failure",
    );
    const autoStart = screen.getByRole("checkbox", {
      name: "Start agent after create",
    });
    await user.click(autoStart);
    expect(
      screen.queryByTestId("model-selector-trigger"),
    ).not.toBeInTheDocument();
    expect(autoStart).toHaveAccessibleDescription(
      "Creates a session and sends the ticket kickoff prompt using the project's configured backend, model, and effort defaults.",
    );

    await user.click(screen.getByRole("button", { name: "Create ticket" }));
    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/projects/command-center/tickets/14/start"),
      ).toHaveLength(1),
    );
    expect(
      api.requestsTo("POST", "/api/projects/command-center/tickets/14/start")[0]
        ?.jsonBody,
      // The runtime triple falls back to the server's configured defaults, but
      // identity does not depend on that configuration: the profile is the
      // library's own default and still travels explicitly.
    ).toEqual({
      mode: "agent",
      profile: { tier: "builtin", id: "standard-agent" },
    });
  });

  it("keeps a reopened draft interactive while the previous ticket starts", async () => {
    let resolveStart:
      | ((reply: {
          json: {
            ticket: TicketDetail;
            sessionName: string;
            conversationId: string;
            initialPromptQueued: boolean;
          };
        }) => void)
      | null = null;
    open("/projects/command-center");
    api.reply("POST", "/api/projects/command-center/tickets", {
      status: 201,
      json: { ticket: CREATED_TICKET, warnings: [] },
    });
    api.reply(
      "POST",
      "/api/projects/command-center/tickets/14/start",
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await user.type(
      await screen.findByLabelText("Title"),
      "Capture the failure",
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Start agent after create" }),
    );
    await user.click(screen.getByRole("button", { name: "Create ticket" }));
    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/projects/command-center/tickets/14/start"),
      ).toHaveLength(1),
    );

    act(() => open("/projects/command-center"));
    expect(await screen.findByLabelText("Title")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Create ticket" })).toBeEnabled();

    act(() => {
      resolveStart?.({
        json: {
          ticket: { ...CREATED_TICKET, status: "in_progress" },
          sessionName: "ticket-capture-the-failure",
          conversationId: "conversation-started",
          initialPromptQueued: true,
        },
      });
    });
    await waitFor(() =>
      expect(
        useToastStoreForTesting
          .getState()
          .toasts.some((toast) => toast.message.startsWith("Agent queued on")),
      ).toBe(true),
    );
  });

  it("surfaces create warnings and a prepared session outcome", async () => {
    open("/projects/command-center");
    api.reply("POST", "/api/projects/command-center/tickets", {
      status: 201,
      json: {
        ticket: CREATED_TICKET,
        warnings: [
          {
            code: "conversation_source_unavailable",
            message: "Conversation context could not be attached.",
          },
        ],
      },
    });
    api.json("POST", "/api/projects/command-center/tickets/14/start", {
      ticket: { ...CREATED_TICKET, status: "in_progress" },
      sessionName: "ticket-capture-the-failure",
      conversationId: "conversation-started",
      initialPromptQueued: false,
    });
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await user.type(
      await screen.findByLabelText("Title"),
      "Capture the failure",
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Start agent after create" }),
    );
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    await waitFor(() => {
      const messages = useToastStoreForTesting
        .getState()
        .toasts.map((toast) => toast.message);
      expect(messages).toContain("Conversation context could not be attached.");
      expect(messages).toContain(
        "Session prepared — open it to send the kickoff prompt",
      );
    });
  });

  it("treats active_session as a successful auto-start reconciliation", async () => {
    open("/projects/command-center");
    api.reply("POST", "/api/projects/command-center/tickets", {
      status: 201,
      json: { ticket: CREATED_TICKET, warnings: [] },
    });
    api.reply("POST", "/api/projects/command-center/tickets/14/start", {
      status: 409,
      json: {
        error: "A session is already active",
        code: "active_session",
        details: { sessionName: "ticket-capture-the-failure" },
      },
    });
    api.json("GET", "/api/projects/command-center/tickets/session-links", {
      "ticket-capture-the-failure": {
        ticketId: "ticket-14",
        projectName: "command-center",
        number: 14,
        title: "Capture the failure",
        active: true,
        linkedAt: "2026-07-19T12:00:01.000Z",
        endedAt: null,
      },
    });
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await user.type(
      await screen.findByLabelText("Title"),
      "Capture the failure",
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Start agent after create" }),
    );
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    await waitFor(() =>
      expect(
        useToastStoreForTesting
          .getState()
          .toasts.some(
            (toast) =>
              toast.message === "Agent already active on command-center#14",
          ),
      ).toBe(true),
    );
  });

  it("stashes a dirty dismissal and can discard the restored draft", async () => {
    open("/projects/other-project");
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await user.type(await screen.findByLabelText("Title"), "Keep this draft");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(useQuickTicketStore.getState()).toMatchObject({
        open: false,
        draftStashed: true,
      }),
    );

    act(() => {
      open("/tickets");
    });
    expect(await screen.findByText("Draft restored")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Keep this draft");
    await user.click(
      screen.getByRole("button", { name: "Discard restored draft" }),
    );
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(useQuickTicketStore.getState().draftRestored).toBe(false);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Title")),
    );
  });

  it("retargets a restored bug draft to the current Command Center project", async () => {
    open("/projects/other-project");
    useQuickTicketStore.getState().updateQuickTicketDraft({
      preBugProjectName: "other-project",
      preBugWorkType: "feature",
      projectName: "command-center-old",
      workType: "bug",
      title: "Keep this bug draft",
    });
    useQuickTicketStore.getState().setQuickTicketBugMode(true);
    useQuickTicketStore.getState().closeQuickTicket({ stashDraft: true });
    open("/tickets");
    api.json("GET", "/api/command-center-project", {
      projectName: "command-center-current",
    });

    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await waitFor(() =>
      expect(useQuickTicketStore.getState().draft).toMatchObject({
        projectName: "command-center-current",
        workType: "bug",
      }),
    );
    expect(useQuickTicketStore.getState().draftRestored).toBe(true);
  });

  it("leaves bug mode when its restored target is no longer resolvable", async () => {
    open("/projects/other-project");
    useQuickTicketStore.getState().updateQuickTicketDraft({
      preBugProjectName: "other-project",
      preBugWorkType: "feature",
      projectName: "command-center-old",
      workType: "bug",
      title: "Keep this bug draft",
    });
    useQuickTicketStore.getState().setQuickTicketBugMode(true);
    useQuickTicketStore.getState().closeQuickTicket({ stashDraft: true });
    open("/tickets");
    api.json("GET", "/api/command-center-project", { projectName: null });

    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await waitFor(() =>
      expect(useQuickTicketStore.getState()).toMatchObject({
        bugMode: false,
        draft: {
          projectName: "other-project",
          workType: "feature",
          title: "Keep this bug draft",
        },
      }),
    );
    expect(
      screen.getByText("unavailable on this instance"),
    ).toBeInTheDocument();
    const switchControl = screen.getByRole("switch", {
      name: "Command Center bug report mode",
    });
    expect(switchControl).toBeDisabled();
    expect(switchControl).toHaveAccessibleDescription(
      "unavailable on this instance",
    );
    const explanation = screen.getByLabelText(
      "Command Center bug report unavailable: The Command Center project isn't resolvable on this instance",
    );
    expect(explanation).toHaveAttribute("tabindex", "0");
    act(() => explanation.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "The Command Center project isn't resolvable on this instance",
    );
  });

  it("clears transient validation state when reopening a fresh draft", async () => {
    open();
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Create ticket" }),
    );
    expect(screen.getByText("Choose an owning project.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(useQuickTicketStore.getState().open).toBe(false),
    );

    act(() => open());
    expect(await screen.findByLabelText("Title")).toHaveValue("");
    expect(
      screen.queryByText("Choose an owning project."),
    ).not.toBeInTheDocument();
  });
});

describe("QuickTicketDialog pasted description images", () => {
  function buildClipboard(files: File[]): {
    items: DataTransferItem[];
    files: File[];
    getData: () => string;
    types: string[];
  } {
    const items = files.map(
      (f) =>
        ({
          kind: "file",
          type: f.type,
          getAsFile: () => f,
        }) as unknown as DataTransferItem,
    );
    return { items, files, getData: () => "", types: [] };
  }

  it("references the pasted image in the description and attaches it after create", async () => {
    api.reply("POST", "/api/projects/other-project/tickets", (request) => ({
      status: 201,
      json: {
        ticket: {
          ...CREATED_TICKET,
          projectName: "other-project",
          description: (request.jsonBody as { description: string })
            .description,
        },
        warnings: [],
      },
    }));
    api.json("POST", "/api/projects/other-project/tickets/14/attachments", {
      id: "att-img",
      ticketId: CREATED_TICKET.id,
      description: pastedImageDescription(1),
      payload: {
        kind: "file",
        fileName: "pasted-image-1.png",
        snapshotKey: "snap-att-img",
        mediaType: "image/png",
        sizeBytes: 7,
        sha256: "sha",
      },
      createdAt: "2026-07-19T12:00:01.000Z",
      updatedAt: "2026-07-19T12:00:01.000Z",
    });
    open("/projects/other-project");
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await user.type(await screen.findByLabelText("Title"), "Show the glitch");
    const editor = screen.getByLabelText("Description");
    await user.click(editor);
    await user.type(editor, "See ");
    fireEvent.paste(editor, {
      clipboardData: buildClipboard([
        new File(["payload"], "glitch.png", { type: "image/png" }),
      ]),
    });
    await screen.findByText("#1");

    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/projects/other-project/tickets"),
      ).toHaveLength(1),
    );
    const createBody = api.requestsTo(
      "POST",
      "/api/projects/other-project/tickets",
    )[0]?.jsonBody as { description: string };
    expect(createBody.description).toContain("See ");
    expect(createBody.description).toContain("[Image #1]");

    await waitFor(() =>
      expect(
        api.requestsTo(
          "POST",
          "/api/projects/other-project/tickets/14/attachments",
        ),
      ).toHaveLength(1),
    );
    const upload = api.requestsTo(
      "POST",
      "/api/projects/other-project/tickets/14/attachments",
    )[0]!;
    expect(upload.formBody).not.toBeNull();
    const metadata = JSON.parse(String(upload.formBody?.get("metadata"))) as {
      description: string;
      fileName: string;
      mediaType: string;
    };
    expect(metadata.description).toBe(pastedImageDescription(1));
    expect(metadata.fileName).toBe("pasted-image-1.png");
    expect(metadata.mediaType).toBe("image/png");
    expect(upload.formBody?.get("file")).toBeInstanceOf(File);
  });
});

describe("QuickTicketDialog queued context", () => {
  it("queues a note in the add-context dialog and attaches it after create", async () => {
    api.reply("POST", "/api/projects/other-project/tickets", {
      status: 201,
      json: {
        ticket: { ...CREATED_TICKET, projectName: "other-project" },
        warnings: [],
      },
    });
    api.json("POST", "/api/projects/other-project/tickets/14/attachments", {
      id: "att-note",
      ticketId: CREATED_TICKET.id,
      description: "Steps to reproduce",
      payload: { kind: "note", markdown: "## Repro\n1. open the page" },
      createdAt: "2026-07-19T12:00:01.000Z",
      updatedAt: "2026-07-19T12:00:01.000Z",
    });
    open("/projects/other-project");
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await user.type(await screen.findByLabelText("Title"), "Repro attached");
    await user.click(screen.getByRole("button", { name: "Add context" }));
    await user.click(await screen.findByRole("radio", { name: "Note" }));
    await user.type(screen.getByLabelText("Markdown"), "repro steps");
    await user.type(
      screen.getByLabelText("Description", {
        selector: "textarea",
      }),
      "Steps to reproduce",
    );
    await user.click(screen.getByRole("button", { name: "Attach" }));

    // The queued entry renders in the dialog before the ticket exists.
    expect(await screen.findByText("Steps to reproduce")).toBeInTheDocument();
    expect(
      api.requestsTo(
        "POST",
        "/api/projects/other-project/tickets/14/attachments",
      ),
    ).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    await waitFor(() =>
      expect(
        api.requestsTo(
          "POST",
          "/api/projects/other-project/tickets/14/attachments",
        ),
      ).toHaveLength(1),
    );
    expect(
      api.requestsTo(
        "POST",
        "/api/projects/other-project/tickets/14/attachments",
      )[0]?.jsonBody,
    ).toEqual({
      description: "Steps to reproduce",
      payload: { kind: "note", markdown: "repro steps" },
    });
  });

  it("removes a queued attachment before create", async () => {
    api.reply("POST", "/api/projects/other-project/tickets", {
      status: 201,
      json: {
        ticket: { ...CREATED_TICKET, projectName: "other-project" },
        warnings: [],
      },
    });
    open("/projects/other-project");
    const user = userEvent.setup();
    renderWithQuery(
      <QuickTicketDialog captureScreenshot={async () => SCREENSHOT} />,
    );

    await user.type(await screen.findByLabelText("Title"), "No context");
    await user.click(screen.getByRole("button", { name: "Add context" }));
    await user.click(await screen.findByRole("radio", { name: "Note" }));
    await user.type(screen.getByLabelText("Markdown"), "obsolete");
    await user.type(
      screen.getByLabelText("Description", { selector: "textarea" }),
      "Will be removed",
    );
    await user.click(screen.getByRole("button", { name: "Attach" }));
    await screen.findByText("Will be removed");

    await user.click(
      screen.getByRole("button", { name: "Remove queued context" }),
    );
    expect(screen.queryByText("Will be removed")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create ticket" }));
    await waitFor(() =>
      expect(
        api.requestsTo("POST", "/api/projects/other-project/tickets"),
      ).toHaveLength(1),
    );
    expect(
      api.requestsTo(
        "POST",
        "/api/projects/other-project/tickets/14/attachments",
      ),
    ).toHaveLength(0);
  });
});
