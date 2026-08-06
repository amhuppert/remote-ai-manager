// @vitest-environment jsdom
//
// R7.1: the session overview's header is a visible fresh-conversation path, so
// it offers the same shared picker every other creation surface does — beside
// its one-click control rather than in front of it, because that control is
// hotkeyed and defaults to the Standard Agent.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  screen,
  waitFor,
  within,
  cleanup,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import { createHotkeyDispatcher } from "@/lib/hotkeys/dispatcher";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { graphWorkflowExecutionKeys } from "@/lib/workflows/query-keys";
import ConversationList from "./ConversationList";

const routerPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/projects/my-app/build-hotkeys",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

const CREATE_URL = "/api/projects/my-app/sessions/build-hotkeys/conversations";

const createdConversation = {
  id: "created-1",
  scope: "session",
  name: "created-1",
  transcriptPath: null,
  status: "new",
  promptCount: 0,
  createdAt: "2026-07-01T09:00:00.000Z",
  lastActivityAt: "2026-07-01T09:00:00.000Z",
  open: true,
};

const fetchSpy = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchInterval: false },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(sessionKeys.detail("my-app", "build-hotkeys"), {
    sessionName: "build-hotkeys",
    worktreePath: "/repos/my-app/.worktrees/build-hotkeys",
    branchName: "csm/build-hotkeys",
    targetBranch: "main",
    parentSessionName: null,
    createdAt: "2026-07-01T09:00:00.000Z",
    lastActivityAt: "2026-07-01T10:00:00.000Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    graphWorkflowExecution: null,
    referenceDocuments: [],
  });
  queryClient.setQueryData(
    conversationKeys.list("my-app", "build-hotkeys"),
    [],
  );
  queryClient.setQueryData(conversationKeys.active(), {
    conversations: [],
    graphWorkflowExecutions: [],
    activeCollaborationExecutions: [],
    specExecutions: [],
  });
  queryClient.setQueryData(
    graphWorkflowExecutionKeys.detail("my-app", "build-hotkeys"),
    null,
  );
  render(
    <HotkeyProvider dispatcher={createHotkeyDispatcher()}>
      <QueryClientProvider client={queryClient}>
        <ConversationList projectName="my-app" sessionName="build-hotkeys" />
      </QueryClientProvider>
    </HotkeyProvider>,
  );
}

beforeEach(() => {
  routerPush.mockClear();
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === CREATE_URL && init?.method === "POST") {
      return jsonResponse(createdConversation, 201);
    }
    return jsonResponse({ profiles: [], diagnostics: [] });
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function createBodies(): unknown[] {
  return fetchSpy.mock.calls
    .filter(
      ([url, init]) =>
        String(url) === CREATE_URL &&
        (init as RequestInit | undefined)?.method === "POST",
    )
    .map(([, init]) =>
      JSON.parse(String((init as RequestInit | undefined)?.body ?? "null")),
    );
}

/**
 * The page also mounts the conversations rail, which carries its own copy of
 * the shared picker — so every query here is scoped to the header's own
 * affordance rather than to whichever control the document happens to list
 * first.
 */
function header(): HTMLElement {
  return screen.getByRole("group", { name: "Start a conversation" });
}

describe("session overview new-conversation profile selection", () => {
  it("offers a Standard-Agent-defaulted picker beside the one-click control and creates under the chosen profile", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      within(header()).getByRole("button", {
        name: /choose an agent profile/i,
      }),
    );
    expect(
      await screen.findByRole("combobox", { name: /agent profile/i }),
    ).toHaveTextContent("Standard Agent");

    await user.click(
      screen.getByRole("button", { name: /create conversation/i }),
    );

    await waitFor(() => expect(createBodies()).toHaveLength(1));
    expect(createBodies()[0]).toEqual({
      profile: { tier: "builtin", id: "standard-agent" },
    });
  });

  it("keeps the one-click control creating without a selection", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      within(header()).getByRole("button", { name: /New Conversation/i }),
    );

    await waitFor(() => expect(createBodies()).toHaveLength(1));
    expect(createBodies()[0]).toEqual({});
  });
});
