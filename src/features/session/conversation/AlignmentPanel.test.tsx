// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AlignmentPanel from "@/features/session/conversation/AlignmentPanel";
import { alignmentKeys } from "@/lib/session-alignment/query-keys";
import type {
  AlignmentDecision,
  AlignmentDiff,
  AlignmentState,
  AlignmentVersion,
} from "@/lib/session-alignment/schemas";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

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

const PROJECT = "proj";
const SESSION = "sess";

function makeVersion(
  overrides: Partial<AlignmentVersion> = {},
): AlignmentVersion {
  return {
    id: "v2",
    version: 2,
    content: "Mission: keep every conversation aligned.",
    contentHash: "hash-2",
    status: "active",
    source: "align_initial",
    authorConversationId: "conv-1",
    autoActivate: false,
    linkedDecisionIds: [],
    createdAt: "2026-06-26T00:00:00.000Z",
    activatedAt: "2026-06-26T00:00:00.000Z",
    approver: "alex",
    ...overrides,
  };
}

function makeState(overrides: Partial<AlignmentState> = {}): AlignmentState {
  return {
    active: null,
    draft: null,
    history: [],
    decisions: [],
    pendingProposals: [],
    preview: null,
    ...overrides,
  };
}

function makeDecision(
  overrides: Partial<AlignmentDecision> = {},
): AlignmentDecision {
  return {
    id: "dec-1",
    statement: "Adopt the alignment panel.",
    rationale: null,
    originConversationId: "conv-7",
    originMessageId: "msg-42",
    producedVersion: null,
    approver: "alex",
    approvedAt: "2026-06-26T01:00:00.000Z",
    createdAt: "2026-06-26T01:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  pushMock.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AlignmentPanel", () => {
  it("renders the active charter from the live alignment state query", () => {
    const active = makeVersion();
    renderSeeded(
      <AlignmentPanel projectName={PROJECT} sessionName={SESSION} />,
      [
        [
          alignmentKeys.state(PROJECT, SESSION),
          makeState({
            active,
            history: [active],
            preview: "GOVERNING SECTION",
          }),
        ],
      ],
    );
    expect(
      screen.getByText(/Mission: keep every conversation aligned\./),
    ).toBeInTheDocument();
    // The live preview is sourced from the same state payload (R9.4).
    expect(screen.getByTestId("alignment-preview")).toHaveTextContent(
      "GOVERNING SECTION",
    );
  });

  it("requests and renders a per-version diff when a version pair is selected", async () => {
    const v1 = makeVersion({
      id: "v1",
      version: 1,
      status: "superseded",
      content: "v1 body",
    });
    const v2 = makeVersion({ id: "v2", version: 2, status: "active" });
    const diff: AlignmentDiff = {
      from: 1,
      to: 2,
      fromContent: "OLD ALIGNMENT BODY",
      toContent: "NEW ALIGNMENT BODY",
    };
    renderSeeded(
      <AlignmentPanel projectName={PROJECT} sessionName={SESSION} />,
      [
        [
          alignmentKeys.state(PROJECT, SESSION),
          makeState({ active: v2, history: [v2, v1] }),
        ],
        [alignmentKeys.diff(PROJECT, SESSION, 1, 2), diff],
      ],
    );
    await userEvent.selectOptions(screen.getByLabelText(/diff from/i), "1");
    await userEvent.selectOptions(screen.getByLabelText(/diff to/i), "2");
    await userEvent.click(screen.getByRole("button", { name: /compare/i }));
    expect(await screen.findByText(/OLD ALIGNMENT BODY/)).toBeInTheDocument();
    expect(screen.getByText(/NEW ALIGNMENT BODY/)).toBeInTheDocument();
  });

  it("issues a POST rollback request when a history rollback control is used", async () => {
    const fetchMock = vi.fn<
      (url: string | URL, init?: RequestInit) => Promise<Response>
    >(async (url) => {
      const href = String(url);
      const body = href.includes("/rollback")
        ? makeVersion({ id: "v3", version: 3, source: "rollback" })
        : makeState();
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const v1 = makeVersion({ id: "v1", version: 1, status: "superseded" });
    const v2 = makeVersion({ id: "v2", version: 2, status: "active" });
    renderSeeded(
      <AlignmentPanel projectName={PROJECT} sessionName={SESSION} />,
      [
        [
          alignmentKeys.state(PROJECT, SESSION),
          makeState({ active: v2, history: [v2, v1] }),
        ],
      ],
    );
    await userEvent.click(
      screen.getByRole("button", { name: /roll back to v1/i }),
    );
    await waitFor(() => {
      const rollbackCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes("/rollback"),
      );
      expect(rollbackCall).toBeDefined();
    });
    const rollbackCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/rollback"),
    )!;
    const init = rollbackCall[1] as RequestInit;
    expect(String(rollbackCall[0])).toContain(
      `/sessions/${SESSION}/alignment/rollback`,
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ version: 1 });
  });

  it("shows Rolling back… on the clicked version and disables rollback controls while the request is in flight", async () => {
    // A fetch that never resolves keeps the rollback mutation pending.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    const v1 = makeVersion({ id: "v1", version: 1, status: "superseded" });
    const v2 = makeVersion({ id: "v2", version: 2, status: "superseded" });
    const v3 = makeVersion({ id: "v3", version: 3, status: "active" });
    renderSeeded(
      <AlignmentPanel projectName={PROJECT} sessionName={SESSION} />,
      [
        [
          alignmentKeys.state(PROJECT, SESSION),
          makeState({ active: v3, history: [v3, v2, v1] }),
        ],
      ],
    );
    await userEvent.click(
      screen.getByRole("button", { name: /roll back to v1/i }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /rolling back…/i }),
      ).toBeDisabled();
    });
    expect(
      screen.getByRole("button", { name: /roll back to v2/i }),
    ).toBeDisabled();
  });

  it("navigates to a decision's originating message from the decision-log link", async () => {
    renderSeeded(
      <AlignmentPanel projectName={PROJECT} sessionName={SESSION} />,
      [
        [
          alignmentKeys.state(PROJECT, SESSION),
          makeState({ decisions: [makeDecision()] }),
        ],
      ],
    );
    await userEvent.click(
      screen.getByRole("button", { name: /view message/i }),
    );
    expect(pushMock).toHaveBeenCalledWith("/conversations?c=conv-7&m=msg-42");
  });
});
