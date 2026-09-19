// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import type { ConversationScopeRef } from "@/lib/conversations/conversation-target";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { PromptEditorSlashCommandPopup } from "./PromptEditorSlashCommandPopup";

let api: FetchFixture;
beforeEach(() => {
  api = installFetchFixture();
  api.json("GET", "/api/agent-backends", {
    backends: listBackendCatalogEntries(),
  });
  api.pending("GET", /\/agent-capabilities\?/);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => api.restore());

describe("native Codex skill selection", () => {
  it.each<ConversationScopeRef>([
    { scope: "session", sessionName: "sess" },
    { scope: "project" },
  ])(
    "retains exact identity for duplicate skill names at $scope scope",
    async (scopeRef) => {
      const route =
        scopeRef.scope === "session"
          ? "/api/projects/proj/sessions/sess/commands"
          : "/api/projects/proj/commands";
      api.json("GET", route, {
        items: [
          {
            name: "$wave",
            description: "Personal wave",
            type: "skill",
            source: "user",
            skillPath: "/personal/SKILL.md",
          },
          {
            name: "$wave",
            description: "Project wave",
            type: "skill",
            source: "project",
            skillPath: "/project/SKILL.md",
          },
        ],
      });
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const onSelect = vi.fn();
      const result = render(
        <QueryClientProvider client={client}>
          <PromptEditorSlashCommandPopup
            query="wave"
            triggerChar="$"
            projectName="proj"
            scopeRef={scopeRef}
            conversationId="conv"
            backend="codex"
            onSelect={onSelect}
          />
        </QueryClientProvider>,
      );
      try {
        fireEvent.click(await screen.findByText("Project wave"));
        expect(onSelect).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "$wave",
            skillPath: "/project/SKILL.md",
          }),
        );
        expect(
          api.requestsTo("GET", route)[0]?.searchParams.get("conversationId"),
        ).toBe("conv");
        expect(api.unmatched).toEqual([]);
      } finally {
        result.unmount();
        client.clear();
      }
    },
  );
});
