// @vitest-environment jsdom
//
// R6.5's display half at PROJECT scope: a project conversation states which
// agent profile it is running under, and a legacy one states that it has none.
//
// This drives the REAL cockpit from the query the real project page reads, so
// what is asserted is the chip a user sees on a project conversation — the
// scope that has no session strip to fall back on. R6.3 rides along: the
// rendered document must never contain the profile's instruction text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import ProjectCockpit from "./ProjectCockpit";
import { _useCockpitViewStore } from "./use-cockpit-view-state";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { useProjectConversationsQuery } from "@/lib/project-conversations-client/queries";
import {
  publicConversationStateSchema,
  type PublicConversationState,
} from "@/lib/conversations/schemas";
import {
  PROFILE_SECRET_SENTINEL,
  REDACTED_SNAPSHOT_FIXTURE,
} from "@/lib/conversations/testing/profile-snapshot-fixtures";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { FilterToken } from "../components/filter-tokens";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", effort: "medium" },
  codex: { modelId: "gpt-5.6-sol", effort: "ultra" },
  cursor: { modelId: "composer-2.5", effort: "high" },
};

const session: SessionListItem = {
  sessionName: "auth",
  worktreePath: "/tmp/auth",
  branchName: "csm/auth",
  targetBranch: "main",
  parentSessionName: null,
  createdAt: "2026-01-01T00:00:00Z",
  lastActivityAt: "2026-01-01T00:00:00Z",
  archived: false,
  finished: false,
  source: "cc",
  creationMode: "normal",
  tddEnabled: true,
  derivedStatus: "running",
  promptCount: 1,
  derivedLastActivityAt: "2026-01-01T00:00:00Z",
  collabContribution: null,
  hasActiveGraphWorkflow: false,
};

/**
 * Built through the PUBLIC schema, which is the shape the project conversations
 * query hands the cockpit — a fixture that hand-rolled a stored row would be
 * asserting against data this surface never receives.
 */
function publicConversation(
  id: string,
  overrides: Record<string, unknown> = {},
): PublicConversationState {
  return publicConversationStateSchema.parse({
    id,
    scope: "project",
    name: id,
    transcriptPath: null,
    status: "new",
    promptCount: 2,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    open: true,
    ...overrides,
  });
}

function seededClient(conversations: PublicConversationState[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const conversation of conversations) {
    client.setQueryData(
      projectConversationKeys.messages("proj", conversation.id),
      [],
    );
  }
  client.setQueryData(projectConversationKeys.list("proj"), conversations);
  return client;
}

function PageHarness() {
  const [tokens, setTokens] = useState<FilterToken[]>([]);
  const [backend, setBackend] = useState<AgentBackendId>("claude");
  const conversationsQuery = useProjectConversationsQuery("proj");
  const openConversations = conversationsQuery.data ?? [];
  return (
    <ProjectCockpit
      conversationCreations={openConversations.map((c) => ({
        conversationId: c.id,
        creationRequestId: null,
      }))}
      projectName="proj"
      sessions={[session]}
      archivedCount={0}
      tokens={tokens}
      onTokensChange={setTokens}
      onRunCommand={vi.fn()}
      selectedBackend={backend}
      onSelectedBackendChange={setBackend}
      backendDefaults={BACKEND_DEFAULTS}
      openConversations={openConversations}
      rail={<div data-testid="rail-stub" />}
    />
  );
}

function renderCockpit(conversations: PublicConversationState[]) {
  render(
    <QueryClientProvider client={seededClient(conversations)}>
      <PageHarness />
    </QueryClientProvider>,
  );
  const viewTabs = screen.getByRole("tablist", { name: "Project view" });
  fireEvent.click(within(viewTabs).getByRole("tab", { name: /Conversations/ }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  _useCockpitViewStore.getState()._reset();
  useSessionDetailStore.getState().resetStore();
});

describe("project conversation profile identity", () => {
  it("states that a legacy project conversation has no profile", () => {
    renderCockpit([publicConversation("plc-legacy")]);

    expect(
      screen.getByLabelText("Agent profile: No profile"),
    ).toBeInTheDocument();
  });

  it("names the profile a project conversation runs under, redacted", () => {
    renderCockpit([
      publicConversation("plc-profiled", {
        redactedProfileSnapshot: REDACTED_SNAPSHOT_FIXTURE,
        profileLockedAt: "2026-01-01T00:05:00.000Z",
      }),
    ]);

    // Name AND source tier: the fixture is a project-tier profile, and a name
    // on its own would not say which sibling scope it came from (R8.2).
    expect(
      screen.getByLabelText(
        `Agent profile: ${REDACTED_SNAPSHOT_FIXTURE.name} (Project)`,
      ),
    ).toBeInTheDocument();
    // The chip is fed the redacted snapshot only, so there is no path from the
    // rendered document to the instructions behind it (R6.3).
    expect(document.body.innerHTML).not.toContain(PROFILE_SECRET_SENTINEL);
  });
});

/**
 * Tiptap attaches its EditorView in an async effect, so the `.ProseMirror` node
 * appears a tick after render; a plain-text paste is how a jsdom test gets
 * content into it.
 */
async function typeAndSend(text: string) {
  const editor = await waitFor(
    () => {
      const node = document.querySelector(
        ".prompt-editor__content .ProseMirror",
      );
      expect(node).not.toBeNull();
      return node as HTMLElement;
    },
    { timeout: 5000 },
  );
  fireEvent.paste(editor, {
    clipboardData: {
      items: [],
      files: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  const send = screen.getByTestId("prompt-send");
  await waitFor(() => expect(send).not.toBeDisabled());
  fireEvent.click(send);
}

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// R7.1: the cockpit's create-and-send composer is a construction site with no
// tab strip to hang a picker off, and it was the one visible fresh-conversation
// path that could not name a profile.
describe("project create-and-send profile selection", () => {
  beforeEach(() => {
    if (typeof Range !== "undefined") {
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
    }
  });

  it("offers a Standard-Agent-defaulted picker beside the separate runtime controls when no conversation is open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ profiles: [], diagnostics: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    renderCockpit([]);

    expect(
      await screen.findByRole("combobox", { name: /agent profile/i }),
    ).toHaveTextContent("Standard Agent");
    // Identity and runtime are two selections on one creation: the composer's
    // own backend toggle stays where it is.
    expect(document.querySelector(".backend-toggle")).not.toBeNull();
  });

  it("sends the explicit Standard Agent default with the first prompt", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "/api/projects/proj/prompt") {
        return sseResponse(["event: done\ndata: {}\n\n"]);
      }
      return new Response(JSON.stringify({ profiles: [], diagnostics: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    renderCockpit([]);

    await typeAndSend("start something");

    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          ([url]) => String(url) === "/api/projects/proj/prompt",
        ),
      ).toBe(true),
    );
    const call = fetchSpy.mock.calls.find(
      ([url]) => String(url) === "/api/projects/proj/prompt",
    );
    // Omitting a selection means the Standard Agent explicitly, on the wire —
    // never an absent field the server has to infer from (R7.1).
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      prompt: "start something",
      profile: { tier: "builtin", id: "standard-agent" },
    });
  });
});
