// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithQuery, nextLinkMock } from "@/test/component-mocks";
import SessionGitPanel from "@/features/session/git/SessionGitPanel";
import type { SessionDiff, CommitLogEntry } from "@/lib/git/schemas";

vi.mock("next/link", async () => nextLinkMock);

const diff: SessionDiff = {
  files: [{ filePath: "src/foo.ts", additions: 3, deletions: 1, hunks: [] }],
  totalAdditions: 3,
  totalDeletions: 1,
};

const commits: CommitLogEntry[] = [];

describe("SessionGitPanel refresh", () => {
  it("invokes onRefresh when the refresh button is clicked", () => {
    const onRefresh = vi.fn();
    renderWithQuery(
      <SessionGitPanel
        diff={diff}
        commits={commits}
        projectName="proj"
        sessionName="sess"
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
