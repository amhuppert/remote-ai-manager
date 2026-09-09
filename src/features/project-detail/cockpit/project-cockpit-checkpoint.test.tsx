// @vitest-environment jsdom
//
// The PROJECT host's checkpoint wiring, driven through the real cockpit.
//
// A project conversation has no owning session, so the thing worth proving
// here is addressing: every checkpoint and evidence request it makes must go
// to `/api/projects/<name>/conversations/…` — a fabricated `/sessions/…` path
// would reach a different conversation or none at all.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getStaticBackendModelCatalog } from "@/lib/agent-backends/catalog";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import { loadGeneratedCursorModelCatalog } from "@/lib/agent-backends/cursor/model-catalog";
import type { BackendModelCatalog } from "@/lib/agent-backends/schemas";
import type { CheckpointPhase } from "@/lib/conversation-checkpoints/schemas";
import { checkpointReceiptFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";
import {
  publicConversationStateSchema,
  type PublicConversationState,
} from "@/lib/conversations/schemas";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { useProjectConversationsQuery } from "@/lib/project-conversations-client/queries";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { useSessionDetailStore } from "@/stores/session-detail.store";

import type { FilterToken } from "../components/filter-tokens";
import ProjectCockpit from "./ProjectCockpit";
import { _useCockpitViewStore } from "./use-cockpit-view-state";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", parameters: { effort: "medium" } },
  codex: {
    modelId: "gpt-5.6-sol",
    parameters: { reasoning: "ultra", fast: "false" },
  },
  cursor: { modelId: "composer-2.5", parameters: { fast: "true" } },
};

const CHECKPOINTS_BASE = "/api/projects/proj/conversations/plc-1/checkpoints";

function projectModelOptionsResponse() {
  const catalogs: Record<AgentBackendId, BackendModelCatalog> = {
    claude: getStaticBackendModelCatalog("claude"),
    codex: getStaticBackendModelCatalog("codex", BACKEND_DEFAULTS.codex),
    cursor: loadGeneratedCursorModelCatalog(),
  };
  return {
    backends: (["claude", "codex", "cursor"] as const).map((backend) => {
      const catalog = catalogs[backend];
      return {
        backend,
        models: catalog.models.map((model) => ({
          id: model.id,
          label: model.label,
          description: model.description ?? model.label,
          effortLevels: [],
        })),
        defaultModelId: BACKEND_DEFAULTS[backend].modelId,
        source: "catalog" as const,
        modelCatalog: catalog,
        defaultSelection: BACKEND_DEFAULTS[backend],
        diagnostics: [],
      };
    }),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const requestedUrls: string[] = [];

function stubFetch(phase: CheckpointPhase = "ready"): void {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/projects/proj/model-options") {
        return jsonResponse(projectModelOptionsResponse());
      }
      if (url.endsWith("/conversations/plc-1/context-artifacts")) {
        return jsonResponse([
          {
            id: "art-1",
            kind: "conversation_compaction",
            status: "complete",
            coveredEndSeq: 120,
            updatedAt: "2026-09-01T00:00:00.000Z",
            stale: false,
            staleBehindMessages: 0,
            outdated: false,
          },
        ]);
      }
      if (url.endsWith("/conversations/plc-1/queue")) {
        return jsonResponse({
          queued: true,
          message: { id: "queued-1" },
        });
      }
      if (url.startsWith(`${CHECKPOINTS_BASE}/eligibility`)) {
        return jsonResponse({
          eligible: true,
          refusals: [],
          active: null,
          hosted: true,
        });
      }
      if (url.startsWith(CHECKPOINTS_BASE)) {
        return jsonResponse({
          receipts: [
            checkpointReceiptFixture({
              operationId: "op-1",
              scope: "project",
              conversationId: "plc-1",
              phase,
            }),
          ],
          nextBefore: null,
        });
      }
      return jsonResponse({ profiles: [], diagnostics: [] });
    },
  );
}

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

function publicConversation(
  id: string,
  status: "new" | "running" = "new",
): PublicConversationState {
  return publicConversationStateSchema.parse({
    id,
    scope: "project",
    name: id,
    transcriptPath: null,
    status,
    promptCount: 2,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    open: true,
  });
}

function seededClient(conversations: PublicConversationState[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
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

function renderCockpit(
  conversation: PublicConversationState = publicConversation("plc-1"),
) {
  render(
    <QueryClientProvider client={seededClient([conversation])}>
      <PageHarness />
    </QueryClientProvider>,
  );
  const viewTabs = screen.getByRole("tablist", { name: "Project view" });
  fireEvent.click(within(viewTabs).getByRole("tab", { name: /Conversations/ }));
}

beforeEach(() => {
  // Tiptap measures selection rects on mount; JSDOM has no layout, so the real
  // composer only reaches an interactive state once Range reports something.
  if (typeof Range !== "undefined") {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  }
  requestedUrls.length = 0;
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  _useCockpitViewStore.getState()._reset();
  useSessionDetailStore.getState().resetStore();
});

describe("project cockpit checkpoint wiring", () => {
  it("shows the project conversation's checkpoint phase on its own chip", async () => {
    renderCockpit();

    expect(
      await screen.findByRole("button", {
        name: "Context checkpoint: Checkpoint ready — used by the next message",
      }),
    ).toBeInTheDocument();
  });

  it("addresses the project scope for every checkpoint request", async () => {
    renderCockpit();
    await screen.findByRole("button", {
      name: "Context checkpoint: Checkpoint ready — used by the next message",
    });

    const checkpointCalls = requestedUrls.filter((entry) =>
      entry.includes("/checkpoints"),
    );
    expect(checkpointCalls.length).toBeGreaterThan(0);
    expect(
      checkpointCalls.every((entry) => entry.includes("/conversations/plc-1/")),
    ).toBe(true);
    expect(checkpointCalls.some((entry) => entry.includes("/sessions/"))).toBe(
      false,
    );
  });

  it("offers Compact context now from the project host's checkpoint menu", async () => {
    renderCockpit();
    await screen.findByRole("button", {
      name: "Context checkpoint: Checkpoint ready — used by the next message",
    });

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /^Checkpoint$/ }));
    const item = await screen.findByRole("menuitem", {
      name: /Compact context now/,
    });
    expect(item).not.toHaveAttribute("aria-disabled", "true");
  });

  // Checkpoint maintenance is invisible to ordinary turn state: the manager
  // holds the conversation to build and retire, but no ordinary turn runs, so
  // `status` stays idle. Routing on status alone would send a direct prompt
  // into that hold and lose it to the manager's busy refusal. The conversation
  // here is deliberately IDLE — a `running` one would pass on turn state alone
  // and prove nothing about the checkpoint hold.
  it("queues a message through the server gate while a checkpoint builds on an idle conversation", async () => {
    vi.unstubAllGlobals();
    requestedUrls.length = 0;
    stubFetch("building");
    renderCockpit(publicConversation("plc-1"));
    await screen.findByRole("button", {
      name: "Context checkpoint: Building the checkpoint",
    });

    // Tiptap attaches its EditorView in an async effect, so the ProseMirror
    // node appears a tick after render; a paste is how JSDOM gets text in.
    const editor = await waitFor(() => {
      const node = document.querySelector(
        ".prompt-editor__content .ProseMirror",
      );
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    fireEvent.paste(editor, {
      clipboardData: {
        items: [],
        files: [],
        types: ["text/plain"],
        getData: (type: string) =>
          type === "text/plain" ? "queued during maintenance" : "",
      },
    });

    const send = screen.getByTestId("prompt-send");
    await waitFor(() => expect(send).not.toBeDisabled());
    fireEvent.click(send);

    await waitFor(() =>
      expect(
        requestedUrls.some(
          (entry) =>
            entry === "POST /api/projects/proj/conversations/plc-1/queue",
        ),
      ).toBe(true),
    );
    // Never the direct-send path, which the manager would refuse as busy.
    expect(requestedUrls.some((entry) => entry.endsWith("/plc-1/prompt"))).toBe(
      false,
    );
    // The checkpoint surface issued no write of its own to carry that message.
    expect(
      requestedUrls.filter(
        (entry) => entry.startsWith("POST ") && entry.includes("/checkpoints"),
      ),
    ).toEqual([]);
  });

  // The two actions are never collapsed: one retires the provider context, the
  // other writes a reading document and changes continuity not at all. The
  // session host has offered both from the start; a project conversation that
  // offered only the checkpoint would leave its artifact unreachable.
  it("offers the compaction artifact action separately from the checkpoint action", async () => {
    renderCockpit();
    await screen.findByRole("button", {
      name: "Context checkpoint: Checkpoint ready — used by the next message",
    });

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /^Checkpoint$/ }));

    const checkpointItem = await screen.findByRole("menuitem", {
      name: /Compact context now/,
    });
    const artifactItem = await screen.findByRole("menuitem", {
      name: /compaction artifact/i,
    });
    expect(checkpointItem).not.toBe(artifactItem);
    expect(artifactItem).not.toHaveAttribute("aria-disabled", "true");
  });

  it("refreshes the artifact at the project scope without touching checkpoints", async () => {
    renderCockpit();
    await screen.findByRole("button", {
      name: "Context checkpoint: Checkpoint ready — used by the next message",
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Checkpoint$/ }));
    await user.click(
      await screen.findByRole("menuitem", { name: /compaction artifact/i }),
    );

    await waitFor(() =>
      expect(
        requestedUrls.some(
          (entry) =>
            entry ===
            "POST /api/projects/proj/conversations/plc-1/context-artifacts",
        ),
      ).toBe(true),
    );
    // Writing a reading artifact starts no checkpoint operation.
    expect(
      requestedUrls.some(
        (entry) => entry.startsWith("POST ") && entry.includes("/checkpoints"),
      ),
    ).toBe(false);
  });

  // Unresolved queued delivery is resolved in the composer's queue review, and
  // the panel's job is to take the user there. A button rendered disabled
  // because the host wired no destination is a dead end at exactly the moment
  // the user most needs the recovery path.
  it("offers a live queue-review destination for unresolved delivery", async () => {
    vi.unstubAllGlobals();
    requestedUrls.length = 0;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requestedUrls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/api/projects/proj/model-options") {
          return jsonResponse(projectModelOptionsResponse());
        }
        if (url.startsWith(`${CHECKPOINTS_BASE}/eligibility`)) {
          return jsonResponse({
            eligible: false,
            refusals: [
              {
                code: "queue_review_required",
                reason: "A queued delivery for this checkpoint is unresolved.",
                operationId: "op-1",
                phase: "delivering",
              },
            ],
            active: null,
            hosted: true,
          });
        }
        if (url.startsWith(CHECKPOINTS_BASE)) {
          return jsonResponse({
            receipts: [
              checkpointReceiptFixture({
                operationId: "op-1",
                scope: "project",
                conversationId: "plc-1",
                phase: "delivering",
              }),
            ],
            nextBefore: null,
          });
        }
        return jsonResponse({ profiles: [], diagnostics: [] });
      },
    );
    renderCockpit();

    const chip = await screen.findByRole("button", {
      name: /Context checkpoint:/,
    });
    await userEvent.setup().click(chip);
    const dialog = await screen.findByRole("dialog");
    const review = await within(dialog).findByRole("button", {
      name: /Review queued messages/i,
    });
    expect(review).toBeEnabled();
  });

  it("opens the saved-checkpoint evidence at the project-scoped history routes", async () => {
    renderCockpit();
    const chip = await screen.findByRole("button", {
      name: "Context checkpoint: Checkpoint ready — used by the next message",
    });
    await userEvent.setup().click(chip);

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("link", { name: /raw export for seq 148/i }),
    ).toHaveAttribute(
      "href",
      "/api/projects/proj/conversations/plc-1/history/entries/148",
    );
    // Viewing evidence submits nothing.
    expect(requestedUrls.every((entry) => entry.startsWith("GET "))).toBe(true);
  });
});
