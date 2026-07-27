// @vitest-environment jsdom
/**
 * R7.2 over the REAL child and query path: the composer's capability drawer for
 * a project conversation.
 *
 * The claim is about which cascade the drawer resolves — a request — and about
 * whether an override recorded at that layer is reflected back. Both are
 * observable only through the production panels and the real capability query,
 * so nothing here stands in for an internal module; the stub is the network
 * boundary (`fetch`).
 */
import * as matchers from "@testing-library/jest-dom/matchers";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityViewResponse,
} from "@/lib/agent-capabilities/schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";

import ConversationAgentCapabilitiesConfig from "./ConversationAgentCapabilitiesConfig";

expect.extend(matchers);

// The drawer composes ui/Dialog (Radix) — it locks scroll / manages focus on
// open, and jsdom implements none of the pointer-capture APIs it reaches for.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

const PROJECT_NAME = "remote-ai-manager";
const CONVERSATION_ID = "plc-1";
const PROJECT_CONVERSATION_CAPABILITY_URL = `/api/projects/${PROJECT_NAME}/conversations/${CONVERSATION_ID}/agent-capabilities`;
const CLAUDE_SKILLS_URL = `${PROJECT_CONVERSATION_CAPABILITY_URL}?cascadeKind=claude-skills`;

// The composer holds the session-keyed storage name, which for a project
// conversation IS the sentinel.
const PROJECT_SCOPE = scopeRefFromStoreSessionName(
  PROJECT_CONVERSATION_SESSION_SENTINEL,
);

/**
 * A cascade view as the project-conversation endpoint answers it: one skill
 * turned OFF at the conversation layer, over an inherited ON from the project
 * layer.
 */
function claudeSkillsView(
  cascadeKind: AgentCapabilityCascadeKind = "claude-skills",
): AgentCapabilityViewResponse {
  return {
    level: "conversation",
    projectName: PROJECT_NAME,
    conversationScope: "project",
    conversationId: CONVERSATION_ID,
    cascadeKind,
    backend: cascadeKind.startsWith("codex") ? "codex" : "claude",
    effectiveHash: "hash-plc",
    diagnostics: [],
    items: [
      {
        itemId: "reviewer",
        displayName: "Reviewer",
        backend: cascadeKind.startsWith("codex") ? "codex" : "claude",
        capabilityKind: "skill",
        cascadeKind,
        source: { kind: "project-file", path: ".claude/skills/reviewer" },
        nativeDefault: { enabled: true },
        ownEffectiveState: { enabled: false, originLayer: "conversation" },
        currentLayerValue: { enabled: false, originLayer: "conversation" },
        inheritedEffectiveState: { enabled: true, originLayer: "project" },
        effectiveState: { enabled: false, originLayer: "conversation" },
        originLayer: "conversation",
        runtimeVisibility: "runtime-visible",
        runtimeEmittable: true,
        stale: false,
        applyStatus: "applied",
        diagnostics: [],
      },
    ],
  };
}

let requested: { url: string; method: string }[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  requested = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      requested.push({ url, method: init?.method ?? "GET" });
      if (url.includes("agent-capabilities")) {
        const cascadeKind = /cascadeKind=([^&]+)/.exec(url)?.[1];
        const view = claudeSkillsView(
          (cascadeKind as AgentCapabilityCascadeKind | undefined) ??
            "claude-skills",
        );
        return Promise.resolve(
          init?.method === "PATCH"
            ? jsonResponse({
                view,
                effectiveHash: view.effectiveHash,
                changedItemIds: ["reviewer"],
                invalidationHints: {
                  level: "conversation",
                  projectName: PROJECT_NAME,
                  conversationScope: "project",
                  conversationId: CONVERSATION_ID,
                  cascadeKind: view.cascadeKind,
                },
              })
            : jsonResponse({ view }),
        );
      }
      // MCP config (the drawer's default tab) is not the subject; its own
      // failure state does not block the cascade panels.
      return Promise.resolve(
        new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDrawer(conversationId = CONVERSATION_ID): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConversationAgentCapabilitiesConfig
        projectName={PROJECT_NAME}
        scope={PROJECT_SCOPE}
        conversationId={conversationId}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Agent capability configuration" }),
  );
  return screen.getByRole("dialog", {
    name: "Agent capabilities configuration",
  });
}

// Claude and Codex each contribute a tab labelled "Skills"; the backend group
// they belong to is what distinguishes them.
function openClaudeSkillsTab(drawer: HTMLElement): void {
  const claudeSkillsTab = within(drawer)
    .getAllByRole("tab", { name: "Skills" })
    .find((tab) => tab.dataset.agent === "claude");
  if (!claudeSkillsTab) {
    throw new Error("the drawer rendered no Claude Skills tab");
  }
  fireEvent.mouseDown(claudeSkillsTab);
}

describe("project conversation capability drawer", () => {
  it("reads the cascade from the project-conversation endpoint", async () => {
    const drawer = renderDrawer();
    openClaudeSkillsTab(drawer);

    await waitFor(() => {
      expect(requested.map((r) => r.url)).toContain(CLAUDE_SKILLS_URL);
    });
    for (const { url } of requested) {
      expect(url).not.toContain("/sessions/");
      expect(url).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
    }
  });

  it("reflects an override recorded at the project-conversation layer", async () => {
    const drawer = renderDrawer();
    openClaudeSkillsTab(drawer);

    const row = await waitFor(() =>
      within(drawer).getByTestId("capability-row-reviewer"),
    );
    expect(within(row).getByText("Reviewer")).toBeInTheDocument();
    expect(
      within(row).getByText("Set off at Conversation"),
    ).toBeInTheDocument();
  });

  it("writes an override back to the project-conversation layer", async () => {
    const drawer = renderDrawer();
    openClaudeSkillsTab(drawer);

    const row = await waitFor(() =>
      within(drawer).getByTestId("capability-row-reviewer"),
    );
    fireEvent.click(
      within(row).getByRole("switch", { name: "Enable Reviewer" }),
    );

    await waitFor(() => {
      expect(
        requested.filter((r) => r.method === "PATCH").map((r) => r.url),
      ).toContain(PROJECT_CONVERSATION_CAPABILITY_URL);
    });
  });

  it("offers no session layer to configure", () => {
    const drawer = renderDrawer();
    openClaudeSkillsTab(drawer);

    expect(
      within(drawer).getByRole("button", { name: /Global/ }),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByRole("button", { name: /Project/ }),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByRole("button", { name: /Conversation/ }),
    ).toBeInTheDocument();
    expect(
      within(drawer).queryByRole("button", { name: /Session/ }),
    ).toBeNull();
  });

  // The project composer mounts before any conversation exists and addresses it
  // with an empty id; without that being treated as absent the drawer requests
  // `/conversations//agent-capabilities`.
  it("falls back to the project layer while no conversation exists yet", async () => {
    const drawer = renderDrawer("");
    openClaudeSkillsTab(drawer);

    await waitFor(() => {
      expect(requested.map((r) => r.url)).toContain(
        `/api/projects/${PROJECT_NAME}/agent-capabilities?cascadeKind=claude-skills`,
      );
    });
    for (const { url } of requested) {
      expect(url).not.toContain("/conversations//");
    }
    expect(
      within(drawer).queryByRole("button", { name: /Conversation/ }),
    ).toBeNull();
  });
});
