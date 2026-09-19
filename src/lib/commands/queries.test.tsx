// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { useCommandsQuery, useProjectCommandsQuery } from "./queries";

let api: FetchFixture;

beforeEach(() => {
  api = installFetchFixture();
});

afterEach(() => api.restore());

function SessionCommands({ conversationId }: { conversationId: string }) {
  const query = useCommandsQuery("proj", "session", "codex", {
    conversationId,
  });
  return <span>{query.data?.items[0]?.name ?? "loading"}</span>;
}

function ProjectCommands({ conversationId }: { conversationId: string }) {
  const query = useProjectCommandsQuery("proj", "codex", { conversationId });
  return <span>{query.data?.items[0]?.name ?? "loading"}</span>;
}

describe("conversation command queries", () => {
  it.each([
    [
      "session",
      "/api/projects/proj/sessions/session/commands",
      SessionCommands,
    ],
    ["project", "/api/projects/proj/commands", ProjectCommands],
  ] as const)(
    "keeps %s conversation catalogs separate on the wire and in cache",
    async (_scope, route, Commands) => {
      api.reply("GET", route, (request) => ({
        json: {
          items: [
            {
              name: `$${request.searchParams.get("conversationId") ?? "missing-scope"}`,
              description: "A conversation-specific skill",
              source: "user",
              type: "skill",
            },
          ],
        },
      }));
      const client = createTestQueryClient();

      renderWithQuery(<Commands conversationId="first" />, client);
      renderWithQuery(<Commands conversationId="second" />, client);

      expect(await screen.findByText("$first")).toBeInTheDocument();
      expect(await screen.findByText("$second")).toBeInTheDocument();
      expect(
        api
          .requestsTo("GET", route)
          .map((request) => request.searchParams.get("backend")),
      ).toEqual(["codex", "codex"]);
    },
  );
});
