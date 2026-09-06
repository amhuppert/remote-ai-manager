// @vitest-environment jsdom
/**
 * R7.3 over the REAL command-discovery path: which commands the popup offers a
 * project conversation.
 *
 * Eligibility is a property of the command NAME, not of the catalog an item
 * arrived in, so the claim only holds if it survives discovery — a project root
 * may legitimately contain a `commit.md`. That makes the discovered catalog part
 * of the subject rather than a fixture, so the popup runs against its real query
 * hooks and the stub is the network boundary (`fetch`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import { PromptEditorSlashCommandPopup } from "@/components/session/prompt/PromptEditorSlashCommandPopup";
import type { AgentCapabilityCascadeKind } from "@/lib/agent-capabilities/schemas";
import type { CommandItem } from "@/lib/commands/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationScopeRef } from "@/lib/conversations/conversation-target";

const PROJECT_NAME = "proj";
const PROJECT_SCOPE: ConversationScopeRef = { scope: "project" };
const SESSION_SCOPE: ConversationScopeRef = {
  scope: "session",
  sessionName: "sess",
};

function discovered(name: string, description: string): CommandItem {
  return { name, description, type: "command", source: "project" };
}

const DEPLOY = discovered("/deploy", "Deploy from the project root");

/** What each `/commands` endpoint answers with, per test. */
let projectRootCommands: CommandItem[] = [];
let sessionCommands: CommandItem[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Capability cascades are not the subject here; an empty view keeps
 * `filterDisabledCommandItems` a pass-through so the catalog under test is the
 * one discovery and scope eligibility produced.
 */
function emptyCascadeView(url: string): unknown {
  const cascadeKind = (/cascadeKind=([^&]+)/.exec(url)?.[1] ??
    "claude-plugins") as AgentCapabilityCascadeKind;
  return {
    view: {
      level: "project",
      projectName: PROJECT_NAME,
      cascadeKind,
      backend: cascadeKind.startsWith("codex") ? "codex" : "claude",
      effectiveHash: "empty",
      diagnostics: [],
      items: [],
    },
  };
}

beforeEach(() => {
  projectRootCommands = [DEPLOY];
  sessionCommands = [];
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "/api/agent-backends")
        return Promise.resolve(
          jsonResponse({ backends: listBackendCatalogEntries() }),
        );
      if (url.includes("agent-capabilities")) {
        return Promise.resolve(jsonResponse(emptyCascadeView(url)));
      }
      if (url.includes("/commands")) {
        return Promise.resolve(
          jsonResponse({
            items: url.includes("/sessions/")
              ? sessionCommands
              : projectRootCommands,
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPopup(options: {
  scopeRef: ConversationScopeRef;
  backend?: AgentBackendId;
}): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PromptEditorSlashCommandPopup
        query=""
        triggerChar="/"
        projectName={PROJECT_NAME}
        scopeRef={options.scopeRef}
        conversationId="plc-1"
        backend={options.backend ?? "claude"}
        onSelect={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

/**
 * Absence is only meaningful once the catalog has actually arrived, so every
 * test waits on a command it does expect before asserting on one it does not.
 */
async function waitForCommand(name: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByText(name)).toBeInTheDocument();
  });
}

describe("project conversation slash-command catalog", () => {
  it("offers the built-ins that resolve at project scope, including /ticket", async () => {
    renderPopup({ scopeRef: PROJECT_SCOPE });

    await waitForCommand("/deploy");
    expect(screen.getByText("/spec")).toBeInTheDocument();
    expect(screen.getByText("/ticket")).toBeInTheDocument();
  });

  it("withholds session git and alignment built-ins at project scope", async () => {
    renderPopup({ scopeRef: PROJECT_SCOPE });

    await waitForCommand("/deploy");
    expect(screen.queryByText("/commit")).toBeNull();
    expect(screen.queryByText("/merge")).toBeNull();
    expect(screen.queryByText("/rebase")).toBeNull();
    expect(screen.queryByText("/align")).toBeNull();
    expect(screen.queryByText("/collab")).toBeNull();
  });

  // CC intercepts these names before the agent sees them, so a discovered copy
  // of a session-only command is no more executable at project scope than the
  // built-in one.
  it("withholds discovered project-root commands that reuse a session-only name", async () => {
    projectRootCommands = [
      discovered("/commit", "A project-root command file named commit"),
      discovered("/align", "A project-root command file named align"),
      DEPLOY,
    ];

    renderPopup({ scopeRef: PROJECT_SCOPE });

    await waitForCommand("/deploy");
    expect(screen.queryByText("/commit")).toBeNull();
    expect(screen.queryByText("/align")).toBeNull();
  });

  it("still offers a discovered reserved name in a session conversation", async () => {
    sessionCommands = [
      discovered("/commit", "A worktree command file named commit"),
    ];

    renderPopup({ scopeRef: SESSION_SCOPE });

    await waitForCommand("/commit");
    expect(
      await screen.findByText("A worktree command file named commit"),
    ).toBeInTheDocument();
  });

  it("applies the same project-scope eligibility on the Codex backend", async () => {
    renderPopup({ scopeRef: PROJECT_SCOPE, backend: "codex" });

    await waitForCommand("/ticket");
    expect(screen.getByText("/spec")).toBeInTheDocument();
    expect(screen.queryByText("/commit")).toBeNull();
    expect(screen.queryByText("/align")).toBeNull();
  });
});
