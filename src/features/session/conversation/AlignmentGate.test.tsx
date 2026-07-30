// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { render, screen, cleanup } from "@testing-library/react";
import AlignmentGate from "@/features/session/conversation/AlignmentGate";
import { alignmentKeys } from "@/lib/session-alignment/query-keys";
import type {
  AlignmentState,
  AlignmentVersion,
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

function makeDraft(
  overrides: Partial<AlignmentVersion> = {},
): AlignmentVersion {
  return {
    id: "draft-1",
    version: null,
    content: "Draft charter.",
    contentHash: "h",
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

function makeActive(): AlignmentVersion {
  return {
    ...makeDraft(),
    id: "v1",
    version: 1,
    status: "active",
    activatedAt: "2026-06-26T00:00:00.000Z",
    approver: "alex",
  };
}

function makeBatch(): DecisionProposalBatch {
  return {
    batchId: "batch-1",
    proposals: [
      {
        id: "p1",
        projectPath: "/repo",
        sessionName: SESSION,
        conversationId: "conv-1",
        batchId: "batch-1",
        statement: "Adopt SQLite as the source of truth.",
        rationale: null,
        context: null,
        originMessageId: "msg-1",
        createdAt: "2026-06-26T00:00:00.000Z",
      },
    ],
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

function seed(state: AlignmentState): Array<[QueryKey, unknown]> {
  return [[alignmentKeys.state(PROJECT, SESSION), state]];
}

afterEach(cleanup);

describe("AlignmentGate", () => {
  it("renders nothing when there is no draft or pending proposals", () => {
    const { container } = renderSeeded(
      <AlignmentGate projectName={PROJECT} sessionName={SESSION} />,
      seed(makeState({ active: makeActive() })),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("surfaces the Approve Charter banner when a draft is pending", () => {
    renderSeeded(
      <AlignmentGate projectName={PROJECT} sessionName={SESSION} />,
      seed(makeState({ draft: makeDraft() })),
    );
    expect(screen.getByText("Approve Charter")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("does not surface manual approval for a decision draft", () => {
    const { container } = renderSeeded(
      <AlignmentGate projectName={PROJECT} sessionName={SESSION} />,
      seed(
        makeState({
          draft: makeDraft({
            source: "decision",
            autoActivate: true,
            content: "",
            contentHash: "",
            linkedDecisionIds: ["decision-1"],
          }),
        }),
      ),
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Approve Charter")).not.toBeInTheDocument();
  });

  it("does not surface approval until an align draft has content", () => {
    const { container } = renderSeeded(
      <AlignmentGate projectName={PROJECT} sessionName={SESSION} />,
      seed(
        makeState({
          draft: makeDraft({ content: "", contentHash: "" }),
        }),
      ),
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("surfaces the decision-approval panel when a proposal batch is pending", () => {
    renderSeeded(
      <AlignmentGate projectName={PROJECT} sessionName={SESSION} />,
      seed(makeState({ pendingProposals: [makeBatch()] })),
    );
    expect(screen.getByText("Decisions proposed")).toBeInTheDocument();
    expect(
      screen.getByText("Adopt SQLite as the source of truth."),
    ).toBeInTheDocument();
  });

  it("surfaces both gates when a draft and a proposal batch are pending", () => {
    renderSeeded(
      <AlignmentGate projectName={PROJECT} sessionName={SESSION} />,
      seed(makeState({ draft: makeDraft(), pendingProposals: [makeBatch()] })),
    );
    expect(screen.getByText("Approve Charter")).toBeInTheDocument();
    expect(screen.getByText("Decisions proposed")).toBeInTheDocument();
  });

  it("renders nothing when disabled even if a draft is pending", () => {
    const { container } = renderSeeded(
      <AlignmentGate projectName={PROJECT} sessionName={SESSION} disabled />,
      seed(makeState({ draft: makeDraft() })),
    );
    expect(container).toBeEmptyDOMElement();
  });
});
