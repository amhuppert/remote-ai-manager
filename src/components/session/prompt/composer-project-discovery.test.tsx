// @vitest-environment jsdom
/**
 * Network-level proof for R7.1 / R7.2: what the composer's popups actually
 * REQUEST for a project conversation.
 *
 * The popups are rendered with the real query hooks over a stubbed `fetch`,
 * because the defect being pinned is the request itself — a popup that infers
 * project scope from an absent session name issues
 * `/api/projects/<p>/sessions/__project__/…`, which 404s. Asserting hook
 * arguments cannot see that; asserting the URL can.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PromptEditorSlashCommandPopup } from "@/components/session/prompt/PromptEditorSlashCommandPopup";
import { PromptEditorFileMentionPopup } from "@/components/session/prompt/PromptEditorFileMentionPopup";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";

// The composer is handed the session-keyed storage name; for a project
// conversation that name IS the sentinel.
const PROJECT_SCOPE = scopeRefFromStoreSessionName(
  PROJECT_CONVERSATION_SESSION_SENTINEL,
);

let requested: string[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  requested = [];
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      requested.push(url);
      if (url.includes("/commands")) {
        return Promise.resolve(
          jsonResponse({
            items: [
              {
                name: "/deploy",
                description: "Deploy from the project root",
                type: "command",
                source: "project",
              },
            ],
          }),
        );
      }
      if (url.includes("/files")) {
        return Promise.resolve(
          jsonResponse({
            items: [{ path: "src/app/page.tsx" }],
            truncated: false,
            scannedCount: 1,
          }),
        );
      }
      // Capability cascade views are not the subject here; the URL they address
      // is (asserted below), so an empty view keeps the popup rendering.
      return Promise.resolve(jsonResponse({ items: [] }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function withQuery(ui: React.ReactElement): React.ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

describe("project conversation composer discovery", () => {
  it("requests project-root slash commands and renders them", async () => {
    await act(async () => {
      render(
        withQuery(
          <PromptEditorSlashCommandPopup
            query=""
            triggerChar="/"
            projectName="proj"
            scopeRef={PROJECT_SCOPE}
            conversationId="plc-1"
            backend="claude"
            onSelect={vi.fn()}
          />,
        ),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("/deploy")).toBeInTheDocument();
    });
    expect(requested).toContain("/api/projects/proj/commands?backend=claude");
  });

  it("requests the project-root file scan and renders its results", async () => {
    await act(async () => {
      render(
        withQuery(
          <PromptEditorFileMentionPopup
            query=""
            projectName="proj"
            scopeRef={PROJECT_SCOPE}
            onSelect={vi.fn()}
          />,
        ),
      );
    });

    await waitFor(() => {
      expect(
        screen.getByText((_, el) => el?.textContent === "src/app/page.tsx"),
      ).toBeInTheDocument();
    });
    expect(requested).toContain("/api/projects/proj/files");
  });

  it("resolves the capability cascade at the project-conversation scope", async () => {
    await act(async () => {
      render(
        withQuery(
          <PromptEditorSlashCommandPopup
            query=""
            triggerChar="/"
            projectName="proj"
            scopeRef={PROJECT_SCOPE}
            conversationId="plc-1"
            backend="claude"
            onSelect={vi.fn()}
          />,
        ),
      );
    });

    await waitFor(() => {
      expect(
        requested.filter((url) => url.includes("agent-capabilities")),
      ).not.toHaveLength(0);
    });
    for (const url of requested.filter((u) =>
      u.includes("agent-capabilities"),
    )) {
      expect(url).toContain("/api/projects/proj/conversations/plc-1/");
    }
  });

  it("never addresses a session route for a project conversation", async () => {
    await act(async () => {
      render(
        withQuery(
          <>
            <PromptEditorSlashCommandPopup
              query=""
              triggerChar="/"
              projectName="proj"
              scopeRef={PROJECT_SCOPE}
              conversationId="plc-1"
              backend="claude"
              onSelect={vi.fn()}
            />
            <PromptEditorFileMentionPopup
              query=""
              projectName="proj"
              scopeRef={PROJECT_SCOPE}
              onSelect={vi.fn()}
            />
          </>,
        ),
      );
    });

    await waitFor(() => {
      expect(requested.length).toBeGreaterThan(0);
    });
    for (const url of requested) {
      expect(url).not.toContain("/sessions/");
      expect(url).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
    }
  });
});
