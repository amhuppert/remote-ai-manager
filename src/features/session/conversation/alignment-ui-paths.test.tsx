// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AlignmentChip from "@/features/session/conversation/AlignmentChip";
import { deriveAlignmentChipState } from "@/features/session/conversation/alignment-chip-state";
import DecisionApprovalPanel from "@/features/session/conversation/DecisionApprovalPanel";
import type {
  AlignmentState,
  AlignmentVersion,
  DecisionProposal,
  DecisionProposalBatch,
} from "@/lib/session-alignment/schemas";

// Validation of the alignment UI paths (R9.1, R5.2): the session-header
// alignment chip transitions to "active vN" once a charter draft is approved,
// and the decision-approval component round-trips a bulk approve/reject-with-note
// submission to the API. (Creation-mode coverage — R1.1, R1.2 — lives with the
// component it exercises in project-detail/components/CreateSessionModal.test.tsx.)

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

function makeVersion(
  overrides: Partial<AlignmentVersion> = {},
): AlignmentVersion {
  return {
    id: "v1",
    version: 1,
    content: "Mission: stay aligned.",
    contentHash: "hash-1",
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

function makeProposal(
  overrides: Partial<DecisionProposal> = {},
): DecisionProposal {
  return {
    id: "p1",
    projectPath: "/repo",
    sessionName: "sess",
    conversationId: "conv-1",
    batchId: "batch-1",
    statement: "A decision.",
    rationale: null,
    context: null,
    originMessageId: "msg-1",
    createdAt: "2026-06-26T00:00:00.000Z",
    ...overrides,
  };
}

function makeBatch(proposals: DecisionProposal[]): DecisionProposalBatch {
  return { batchId: "batch-1", proposals };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("alignment chip approval transition", () => {
  it("transitions from update-pending to active vN once the draft is approved (R9.1)", () => {
    const activeV1 = makeVersion({ id: "v1", version: 1, status: "active" });
    const draft = makeVersion({ id: "d1", version: null, status: "draft" });

    // Before approval: an active v1 with an open draft → the chip flags a
    // pending update behind the approval gate.
    const preApproval = makeState({
      active: activeV1,
      draft,
      history: [activeV1],
    });
    const preState = deriveAlignmentChipState(preApproval, 1);
    expect(preState).toBe("pending");

    const { rerender } = render(
      <AlignmentChip
        state={preState}
        activeVersion={preApproval.active?.version ?? null}
      />,
    );
    expect(screen.getByText(/update pending/i)).toBeInTheDocument();

    // After approval: the draft is gone and v2 is active → the chip shows the
    // new active version with no pending indicator.
    const activeV2 = makeVersion({ id: "v2", version: 2, status: "active" });
    const postApproval = makeState({
      active: activeV2,
      draft: null,
      history: [activeV2, { ...activeV1, status: "superseded" }],
    });
    const postState = deriveAlignmentChipState(postApproval, null);
    expect(postState).toBe("active");

    rerender(
      <AlignmentChip
        state={postState}
        activeVersion={postApproval.active?.version ?? null}
      />,
    );
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.queryByText(/update pending/i)).toBeNull();
    expect(
      screen.getByText("Alignment").closest("[data-state]"),
    ).toHaveAttribute("data-state", "active");
  });
});

describe("decision-approval bulk round-trip", () => {
  it("submits a bulk approve plus a reject-with-note to the resolve API (R5.2)", async () => {
    const fetchMock = vi.fn<
      (url: string | URL, init?: RequestInit) => Promise<Response>
    >(
      async () =>
        new Response(JSON.stringify({ approved: 2, rejected: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const batch = makeBatch([
      makeProposal({ id: "p1", statement: "Approve me 1." }),
      makeProposal({ id: "p2", statement: "Reject me." }),
      makeProposal({ id: "p3", statement: "Approve me 2." }),
    ]);
    renderSeeded(
      <DecisionApprovalPanel
        projectName="proj"
        sessionName="sess"
        batch={batch}
      />,
    );

    // Default is approve for all; flip the middle decision to reject + note.
    const rows = screen.getAllByTestId("decision-proposal");
    await userEvent.click(
      within(rows[1]!).getByRole("button", { name: /reject/i }),
    );
    await userEvent.type(
      within(rows[1]!).getByRole("textbox"),
      "needs more thought",
    );
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.find((c) =>
          String(c[0]).includes("/decisions/resolve"),
        ),
      ).toBeDefined();
    });
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/decisions/resolve"),
    )!;
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      batchId: "batch-1",
      resolutions: [
        { proposalId: "p1", approve: true },
        { proposalId: "p2", approve: false, feedback: "needs more thought" },
        { proposalId: "p3", approve: true },
      ],
    });
  });
});
