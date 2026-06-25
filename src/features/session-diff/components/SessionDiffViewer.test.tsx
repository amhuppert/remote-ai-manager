// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import SessionDiffViewer from "./SessionDiffViewer";
import { gitKeys } from "@/lib/git/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import type { CommitLogEntry, SessionDiff } from "@/lib/git/schemas";

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

// An empty working-tree diff makes the viewer default to the Commits tab, so the
// commit accordion renders without a tab switch.
const emptyDiff: SessionDiff = {
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
};

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

function renderViewer() {
  // The session detail query must resolve (any non-pending value) or the page
  // short-circuits to its loading state and never renders the tabs.
  return renderSeeded(
    <SessionDiffViewer projectName="my-app" sessionName="implement-auth" />,
    [
      [
        sessionKeys.detail("my-app", "implement-auth"),
        { targetBranch: "main" },
      ],
      [gitKeys.diff("my-app", "implement-auth"), emptyDiff],
      [gitKeys.commits("my-app", "implement-auth"), commits],
    ],
  );
}

describe("SessionDiffViewer commit disclosure accessibility", () => {
  beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = () => null;
  });

  afterEach(cleanup);

  it("renders each commit header as a button with aria-expanded=false", () => {
    renderViewer();
    for (const commit of commits) {
      const header = screen.getByRole("button", {
        name: new RegExp(commit.message),
      });
      expect(header).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("toggles a commit open with the Enter key and exposes its region via aria-controls", async () => {
    const user = userEvent.setup();
    renderViewer();

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

  it("keeps only one commit open at a time (single-open)", async () => {
    const user = userEvent.setup();
    renderViewer();

    const first = screen.getByRole("button", {
      name: /Add session validation layer/,
    });
    const second = screen.getByRole("button", {
      name: /Refactor state management/,
    });

    first.focus();
    await user.keyboard(" ");
    expect(first).toHaveAttribute("aria-expanded", "true");

    second.focus();
    await user.keyboard(" ");
    expect(second).toHaveAttribute("aria-expanded", "true");
    expect(first).toHaveAttribute("aria-expanded", "false");
  });
});
