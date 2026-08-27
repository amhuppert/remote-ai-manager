// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { useNotepadSummaryQuery } from "./queries";

let api: FetchFixture;

beforeEach(() => {
  api = installFetchFixture();
});
afterEach(() => {
  api.restore();
  cleanup();
});

function notepadBody(overrides: Record<string, unknown> = {}) {
  return {
    notepad: {
      id: "np-7f3a",
      scope: "project",
      projectPath: "/repos/alpha",
      name: "Release checklist",
      content: "# Checklist\n\n- [ ] tag the release",
      revision: 4,
      writeMode: "full-edit",
      pinned: false,
      archived: false,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
      ...overrides,
    },
  };
}

function Probe({ notepadId }: { notepadId: string }): React.JSX.Element {
  const query = useNotepadSummaryQuery(notepadId);
  return (
    <div>
      <span data-testid="state">{query.data?.state ?? "pending"}</span>
      <span data-testid="name">
        {query.data?.state === "found" ? query.data.summary.name : ""}
      </span>
      <span data-testid="error">{String(query.isError)}</span>
    </div>
  );
}

describe("useNotepadSummaryQuery", () => {
  it("resolves a notepad by its immutable id", async () => {
    api.json("GET", "/api/notepads/np-7f3a", notepadBody());

    renderWithQuery(<Probe notepadId="np-7f3a" />);

    expect(await screen.findByText("Release checklist")).toBeVisible();
    expect(screen.getByTestId("state")).toHaveTextContent("found");
  });

  it("reports a deleted notepad as missing rather than as a query error", async () => {
    api.reply("GET", "/api/notepads/np-gone", {
      status: 404,
      json: { error: "notepad np-gone not found" },
    });

    renderWithQuery(<Probe notepadId="np-gone" />);

    expect(await screen.findByText("missing")).toBeVisible();
    expect(screen.getByTestId("error")).toHaveTextContent("false");
  });

  it("keeps the notepad's content out of the cached summary", async () => {
    api.json("GET", "/api/notepads/np-7f3a", notepadBody());

    const queryClient = createTestQueryClient();
    renderWithQuery(<Probe notepadId="np-7f3a" />, queryClient);
    await screen.findByText("Release checklist");

    const cached = JSON.stringify(
      queryClient.getQueryData(["notepads", "summary", "np-7f3a"]),
    );
    expect(cached).not.toContain("tag the release");
  });
});
