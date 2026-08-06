// @vitest-environment jsdom
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ticketKeys } from "@/lib/tickets/query-keys";
import type { TicketAttachment, TicketDetail } from "@/lib/tickets/schemas";
import AttachmentDialog from "./AttachmentDialog";

Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

function installFetch(
  options: {
    failAttachmentPost?: boolean;
    failSessionsOnce?: boolean;
  } = {},
) {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  let sessionFailuresLeft = options.failSessionsOnce ? 1 : 0;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      );
      const method = init?.method?.toUpperCase() ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ method, url: url.pathname, body });
      if (url.pathname === "/api/voice/health") {
        return Response.json({ available: true });
      }
      if (url.pathname === "/api/voice/transcribe") {
        return Response.json({ text: "Dictated markdown" });
      }
      if (
        method === "POST" &&
        url.pathname === "/api/projects/command-center/tickets/12/attachments"
      ) {
        if (options.failAttachmentPost) {
          return Response.json(
            { error: "Attachment could not be saved." },
            { status: 500 },
          );
        }
        return Response.json({
          id: "attachment-1",
          ticketId: "ticket-12",
          description: (body as { description: string }).description,
          payload: {
            kind: "conversation",
            projectPath: "/repos/command-center",
            sessionName: "csm/ticket-context",
            conversationId: "conv-ticket-context",
            snapshotKey: "ticket-content/ticket-12/attachment-1",
            snapshotCapturedAt: "2026-07-11T10:00:00.000Z",
          },
          createdAt: "2026-07-11T10:00:00.000Z",
          updatedAt: "2026-07-11T10:00:00.000Z",
        });
      }
      if (url.pathname === "/api/conversations/all") {
        return Response.json({
          items: [
            {
              projectName: "command-center",
              projectPath: "/repos/command-center",
              scope: "session",
              sessionName: "csm/ticket-context",
              worktreePath: "/repos/command-center/.worktrees/ticket-context",
              conversationId: "conv-ticket-context",
              conversationName: "Ticket context review",
              summary: null,
              firstPromptSnippet: "Review the attachment flow",
              backend: "claude",
              backendRef: null,
              transcriptPath: null,
              debugLogPath: null,
              status: "awaiting",
              lastActivityAt: "2026-07-11T10:00:00.000Z",
              archived: false,
            },
          ],
          totalCount: 1,
        });
      }
      if (url.pathname === "/api/projects") {
        return Response.json([
          {
            name: "command-center",
            path: "/repos/command-center",
            activeSessions: 1,
            hasRunningSession: false,
          },
        ]);
      }
      if (url.pathname === "/api/projects/command-center/sessions") {
        if (sessionFailuresLeft > 0) {
          sessionFailuresLeft -= 1;
          return Response.json(
            { error: "Session discovery failed." },
            { status: 500 },
          );
        }
        return Response.json({
          sessions: [
            {
              sessionName: "csm/ticket-context",
              worktreePath: "/repos/command-center/.worktrees/ticket-context",
              branchName: "csm/ticket-context",
              targetBranch: "main",
              parentSessionName: null,
              createdAt: "2026-07-10T10:00:00.000Z",
              lastActivityAt: "2026-07-11T10:00:00.000Z",
              archived: false,
              finished: false,
              source: "cc",
              creationMode: "normal",
              tddEnabled: true,
              derivedStatus: "awaiting",
              promptCount: 4,
              derivedLastActivityAt: "2026-07-11T10:00:00.000Z",
              collabContribution: null,
              hasActiveGraphWorkflow: false,
              spawnedFrom: null,
            },
          ],
        });
      }
      if (url.pathname === "/api/projects/command-center/conversations") {
        return Response.json([
          {
            id: "project-conversation",
            scope: "project",
            name: "Project planning",
            transcriptPath: null,
            status: "awaiting",
            promptCount: 3,
            createdAt: "2026-07-10T10:00:00.000Z",
            lastActivityAt: "2026-07-11T11:00:00.000Z",
            source: "cc",
            summary: null,
            archived: false,
            open: true,
            totalCostUsd: null,
            totalDurationMs: null,
            totalTurns: null,
            pendingQuestionId: null,
            pendingQuestions: null,
            pendingPromptText: null,
            unread: false,
            pendingQueue: [],
            forkedFrom: null,
            role: null,
            activeTurnSource: null,
            contextTokens: null,
            contextWindowMax: null,
            debugMode: null,
            agentBackend: "claude",
            backendRef: null,
            lastSeenAlignmentVersion: null,
          },
        ]);
      }
      if (url.pathname === "/api/projects/command-center/tickets") {
        return Response.json([
          {
            id: "ticket-9",
            projectPath: "/repos/command-center",
            projectName: "command-center",
            number: 9,
            title: "Reconnect ticket event stream",
            workType: "bug",
            status: "not_started",
            attachmentCount: 2,
            activeSessionName: null,
            createdAt: "2026-07-09T10:00:00.000Z",
            updatedAt: "2026-07-11T10:00:00.000Z",
          },
        ]);
      }
      return Response.json({ error: "not mocked" }, { status: 404 });
    },
  );
  return requests;
}

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AttachmentDialog
        projectName="command-center"
        number={12}
        open
        onOpenChange={() => {}}
        onFileSubmit={() => {}}
      />
    </QueryClientProvider>,
  );
}

const BASE_DETAIL: TicketDetail = {
  id: "ticket-12",
  projectPath: "/repos/command-center",
  projectName: "command-center",
  number: 12,
  title: "Harden ticket context",
  description: "",
  workType: "feature",
  status: "not_started",
  createdAt: "2026-07-10T10:00:00.000Z",
  updatedAt: "2026-07-11T10:00:00.000Z",
  attachments: [],
  sessions: [],
};

const CREATED_ATTACHMENT: TicketAttachment = {
  id: "attachment-note",
  ticketId: "ticket-12",
  description: "Old pending note",
  payload: { kind: "note", markdown: "Old pending markdown" },
  createdAt: "2026-07-11T11:00:00.000Z",
  updatedAt: "2026-07-11T11:00:00.000Z",
};

function renderDeferredAttachment() {
  let resolve: (response: Response) => void = () => {
    throw new Error("Attachment request has not started");
  };
  vi.stubGlobal(
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") {
        return Response.json({ error: "not mocked" }, { status: 404 });
      }
      return await new Promise<Response>((requestResolve) => {
        resolve = requestResolve;
      });
    },
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(
    ticketKeys.detail("command-center", 12),
    BASE_DETAIL,
  );

  function Harness(): React.JSX.Element {
    const [open, setOpen] = useState(false);
    return (
      <QueryClientProvider client={queryClient}>
        <button type="button" onClick={() => setOpen(true)}>
          Open attachment dialog
        </button>
        <AttachmentDialog
          projectName="command-center"
          number={12}
          open={open}
          onOpenChange={setOpen}
          onFileSubmit={() => {}}
        />
      </QueryClientProvider>
    );
  }

  render(<Harness />);
  return { queryClient, resolve: (response: Response) => resolve(response) };
}

async function submitCloseAndReopenAttachment(): Promise<void> {
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Open attachment dialog" }),
  );
  await user.click(await screen.findByRole("radio", { name: "Note" }));
  await user.type(
    screen.getByRole("textbox", { name: "Markdown" }),
    "Old pending markdown",
  );
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    "Old pending note",
  );
  await user.click(screen.getByRole("button", { name: "Attach" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Attach" })).toBeDisabled(),
  );

  await user.click(screen.getByRole("button", { name: "Cancel" }));
  const opener = screen.getByRole("button", {
    name: "Open attachment dialog",
  });
  await waitFor(() => expect(document.activeElement).toBe(opener));
  await user.click(opener);
  expect(await screen.findByRole("dialog")).toHaveTextContent("Add context");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AttachmentDialog", () => {
  it("routes the visible Attach action through active dictation", async () => {
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
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }),
      },
    });
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const requests = installFetch();
    renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: "Note" }));
    await user.type(
      screen.getByRole("textbox", { name: "Description" }),
      "Voice note",
    );
    await user.click((await screen.findAllByTitle("Voice input"))[0]!);
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    await user.click(screen.getByRole("button", { name: "Attach" }));

    await waitFor(() =>
      expect(
        requests.find(
          (request) =>
            request.method === "POST" &&
            request.url ===
              "/api/projects/command-center/tickets/12/attachments",
        )?.body,
      ).toMatchObject({
        description: "Voice note",
        payload: { kind: "note", markdown: "Dictated markdown" },
      }),
    );
  });

  it("does not let the multiline submit chord bypass required fields", async () => {
    const requests = installFetch();
    renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: "Note" }));
    const markdown = await screen.findByLabelText("Markdown");
    await user.type(markdown, "Useful context");
    await user.type(markdown, "{Control>}{Enter}{/Control}");
    expect(
      requests.filter((request) => request.method === "POST"),
    ).toHaveLength(0);

    await user.type(screen.getByLabelText("Description"), "Why this matters");
    await user.type(markdown, "{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(
        requests.filter((request) => request.method === "POST"),
      ).toHaveLength(1),
    );
  });

  it("programmatically identifies every field required by the selected attachment kind", async () => {
    installFetch();
    renderDialog();
    const user = userEvent.setup();

    expect(screen.getByLabelText("File")).toBeRequired();
    expect(screen.getByLabelText("Description")).toBeRequired();

    await user.click(screen.getByRole("radio", { name: "Conversation" }));
    expect(
      await screen.findByRole("combobox", { name: "Project" }),
    ).toHaveAttribute("aria-required", "true");
    expect(
      screen.getByRole("combobox", { name: "Conversation" }),
    ).toHaveAttribute("aria-required", "true");

    await user.click(screen.getByRole("radio", { name: "Session" }));
    expect(
      await screen.findByRole("combobox", { name: "Session" }),
    ).toHaveAttribute("aria-required", "true");

    await user.click(screen.getByRole("radio", { name: "Related ticket" }));
    expect(
      await screen.findByRole("combobox", { name: "Related ticket" }),
    ).toHaveAttribute("aria-required", "true");

    await user.click(screen.getByRole("radio", { name: "Note" }));
    expect(await screen.findByLabelText("Markdown")).toBeRequired();
  });

  it("announces an asynchronous attachment failure", async () => {
    installFetch({ failAttachmentPost: true });
    renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: "Note" }));
    await user.type(screen.getByLabelText("Markdown"), "Failed context");
    await user.type(screen.getByLabelText("Description"), "Failed note");
    await user.click(screen.getByRole("button", { name: "Attach" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Attachment could not be saved",
    );
  });

  it("announces picker failures and lets the user retry discovery", async () => {
    installFetch({ failSessionsOnce: true });
    renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: "Session" }));
    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("Couldn't load sessions");

    await user.click(
      within(failure).getByRole("button", { name: "Retry sessions" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Session" })).toBeEnabled(),
    );
  });

  it("associates visible picker labels with their select controls", async () => {
    installFetch();
    renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: "Conversation" }));

    const projectSelect = (await screen.findByRole("combobox", {
      name: "Project",
    })) as HTMLButtonElement;
    const conversationSelect = screen.getByRole("combobox", {
      name: "Conversation",
    }) as HTMLButtonElement;
    expect(projectSelect.labels?.[0]).toHaveTextContent("Project");
    expect(conversationSelect.labels?.[0]).toHaveTextContent("Conversation");
  });

  it("discovers and submits a conversation without opaque identity fields", async () => {
    const requests = installFetch();
    renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: "Conversation" }));
    expect(
      screen.queryByRole("textbox", { name: "Conversation id" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: /Session name \(optional\)/ }),
    ).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole("combobox", { name: "Conversation" }),
    );
    await user.click(
      await screen.findByRole("option", { name: /Ticket context review/ }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Description" }),
      "Context from the review",
    );
    await user.click(screen.getByRole("button", { name: "Attach" }));

    await waitFor(() =>
      expect(
        requests.find((request) => request.method === "POST")?.body,
      ).toEqual({
        description: "Context from the review",
        payload: {
          kind: "conversation",
          projectName: "command-center",
          sessionName: "csm/ticket-context",
          conversationId: "conv-ticket-context",
        },
      }),
    );
  });

  it("includes session-less project conversations and submits a null session", async () => {
    const requests = installFetch();
    renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: "Conversation" }));
    await user.click(
      await screen.findByRole("combobox", { name: "Conversation" }),
    );
    await user.click(
      await screen.findByRole("option", { name: /Project planning/ }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Description" }),
      "Project-level planning context",
    );
    await user.click(screen.getByRole("button", { name: "Attach" }));

    await waitFor(() =>
      expect(
        requests.find((request) => request.method === "POST")?.body,
      ).toEqual({
        description: "Project-level planning context",
        payload: {
          kind: "conversation",
          projectName: "command-center",
          sessionName: null,
          conversationId: "project-conversation",
        },
      }),
    );
  });

  it("selects a session by project and visible session name", async () => {
    installFetch();
    renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: "Session" }));

    expect(
      await screen.findByRole("combobox", { name: "Project" }),
    ).toHaveTextContent("command-center");
    expect(
      screen.getByRole("combobox", { name: "Session" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Session name" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Session" }));
    expect(
      await screen.findByRole("option", { name: /csm\/ticket-context/ }),
    ).toBeInTheDocument();
  });

  it("selects a related ticket by project, identifier, and title", async () => {
    installFetch();
    renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: "Related ticket" }));

    expect(
      await screen.findByRole("combobox", { name: "Related ticket" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Ticket number" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Related ticket" }));
    expect(
      await screen.findByRole("option", {
        name: /command-center#9.*Reconnect ticket event stream/,
      }),
    ).toBeInTheDocument();
  });

  it("keeps a reopened form fresh when an older attachment succeeds", async () => {
    const deferred = renderDeferredAttachment();
    await submitCloseAndReopenAttachment();

    await act(async () => {
      deferred.resolve(Response.json(CREATED_ATTACHMENT, { status: 201 }));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Description" }),
      ).toBeEnabled(),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("Add context");
    expect(screen.getByRole("radio", { name: "File" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
      "",
    );
    expect(
      deferred.queryClient.getQueryData<TicketDetail>(
        ticketKeys.detail("command-center", 12),
      )?.attachments,
    ).toEqual([CREATED_ATTACHMENT]);
  });

  it("does not inject an older attachment error into a reopened form", async () => {
    const deferred = renderDeferredAttachment();
    await submitCloseAndReopenAttachment();

    await act(async () => {
      deferred.resolve(
        Response.json(
          { error: "Old attachment failed after the dialog closed." },
          { status: 500 },
        ),
      );
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Description" }),
      ).toBeEnabled(),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("Add context");
    expect(
      screen.queryByText("Old attachment failed after the dialog closed."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
      "",
    );
  });
});
