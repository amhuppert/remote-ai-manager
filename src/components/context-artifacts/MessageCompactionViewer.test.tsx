// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import MessageCompactionViewer from "./MessageCompactionViewer";
import { buildArtifactDetail, buildArtifactListItem } from "./fixtures";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import type { ContextArtifactListItem } from "@/lib/context-artifacts/queries";

const target: ContextArtifactTarget = {
  scope: "session",
  projectName: "p1",
  sessionName: "s1",
  conversationId: "c1",
};

const DETAIL_URL =
  "/api/projects/p1/sessions/s1/conversations/c1/context-artifacts/art-1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchSpy = vi.fn<typeof fetch>();

function renderViewer(
  artifact: ContextArtifactListItem,
  props: Partial<React.ComponentProps<typeof MessageCompactionViewer>> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MessageCompactionViewer
        target={target}
        artifact={artifact}
        onRefresh={props.onRefresh ?? vi.fn()}
        refreshPending={props.refreshPending ?? false}
        onNavigateToMessage={props.onNavigateToMessage}
      />
    </QueryClientProvider>,
  );
}

describe("MessageCompactionViewer", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the full artifact and renders the envelope for a complete artifact", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(buildArtifactDetail()));
    renderViewer(buildArtifactListItem());
    expect(
      await screen.findByText(/Single tool-heavy assistant turn/),
    ).toBeInTheDocument();
    // Provenance from the row feeds the envelope footer.
    expect(screen.getByText(/claude · sonnet · medium/)).toBeInTheDocument();
    expect(
      fetchSpy.mock.calls.some((call) => String(call[0]) === DETAIL_URL),
    ).toBe(true);
  });

  it("fires onRefresh from the Refresh action", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(buildArtifactDetail()));
    const onRefresh = vi.fn();
    renderViewer(buildArtifactListItem(), { onRefresh });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows a visible pending state on the Refresh action while a refresh runs", () => {
    fetchSpy.mockResolvedValue(jsonResponse(buildArtifactDetail()));
    renderViewer(buildArtifactListItem(), { refreshPending: true });
    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect(refresh).toBeDisabled();
    expect(refresh).toHaveAttribute("aria-busy", "true");
  });

  it("shows the stored error for a failed artifact without fetching the payload", () => {
    renderViewer(
      buildArtifactListItem({
        status: "failed",
        error: "transcript_too_large_for_single_pass",
      }),
    );
    expect(
      screen.getByText("transcript_too_large_for_single_pass"),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to a generic failure message when a failed artifact has no error", () => {
    renderViewer(buildArtifactListItem({ status: "failed", error: null }));
    expect(screen.getByText("Compaction failed")).toBeInTheDocument();
  });

  it("reports a missing payload on a complete artifact instead of rendering nothing", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(buildArtifactDetail({ payload: null })),
    );
    renderViewer(buildArtifactListItem());
    expect(
      await screen.findByText(/payload is unavailable/),
    ).toBeInTheDocument();
  });
});
