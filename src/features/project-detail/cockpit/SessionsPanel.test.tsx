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
    creationMode: "fast",
    tddEnabled: true,
    objective: null,
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
    const menu = screen.getByRole("menu");
    fireEvent.click(
      within(menu).getByRole("menuitemcheckbox", { name: "idle" }),
    );
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
