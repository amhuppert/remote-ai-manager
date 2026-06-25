// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import type { CommitLogEntry } from "@/lib/git/schemas";
import CommitHistory from "@/features/session/git/CommitHistory";

const commits = [
  {
    hash: "a1b2c3d",
    fullHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    message: "Add session validation layer",
    date: new Date(Date.now() - 300_000).toISOString(),
    filesChanged: 3,
  },
  {
    hash: "e5f6g7h",
    fullHash: "e5f6g7h8i9j0e5f6g7h8i9j0e5f6g7h8i9j0e5f6",
    message: "Refactor state management to use atomic writes",
    date: new Date(Date.now() - 3600_000).toISOString(),
    filesChanged: 5,
  },
] satisfies CommitLogEntry[];

function renderHistory() {
  // A QueryClient is required because each open commit lazily fires
  // useCommitDiffQuery; the query stays disabled while the section is closed.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CommitHistory
        commits={commits}
        projectName="my-app"
        sessionName="implement-auth"
      />
    </QueryClientProvider>,
  );
}

describe("CommitHistory keyboard accessibility", () => {
  beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = () => null;
  });

  it("renders each commit header as a button with aria-expanded", () => {
    renderHistory();
    const headers = screen.getAllByRole("button");
    expect(headers).toHaveLength(commits.length);
    for (const header of headers) {
      expect(header).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("toggles a commit open with the Enter key and exposes its region via aria-controls", async () => {
    const user = userEvent.setup();
    renderHistory();

    const header = screen.getByRole("button", {
      name: /Add session validation layer/,
    });
    header.focus();
    await user.keyboard("{Enter}");

    expect(header).toHaveAttribute("aria-expanded", "true");
    const controlsId = header.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();
    const region = document.getElementById(controlsId!);
    expect(region).not.toBeNull();
    expect(region).toBeInTheDocument();
  });

  it("toggles a commit open with the Space key and closes it again (single-open)", async () => {
    const user = userEvent.setup();
    renderHistory();

    const first = screen.getByRole("button", {
      name: /Add session validation layer/,
    });
    const second = screen.getByRole("button", {
      name: /Refactor state management/,
    });

    first.focus();
    await user.keyboard(" ");
    expect(first).toHaveAttribute("aria-expanded", "true");

    // single-open: opening the second collapses the first.
    second.focus();
    await user.keyboard(" ");
    expect(second).toHaveAttribute("aria-expanded", "true");
    expect(first).toHaveAttribute("aria-expanded", "false");
  });

  it("does not orphan listitems inside the open region", async () => {
    const user = userEvent.setup();
    renderHistory();
    const header = screen.getByRole("button", {
      name: /Add session validation layer/,
    });
    header.focus();
    await user.keyboard("{Enter}");
    const controlsId = header.getAttribute("aria-controls");
    const region = document.getElementById(controlsId!)!;
    // The region must carry role="region" (Radix) and contain no orphan <li>.
    expect(within(region).queryAllByRole("listitem")).toHaveLength(0);
  });
});
