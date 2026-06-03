// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";
import MainDiffSurface from "./MainDiffSurface";
import { gitKeys } from "@/lib/git/query-keys";
import type { SessionDiff } from "@/lib/git/schemas";

function renderSeeded(
  ui: React.ReactElement,
  entries: Array<[QueryKey, unknown]>,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const [key, value] of entries) client.setQueryData(key, value);
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

const diffWithChanges: SessionDiff = {
  files: [
    {
      filePath: "src/lib/auth.ts",
      additions: 2,
      deletions: 1,
      hunks: [
        {
          header: "@@ -1,2 +1,3 @@",
          lines: [
            { type: "context", content: "a" },
            { type: "add", content: "b" },
          ],
        },
      ],
    },
  ],
  totalAdditions: 2,
  totalDeletions: 1,
};

const emptyDiff: SessionDiff = {
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
};

afterEach(cleanup);

describe("MainDiffSurface", () => {
  it("renders the diff read-only without any git-mutation controls", () => {
    const { container } = renderSeeded(<MainDiffSurface projectName="proj" />, [
      [gitKeys.mainDiff("proj"), diffWithChanges],
    ]);
    expect(container.textContent).toContain("src/lib/auth.ts");
    // No git-mutation affordances (the read-only "Commits" history tab is not a
    // mutation control and is exact-name distinct from a "Commit" button).
    expect(screen.queryByRole("button", { name: "Commit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("shows the no-changes empty state when the worktree is clean", () => {
    renderSeeded(<MainDiffSurface projectName="proj" />, [
      [gitKeys.mainDiff("proj"), emptyDiff],
    ]);
    expect(screen.getByText("No changes")).toBeInTheDocument();
  });

  it("shows the no-changes state when the diff endpoint is unavailable (null)", () => {
    renderSeeded(<MainDiffSurface projectName="proj" />, [
      [gitKeys.mainDiff("proj"), null],
    ]);
    expect(screen.getByText("No changes")).toBeInTheDocument();
  });
});
