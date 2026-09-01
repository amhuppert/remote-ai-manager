// @vitest-environment jsdom
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

import { registerSpecSseReactions } from "@/lib/specs/sse-reactions";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import type { TicketDetail } from "@/lib/tickets/schemas";
import { ticketKeys } from "@/lib/tickets/query-keys";
import { useToastStoreForTesting } from "@/stores/toast.store";
import TicketDetailView from "./TicketDetailView";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", parameters: { effort: "medium" } },
  codex: {
    modelId: "gpt-5.6-sol",
    parameters: { reasoning: "ultra", fast: "false" },
  },
  cursor: { modelId: "composer-2.5", parameters: { fast: "true" } },
};

const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: navigation.push,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/tickets/command-center/12",
  useSearchParams: () => new URLSearchParams(),
}));

const DETAIL: TicketDetail = {
  id: "ticket-12",
  projectPath: "/repos/command-center",
  projectName: "command-center",
  number: 12,
  title: "Recover the ticket view",
  description: "",
  workType: "feature",
  status: "not_started",
  createdAt: "2026-07-11T10:00:00.000Z",
  updatedAt: "2026-07-11T10:00:00.000Z",
  attachments: [],
  sessions: [],
  relationships: [],
  statusUpdates: { total: 0, recent: [] },
};

afterEach(() => {
  cleanup();
  navigation.push.mockReset();
  vi.unstubAllGlobals();
  useToastStoreForTesting.setState({ toasts: [] });
});

function renderDetail(
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  }),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TicketDetailView
        projectName="command-center"
        number={12}
        defaultAgentBackend="claude"
        backendDefaults={BACKEND_DEFAULTS}
      />
    </QueryClientProvider>,
  );
}

describe("TicketDetailView loading failures", () => {
  it("offers a retry for a non-not-found failure", async () => {
    let detailRequests = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      ).pathname;
      if (path === "/api/projects/command-center/tickets/12") {
        detailRequests += 1;
        if (detailRequests === 1) {
          return Response.json(
            { error: "Ticket service unavailable." },
            { status: 503 },
          );
        }
        return Response.json(DETAIL);
      }
      if (path.endsWith("/tickets/session-links")) return Response.json({});
      if (path === "/api/notifications") {
        return Response.json({ notifications: [], total: 0, unreadCount: 0 });
      }
      if (path === "/api/conversations/active") {
        return Response.json({
          conversations: [],
          graphWorkflowExecutions: [],
          activeCollaborationExecutions: [],
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TicketDetailView
          projectName="command-center"
          number={12}
          defaultAgentBackend="claude"
          backendDefaults={BACKEND_DEFAULTS}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();

    const failure = await screen.findByRole("alert");
    await user.click(
      within(failure).getByRole("button", { name: "Retry ticket" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Recover the ticket view" }),
    ).toBeInTheDocument();
  });

  it("does not label an unverified live session as ended when liveness fails", async () => {
    const detailWithSession: TicketDetail = {
      ...DETAIL,
      sessions: [
        {
          id: "link-1",
          ticketId: DETAIL.id,
          projectPath: DETAIL.projectPath,
          sessionName: "ticket-12-recover-1",
          sessionCreatedAt: "2026-07-11T10:00:01.000Z",
          startMode: "prepared",
          linkedAt: "2026-07-11T10:00:01.000Z",
          endedAt: null,
          endReason: null,
        },
      ],
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      ).pathname;
      if (path.endsWith("/tickets/session-links")) {
        return Response.json(
          { error: "Session liveness unavailable." },
          { status: 503 },
        );
      }
      return Response.json(detailWithSession);
    });

    renderDetail();

    const sessions = await screen.findByRole("region", { name: "Sessions" });
    expect(
      await within(sessions).findByText("Session status unavailable"),
    ).toBeInTheDocument();
    expect(
      within(sessions).getByRole("button", { name: "Retry sessions" }),
    ).toBeInTheDocument();
    expect(within(sessions).getByText("status unknown")).toBeInTheDocument();
    expect(within(sessions).queryByText("ended")).not.toBeInTheDocument();
  });

  it("stops trusting cached active liveness after a refresh fails", async () => {
    const detailWithSession: TicketDetail = {
      ...DETAIL,
      sessions: [
        {
          id: "link-1",
          ticketId: DETAIL.id,
          projectPath: DETAIL.projectPath,
          sessionName: "ticket-12-recover-1",
          sessionCreatedAt: "2026-07-11T10:00:01.000Z",
          startMode: "prepared",
          linkedAt: "2026-07-11T10:00:01.000Z",
          endedAt: null,
          endReason: null,
        },
      ],
    };
    let linksRequests = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      ).pathname;
      if (path.endsWith("/tickets/session-links")) {
        linksRequests += 1;
        if (linksRequests > 1) {
          return Response.json(
            { error: "Session liveness unavailable." },
            { status: 503 },
          );
        }
        return Response.json({
          "ticket-12-recover-1": {
            ticketId: DETAIL.id,
            projectName: DETAIL.projectName,
            number: DETAIL.number,
            title: DETAIL.title,
            linkedAt: "2026-07-11T10:00:01.000Z",
            endedAt: null,
            active: true,
          },
        });
      }
      return Response.json(detailWithSession);
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderDetail(queryClient);

    const sessions = await screen.findByRole("region", { name: "Sessions" });
    expect(await within(sessions).findByText("active")).toBeInTheDocument();

    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ticketKeys.sessionLinks(DETAIL.projectName),
      });
    });

    expect(
      await within(sessions).findByText("Session status unavailable"),
    ).toBeInTheDocument();
    expect(within(sessions).getByText("status unknown")).toBeInTheDocument();
    expect(within(sessions).queryByText("active")).not.toBeInTheDocument();
  });

  it("does not infer ended from a conservative negative liveness result", async () => {
    const detailWithLegacyOpenLink: TicketDetail = {
      ...DETAIL,
      sessions: [
        {
          id: "legacy-link-1",
          ticketId: DETAIL.id,
          projectPath: DETAIL.projectPath,
          sessionName: "ticket-12-legacy-1",
          sessionCreatedAt: null,
          startMode: "prepared",
          linkedAt: "2026-07-11T10:00:01.000Z",
          endedAt: null,
          endReason: null,
        },
      ],
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      ).pathname;
      if (path.endsWith("/tickets/session-links")) return Response.json({});
      return Response.json(detailWithLegacyOpenLink);
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderDetail(queryClient);

    const sessions = await screen.findByRole("region", { name: "Sessions" });
    await waitFor(() =>
      expect(
        queryClient.getQueryState(ticketKeys.sessionLinks(DETAIL.projectName))
          ?.status,
      ).toBe("success"),
    );
    expect(within(sessions).getByText("status unknown")).toBeInTheDocument();
    expect(within(sessions).queryByText("ended")).not.toBeInTheDocument();
  });
});

describe("TicketDetailView mutation feedback", () => {
  it("reports a delete failure after optimistic navigation unmounts the dossier", async () => {
    let resolveDelete: ((response: Response) => void) | null = null;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      ).pathname;
      if (init?.method === "DELETE") {
        return new Promise<Response>((resolve) => {
          resolveDelete = resolve;
        });
      }
      if (path.endsWith("/tickets/session-links")) {
        return Promise.resolve(Response.json({}));
      }
      return Promise.resolve(Response.json(DETAIL));
    });
    const view = renderDetail();
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: DETAIL.title });
    await user.click(screen.getByRole("button", { name: "Delete ticket" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() => expect(resolveDelete).not.toBeNull());
    view.unmount();
    await act(async () => {
      resolveDelete!(
        Response.json({ error: "delete failed" }, { status: 500 }),
      );
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        useToastStoreForTesting
          .getState()
          .toasts.some((toast) => toast.message.includes("Couldn't delete")),
      ).toBe(true),
    );
  });

  it("reports the first failure when rapid field changes overlap", async () => {
    const patchResolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      ).pathname;
      if (init?.method === "PATCH") {
        return new Promise<Response>((resolve) => patchResolvers.push(resolve));
      }
      if (path.endsWith("/tickets/session-links")) {
        return Promise.resolve(Response.json({}));
      }
      return Promise.resolve(Response.json(DETAIL));
    });
    renderDetail();
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: DETAIL.title });
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "Blocked" }));
    await user.click(screen.getByRole("combobox", { name: "Work type" }));
    await user.click(await screen.findByRole("option", { name: "Bug" }));

    await waitFor(() => expect(patchResolvers).toHaveLength(1));
    await act(async () => {
      patchResolvers[0]!(
        Response.json({ error: "status failed" }, { status: 500 }),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(patchResolvers).toHaveLength(2));
    await act(async () => {
      patchResolvers[1]!(
        Response.json({
          ...DETAIL,
          workType: "bug",
          updatedAt: "2026-07-11T10:00:01.000Z",
        }),
      );
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        useToastStoreForTesting
          .getState()
          .toasts.some((toast) => toast.message.includes("Blocked")),
      ).toBe(true),
    );
  });
});

describe("TicketDetailView collaboration sections", () => {
  it("orders description, status updates, relationships, and context attachments", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      ).pathname;
      if (path.endsWith("/status-updates")) {
        return Response.json({ items: [], total: 0, nextCursor: null });
      }
      if (path.endsWith("/tickets/session-links")) return Response.json({});
      if (path.includes("/ticket-read-through/")) {
        return Response.json({ specs: [] });
      }
      return Response.json(DETAIL);
    });
    renderDetail();

    await screen.findByRole("heading", { name: DETAIL.title });
    const sections = [
      screen.getByRole("region", { name: "Description" }),
      screen.getByRole("region", { name: "Status updates" }),
      screen.getByRole("region", { name: "Relationships" }),
      screen.getByRole("region", { name: "Context attachments" }),
    ];
    expect(
      sections.every(
        (section, index) =>
          index === 0 ||
          Boolean(
            sections[index - 1]!.compareDocumentPosition(section) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ),
      ),
    ).toBe(true);
  });

  it("explains relationship, update, hierarchy, and linked-ticket deletion effects", async () => {
    const detail: TicketDetail = {
      ...DETAIL,
      relationships: [
        {
          id: "relationship-1",
          role: "child",
          otherTicket: {
            id: "ticket-13",
            projectName: DETAIL.projectName,
            number: 13,
            title: "Child ticket",
            status: "not_started",
          },
          description: "",
          createdAt: DETAIL.createdAt,
          updatedAt: DETAIL.updatedAt,
        },
      ],
      statusUpdates: { total: 4, recent: [] },
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      ).pathname;
      if (path.endsWith("/status-updates")) {
        return Response.json({ items: [], total: 4, nextCursor: null });
      }
      if (path.endsWith("/tickets/session-links")) return Response.json({});
      if (path.includes("/ticket-read-through/")) {
        return Response.json({ specs: [] });
      }
      return Response.json(detail);
    });
    renderDetail();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: "Delete ticket" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("1 relationship");
    expect(dialog).toHaveTextContent("4 status updates");
    expect(dialog).toHaveTextContent("children become top-level");
    expect(dialog).toHaveTextContent("Linked tickets are not deleted");
  });
});

describe("TicketDetailView spec read-through", () => {
  it("renders linked spec state from the read-through query and keeps both references citable", async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(
          typeof input === "string" ? input : input.toString(),
          "http://localhost",
        ).pathname;
        methods.push(init?.method ?? "GET");
        if (path.endsWith("/tickets/session-links")) return Response.json({});
        if (path === "/api/specs/command-center/ticket-read-through/12") {
          return Response.json({
            specs: [
              {
                specId: "spec-1",
                slug: "native-sdd",
                name: "Native SDD",
                revision: 4,
                phase: { primary: "executing", authoringFacet: "draft" },
                criteriaProgress: { proven: 7, total: 12 },
                linkedTasks: [
                  {
                    taskElementId: "task-17",
                    taskHandle: "T17",
                    sourceTaskState: "current",
                    workStatus: "running",
                  },
                ],
              },
            ],
          });
        }
        return Response.json(DETAIL);
      },
    );
    renderDetail();
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");

    const specs = await screen.findByRole("region", { name: "Specs" });
    expect(
      await within(specs).findByRole("link", {
        name: /Native SDD.*Executing.*Draft/,
      }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd");
    expect(within(specs).getByText("7/12 criteria proven")).toBeInTheDocument();
    expect(within(specs).getByText("Running")).toBeInTheDocument();
    // The linked task is cited by its spec handle, never the raw element id.
    expect(within(specs).getByText("T17")).toBeInTheDocument();
    expect(within(specs).queryByText("task-17")).toBeNull();

    await user.click(
      within(specs).getByRole("button", { name: "Copy reference" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining(
          '<spec-ref project-name="command-center" slug="native-sdd"',
        ),
      ),
    );
    expect(
      screen.getByRole("button", { name: "Copy ticket reference" }),
    ).toBeInTheDocument();
    expect(methods).not.toContain("PATCH");
  });

  it("refreshes amendment-driven source-task state from spec SSE without a ticket sync", async () => {
    let amended = false;
    let ticketWrites = 0;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(
          typeof input === "string" ? input : input.toString(),
          "http://localhost",
        ).pathname;
        if (init?.method === "PATCH") ticketWrites += 1;
        if (path.endsWith("/tickets/session-links")) return Response.json({});
        if (path === "/api/specs/command-center/ticket-read-through/12") {
          return Response.json({
            specs: [
              {
                specId: "spec-1",
                slug: "native-sdd",
                name: "Native SDD",
                revision: amended ? 5 : 4,
                phase: { primary: amended ? "draft" : "approved" },
                criteriaProgress: { proven: amended ? 0 : 1, total: 1 },
                linkedTasks: [
                  {
                    taskElementId: "task-17",
                    taskHandle: "T17",
                    sourceTaskState: amended ? "removed" : "current",
                    workStatus: "pending",
                  },
                ],
              },
            ],
          });
        }
        return Response.json(DETAIL);
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const events = new FakeEventSource("/api/events");
    registerSpecSseReactions(events as unknown as EventSource, { queryClient });
    renderDetail(queryClient);

    const specs = await screen.findByRole("region", { name: "Specs" });
    expect(within(specs).queryByText("Source task removed")).toBeNull();
    amended = true;
    act(() => {
      events.emit("spec-changed", {
        type: "spec-changed",
        projectPath: DETAIL.projectPath,
        specId: "spec-1",
        specSlug: "native-sdd",
        occurredAt: "2026-07-18T18:00:00.000Z",
        kind: "draft-written",
        revisionId: "revision-5",
        elementIds: ["task-17"],
      });
    });

    expect(
      await within(specs).findByText("Source task removed"),
    ).toBeInTheDocument();
    expect(within(specs).getByText("Draft")).toBeInTheDocument();
    expect(ticketWrites).toBe(0);
  });

  it("refreshes linked task status from workflow SSE without refresh or polling", async () => {
    let workStatus: "pending" | "completed" = "pending";
    let readThroughRequests = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      ).pathname;
      if (path.endsWith("/tickets/session-links")) return Response.json({});
      if (path === "/api/specs/command-center/ticket-read-through/12") {
        readThroughRequests += 1;
        return Response.json({
          specs: [
            {
              specId: "spec-1",
              slug: "native-sdd",
              name: "Native SDD",
              revision: 4,
              phase: { primary: "executing", authoringFacet: "draft" },
              criteriaProgress: { proven: 1, total: 1 },
              linkedTasks: [
                {
                  taskElementId: "task-17",
                  taskHandle: "T17",
                  sourceTaskState: "current",
                  workStatus,
                },
              ],
            },
          ],
        });
      }
      return Response.json(DETAIL);
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const events = new FakeEventSource("/api/events");
    registerSpecSseReactions(events as unknown as EventSource, { queryClient });
    renderDetail(queryClient);

    const specs = await screen.findByRole("region", { name: "Specs" });
    expect(await within(specs).findByText("Pending")).toBeInTheDocument();
    expect(readThroughRequests).toBe(1);

    workStatus = "completed";
    act(() => {
      events.emit("graph-workflow-task-status", {
        type: "graph-workflow-task-status",
        projectName: DETAIL.projectName,
        sessionName: "native-sdd-execution",
        executionId: "workflow-execution-1",
        taskId: "spec-task-task-17",
        contextId: "context-task-17",
        status: "completed",
        source: "user",
        order: 1,
      });
    });

    expect(await within(specs).findByText("Completed")).toBeInTheDocument();
    expect(readThroughRequests).toBe(2);
  });

  it("graduates the ticket through the links service action and opens the seeded spec", async () => {
    let graduateBody: unknown;
    let finishGraduation: (() => void) | null = null;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(
          typeof input === "string" ? input : input.toString(),
          "http://localhost",
        ).pathname;
        if (path.endsWith("/tickets/session-links")) return Response.json({});
        if (path === "/api/specs/command-center/ticket-read-through/12") {
          return Response.json({ specs: [] });
        }
        if (
          path === "/api/specs/command-center/actions/graduate-ticket" &&
          init?.method === "POST"
        ) {
          graduateBody = JSON.parse(String(init.body));
          return new Promise<Response>((resolve) => {
            finishGraduation = () =>
              resolve(
                Response.json({
                  spec: {
                    id: "spec-graduated",
                    projectPath: DETAIL.projectPath,
                    slug: "ticket-12-recover-the-ticket-view",
                    name: DETAIL.title,
                    gatePolicy: { preset: "contract-bearing" },
                    abandonedAt: null,
                    abandonedReason: null,
                    createdAt: "2026-07-18T18:00:00.000Z",
                    updatedAt: "2026-07-18T18:00:00.000Z",
                  },
                  draft: {
                    id: "revision-1",
                    specId: "spec-graduated",
                    number: 1,
                    state: "draft",
                    authoringStage: "requirements",
                    basedOnRevisionId: null,
                    contentHash: null,
                    citationContractVersion: 2,
                    citationVersion: 1,
                    citationHash: "0".repeat(64),
                    proposedAt: null,
                    approvedAt: null,
                    createdAt: "2026-07-18T18:00:00.000Z",
                  },
                  reused: false,
                }),
              );
          });
        }
        return Response.json(DETAIL);
      },
    );
    renderDetail();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: "Graduate to spec" }),
    );
    expect(
      await screen.findByRole("button", { name: "Graduating…" }),
    ).toBeDisabled();
    act(() => finishGraduation?.());

    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith(
        "/specs/command-center/ticket-12-recover-the-ticket-view",
      ),
    );
    expect(graduateBody).toEqual({
      ticket: { projectName: DETAIL.projectName, number: DETAIL.number },
      slug: "ticket-12-recover-the-ticket-view",
      name: DETAIL.title,
      gatePolicy: { preset: "contract-bearing" },
    });
  });
});
