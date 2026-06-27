// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
  waitFor,
} from "@testing-library/react";
import SessionsPanel from "./SessionsPanel";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { FilterToken } from "../components/filter-tokens";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

function renderPanel(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

function makeSession(
  o: Partial<SessionListItem> &
    Pick<SessionListItem, "sessionName" | "branchName">,
): SessionListItem {
  return {
    worktreePath: `/tmp/${o.sessionName}`,
    targetBranch: "main",
    parentSessionName: null,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-02T00:00:00Z",
    archived: false,
    finished: false,
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    derivedStatus: "running",
    promptCount: 1,
    derivedLastActivityAt: "2026-01-02T00:00:00Z",
    collabContribution: null,
    hasActiveGraphWorkflow: false,
    ...o,
  };
}

const sessions: SessionListItem[] = [
  makeSession({
    sessionName: "auth",
    branchName: "csm/auth",
    derivedStatus: "running",
  }),
  makeSession({
    sessionName: "parser",
    branchName: "csm/parser",
    derivedStatus: "idle",
  }),
];

function Harness({ initialTokens = [] }: { initialTokens?: FilterToken[] }) {
  const [tokens, setTokens] = useState<FilterToken[]>(initialTokens);
  return (
    <SessionsPanel
      projectName="proj"
      sessions={sessions}
      tokens={tokens}
      onTokensChange={setTokens}
    />
  );
}

afterEach(cleanup);

describe("SessionsPanel filter chips", () => {
  it("renders active tokens as chips and removes one without clearing the rest", () => {
    const onTokensChange = vi.fn();
    renderPanel(
      <SessionsPanel
        projectName="proj"
        sessions={sessions}
        tokens={[
          { cat: "status", key: "is", value: "running" },
          { cat: "target", key: "target", value: "main" },
        ]}
        onTokensChange={onTokensChange}
      />,
    );
    expect(screen.getByText("is:running")).toBeInTheDocument();
    expect(screen.getByText("target:main")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove is:running filter" }),
    );
    expect(onTokensChange).toHaveBeenCalledWith([
      { cat: "target", key: "target", value: "main" },
    ]);
  });

  it("clears every token via clear-all", () => {
    const onTokensChange = vi.fn();
    renderPanel(
      <SessionsPanel
        projectName="proj"
        sessions={sessions}
        tokens={[{ cat: "status", key: "is", value: "running" }]}
        onTokensChange={onTokensChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onTokensChange).toHaveBeenCalledWith([]);
  });
});

describe("SessionsPanel filter popover (shared token state)", () => {
  it("a popover toggle and the chips reflect the same token state", () => {
    renderPanel(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const panel = screen.getByRole("dialog");
    fireEvent.click(within(panel).getByRole("button", { name: "idle" }));
    expect(screen.getByText("is:idle")).toBeInTheDocument();
  });
});

describe("SessionsPanel search", () => {
  it("filters by name and shows a search-specific empty message", () => {
    renderPanel(<Harness />);
    const search = screen.getByLabelText("Search sessions");
    fireEvent.change(search, { target: { value: "zzz-nomatch" } });
    expect(screen.getByText("No sessions match")).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing matches “zzz-nomatch”/),
    ).toBeInTheDocument();
  });
});

describe("SessionsPanel bulk actions", () => {
  afterEach(() => vi.unstubAllGlobals());

  function selectRows(...names: string[]) {
    for (const name of names) {
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
    }
  }

  it("reveals the bulk ribbon only when sessions are selected", () => {
    renderPanel(<Harness />);
    expect(
      screen.queryByRole("region", { name: "Bulk actions" }),
    ).not.toBeInTheDocument();

    selectRows("auth", "parser");

    const ribbon = screen.getByRole("region", { name: "Bulk actions" });
    expect(within(ribbon).getByText("sessions selected")).toBeInTheDocument();
    expect(within(ribbon).getByText("2")).toBeInTheDocument();
    expect(
      within(ribbon).getByRole("button", { name: "Archive 2" }),
    ).toBeInTheDocument();
    expect(
      within(ribbon).getByRole("button", { name: "Delete 2" }),
    ).toBeInTheDocument();
  });

  it("confirms then POSTs a bulk archive and clears the selection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { sessionName: "auth", success: true },
            { sessionName: "parser", success: true },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderPanel(<Harness />);
    selectRows("auth", "parser");

    const ribbon = screen.getByRole("region", { name: "Bulk actions" });
    fireEvent.click(within(ribbon).getByRole("button", { name: "Archive 2" }));

    // Confirmation modal opens; the request only fires after confirming.
    const overlay = screen.getByRole("alertdialog", {
      name: "Archive sessions?",
    });
    expect(within(overlay).getByText("Archive sessions?")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(overlay).getByRole("button", { name: "Archive 2" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/projects/proj/sessions/bulk");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as {
      op: string;
      sessionNames: string[];
    };
    expect(body.op).toBe("archive");
    expect([...body.sessionNames].sort()).toEqual(["auth", "parser"]);

    // Selection clears, so the ribbon disappears once the bulk op succeeds.
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Bulk actions" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("offers Unarchive when every selected session is archived", () => {
    const archived = [
      makeSession({
        sessionName: "old-a",
        branchName: "csm/old-a",
        archived: true,
      }),
      makeSession({
        sessionName: "old-b",
        branchName: "csm/old-b",
        archived: true,
      }),
    ];
    renderPanel(
      <SessionsPanel
        projectName="proj"
        sessions={archived}
        tokens={[{ cat: "archived", key: "include", value: "include" }]}
        onTokensChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select old-a" }));

    const ribbon = screen.getByRole("region", { name: "Bulk actions" });
    expect(
      within(ribbon).getByRole("button", { name: "Unarchive 1" }),
    ).toBeInTheDocument();
    expect(
      within(ribbon).queryByRole("button", { name: /^Archive/ }),
    ).not.toBeInTheDocument();
  });
});

describe("SessionsPanel empty states", () => {
  it("distinguishes a filter-driven empty result from a search one", () => {
    renderPanel(
      <Harness
        initialTokens={[{ cat: "status", key: "is", value: "merged" }]}
      />,
    );
    expect(
      screen.getByText("Nothing matches the active filters."),
    ).toBeInTheDocument();
  });

  it("shows the no-sessions state when the project has none", () => {
    renderPanel(
      <SessionsPanel
        projectName="proj"
        sessions={[]}
        tokens={[]}
        onTokensChange={vi.fn()}
      />,
    );
    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
  });
});
