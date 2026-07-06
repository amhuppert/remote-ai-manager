// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import RightPane from "./RightPane";
import { useSessionDetailStore } from "@/stores/session-detail.store";

// AlignmentPanel navigates via the app router, which jsdom has no host for.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchSpy = vi.fn<typeof fetch>();

function renderPane() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RightPane
        projectName="p1"
        sessionName="s1"
        worktreePath="/wt/p1-s1"
        targetBranch="main"
        conversationId="c1"
        conversationName="auth-refactor"
        archived={false}
      />
    </QueryClientProvider>,
  );
}

describe("RightPane", () => {
  beforeEach(() => {
    useSessionDetailStore.getState().resetStore();
    // Every panel's query resolves to an empty-ish payload; panels render
    // their own empty/error states without crashing.
    fetchSpy.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/context-artifacts")) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("registers all five tabs including Artifact", () => {
    renderPane();
    for (const name of ["Diff", "Docs", "Alignment", "Specs", "Artifact"]) {
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    }
  });

  it("keeps Diff as the default active tab", () => {
    renderPane();
    expect(screen.getByRole("tab", { name: "Diff" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("activating the Artifact tab shows the context-artifact panel", async () => {
    const user = userEvent.setup();
    renderPane();
    await user.click(screen.getByRole("tab", { name: "Artifact" }));

    expect(useSessionDetailStore.getState().rightPaneTab).toBe("artifact");
    // The panel is mounted with this conversation's identity: empty fixture
    // list → its empty state invites the first compaction.
    expect(
      await screen.findByRole("button", { name: /compact conversation/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("auth-refactor")).toBeInTheDocument();
  });
});
