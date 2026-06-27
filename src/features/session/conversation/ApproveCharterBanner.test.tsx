// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ApproveCharterBanner, {
  ApproveCharterBannerView,
} from "@/features/session/conversation/ApproveCharterBanner";
import type { AlignmentVersion } from "@/lib/session-alignment/schemas";

function renderSeeded(
  ui: React.ReactElement,
  entries: Array<[QueryKey, unknown]> = [],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const [key, value] of entries) client.setQueryData(key, value);
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

const PROJECT = "proj";
const SESSION = "sess";

function makeDraft(
  overrides: Partial<AlignmentVersion> = {},
): AlignmentVersion {
  return {
    id: "draft-1",
    version: null,
    content: "Draft charter awaiting approval.",
    contentHash: "hash-d",
    status: "draft",
    source: "align_initial",
    authorConversationId: "conv-1",
    autoActivate: false,
    linkedDecisionIds: [],
    createdAt: "2026-06-26T00:00:00.000Z",
    activatedAt: null,
    approver: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ApproveCharterBannerView", () => {
  it("fires onApprove when Approve is clicked", async () => {
    const onApprove = vi.fn();
    render(
      <ApproveCharterBannerView
        onApprove={onApprove}
        onReject={vi.fn()}
        isSubmitting={false}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("fires onReject when Reject is clicked", async () => {
    const onReject = vi.fn();
    render(
      <ApproveCharterBannerView
        onApprove={vi.fn()}
        onReject={onReject}
        isSubmitting={false}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("disables both actions while submitting", () => {
    render(
      <ApproveCharterBannerView
        onApprove={vi.fn()}
        onReject={vi.fn()}
        isSubmitting
      />,
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });
});

describe("ApproveCharterBanner (container)", () => {
  function stubFetch() {
    const fetchMock = vi.fn<
      (url: string | URL, init?: RequestInit) => Promise<Response>
    >(async (url) => {
      const href = String(url);
      const body = href.includes("/charter/reject")
        ? { ok: true }
        : makeDraft({ id: "v1", version: 1, status: "active" });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("POSTs an approve request for the draft", async () => {
    const fetchMock = stubFetch();
    renderSeeded(
      <ApproveCharterBanner
        projectName={PROJECT}
        sessionName={SESSION}
        draft={makeDraft()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.find((c) =>
          String(c[0]).includes("/charter/approve"),
        ),
      ).toBeDefined();
    });
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/charter/approve"),
    )!;
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ draftId: "draft-1" });
  });

  it("POSTs a reject request for the draft", async () => {
    const fetchMock = stubFetch();
    renderSeeded(
      <ApproveCharterBanner
        projectName={PROJECT}
        sessionName={SESSION}
        draft={makeDraft()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.find((c) =>
          String(c[0]).includes("/charter/reject"),
        ),
      ).toBeDefined();
    });
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/charter/reject"),
    )!;
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ draftId: "draft-1" });
  });
});
