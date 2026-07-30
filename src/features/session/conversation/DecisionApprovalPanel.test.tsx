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
import DecisionApprovalPanel, {
  DecisionApprovalPanelView,
} from "@/features/session/conversation/DecisionApprovalPanel";
import type {
  DecisionProposal,
  DecisionProposalBatch,
} from "@/lib/session-alignment/schemas";

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

function makeProposal(
  overrides: Partial<DecisionProposal> = {},
): DecisionProposal {
  return {
    id: "p1",
    projectPath: "/repo",
    sessionName: SESSION,
    conversationId: "conv-1",
    batchId: "batch-1",
    statement: "Use SQLite as the source of truth.",
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

describe("DecisionApprovalPanelView", () => {
  it("renders every proposed decision statement", () => {
    const batch = makeBatch([
      makeProposal({ id: "p1", statement: "Adopt SQLite." }),
      makeProposal({ id: "p2", statement: "Ship behind a flag." }),
    ]);
    render(
      <DecisionApprovalPanelView
        batch={batch}
        isSubmitting={false}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText("Adopt SQLite.")).toBeInTheDocument();
    expect(screen.getByText("Ship behind a flag.")).toBeInTheDocument();
  });

  it("presents each resolution as one explicit, exclusive choice", async () => {
    const batch = makeBatch([makeProposal({ id: "p1" })]);
    render(
      <DecisionApprovalPanelView
        batch={batch}
        isSubmitting={false}
        onSubmit={vi.fn()}
      />,
    );

    const row = screen.getByTestId("decision-proposal");
    const resolution = within(row).getByRole("radiogroup", {
      name: "Resolution",
    });
    const approve = within(resolution).getByRole("radio", { name: "Approve" });
    const reject = within(resolution).getByRole("radio", { name: "Reject" });

    expect(approve).toBeChecked();
    expect(reject).not.toBeChecked();

    await userEvent.click(reject);
    expect(approve).not.toBeChecked();
    expect(reject).toBeChecked();
    expect(within(row).getByRole("textbox")).toBeInTheDocument();

    await userEvent.click(approve);
    expect(approve).toBeChecked();
    expect(reject).not.toBeChecked();
    expect(within(row).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("submits all decisions as approvals by default (bulk approve)", async () => {
    const onSubmit = vi.fn();
    const batch = makeBatch([
      makeProposal({ id: "p1" }),
      makeProposal({ id: "p2" }),
    ]);
    render(
      <DecisionApprovalPanelView
        batch={batch}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledWith([
      { proposalId: "p1", approve: true },
      { proposalId: "p2", approve: true },
    ]);
  });

  it("submits a reject-with-note for a flipped decision while keeping the other approved", async () => {
    const onSubmit = vi.fn();
    const batch = makeBatch([
      makeProposal({ id: "p1", statement: "Adopt SQLite." }),
      makeProposal({ id: "p2", statement: "Ship behind a flag." }),
    ]);
    render(
      <DecisionApprovalPanelView
        batch={batch}
        isSubmitting={false}
        onSubmit={onSubmit}
      />,
    );
    const rows = screen.getAllByTestId("decision-proposal");
    // Flip the second decision to reject and add feedback.
    await userEvent.click(
      within(rows[1]!).getByRole("radio", { name: /reject/i }),
    );
    await userEvent.type(within(rows[1]!).getByRole("textbox"), "needs scope");
    await userEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledWith([
      { proposalId: "p1", approve: true },
      { proposalId: "p2", approve: false, feedback: "needs scope" },
    ]);
  });

  it("only shows the feedback field for decisions flipped to reject", async () => {
    const batch = makeBatch([makeProposal({ id: "p1" })]);
    render(
      <DecisionApprovalPanelView
        batch={batch}
        isSubmitting={false}
        onSubmit={vi.fn()}
      />,
    );
    const row = screen.getByTestId("decision-proposal");
    expect(within(row).queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole("radio", { name: /reject/i }));
    expect(within(row).getByRole("textbox")).toBeInTheDocument();
  });

  it("disables submit while a resolution is in flight", () => {
    const batch = makeBatch([makeProposal({ id: "p1" })]);
    render(
      <DecisionApprovalPanelView
        batch={batch}
        isSubmitting
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
  });

  it("shows Submitting… on the submit button while a resolution is in flight", () => {
    const batch = makeBatch([makeProposal({ id: "p1" })]);
    render(
      <DecisionApprovalPanelView
        batch={batch}
        isSubmitting
        onSubmit={vi.fn()}
      />,
    );
    const submit = screen.getByRole("button", { name: /submitting…/i });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute("aria-busy", "true");
  });
});

describe("DecisionApprovalPanel (container)", () => {
  it("POSTs the resolutions for the batch against the API", async () => {
    const fetchMock = vi.fn<
      (url: string | URL, init?: RequestInit) => Promise<Response>
    >(
      async () =>
        new Response(JSON.stringify({ approved: 1, rejected: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const batch = makeBatch([
      makeProposal({ id: "p1", statement: "Adopt SQLite." }),
      makeProposal({ id: "p2", statement: "Ship behind a flag." }),
    ]);
    renderSeeded(
      <DecisionApprovalPanel
        projectName={PROJECT}
        sessionName={SESSION}
        batch={batch}
      />,
    );
    const rows = screen.getAllByTestId("decision-proposal");
    await userEvent.click(
      within(rows[1]!).getByRole("radio", { name: /reject/i }),
    );
    await userEvent.type(within(rows[1]!).getByRole("textbox"), "no");
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
        { proposalId: "p2", approve: false, feedback: "no" },
      ],
    });
  });
});
