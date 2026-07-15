// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ComponentProps } from "react";
import PromptInputSlot, {
  resolvePromptSlotView,
} from "@/components/session/prompt/PromptInputSlot";
import type { AskQuestionItem } from "@/lib/conversations/schemas";
import type PromptComposer from "@/components/session/prompt/PromptComposer";
import type ApprovalGatePanel from "@/components/ApprovalGatePanel";

type PromptComposerProps = ComponentProps<typeof PromptComposer>;
type ApprovalGateProps = ComponentProps<typeof ApprovalGatePanel>;

// PromptComposer requires a deep tree (Tiptap editor, lazy chunks, query
// providers, voice hooks, etc.). The default branch is exercised by
// PromptEditor.test.tsx / PromptComposer-targeted stories; here we only need
// to verify branch selection happens before PromptComposer renders, so we
// pass a cast stub object — the default-branch test is skipped to avoid
// re-exercising that provider stack.
const composerStub = {} as PromptComposerProps;

const sampleQuestions: AskQuestionItem[] = [
  {
    question: "Pick a flavor",
    options: [
      { label: "vanilla", recommended: false },
      { label: "chocolate", recommended: false },
    ],
    multiSelect: false,
    required: true,
    allowNote: true,
  },
];

function approvalGateProps(
  overrides: Partial<ApprovalGateProps> = {},
): ApprovalGateProps {
  return {
    contextTitle: "Implement",
    workflowName: "Review Flow",
    requestedAt: "2026-06-10T09:00:00.000Z",
    isSubmitting: false,
    conversationBusy: false,
    executionSuspended: false,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    ...overrides,
  };
}

describe("resolvePromptSlotView", () => {
  it("selects the live composer with the gate panel while gated and undecided", () => {
    expect(
      resolvePromptSlotView({
        hasApprovalGate: true,
        isWorkflowManagedConversation: true,
        hasPendingQuestions: false,
      }),
    ).toEqual({ showApprovalGate: true, content: "composer" });
  });

  it("keeps pending questions below the gate panel while gated", () => {
    expect(
      resolvePromptSlotView({
        hasApprovalGate: true,
        isWorkflowManagedConversation: true,
        hasPendingQuestions: true,
      }),
    ).toEqual({ showApprovalGate: true, content: "questions" });
  });

  it("restores the read-only treatment once the gate clears", () => {
    expect(
      resolvePromptSlotView({
        hasApprovalGate: false,
        isWorkflowManagedConversation: true,
        hasPendingQuestions: false,
      }),
    ).toEqual({ showApprovalGate: false, content: "readonly" });
  });

  it("renders the question panel for a workflow-managed lane conversation with a pending question", () => {
    // A graph-workflow lane parked awaiting user input (ask-in-workflow) must
    // surface its question panel on the lane conversation view — the read-only
    // treatment is bypassed exactly as it is for the approval gate. A
    // workflow-managed conversation only ever holds a pending question via the
    // ask gate this feature lifts (task_run/smart-merge turns cannot ask), so
    // this never re-opens ordinary read-only lanes (Req 4.2).
    expect(
      resolvePromptSlotView({
        hasApprovalGate: false,
        isWorkflowManagedConversation: true,
        hasPendingQuestions: true,
      }),
    ).toEqual({ showApprovalGate: false, content: "questions" });
  });

  it("selects questions then composer for regular conversations", () => {
    expect(
      resolvePromptSlotView({
        hasApprovalGate: false,
        isWorkflowManagedConversation: false,
        hasPendingQuestions: true,
      }),
    ).toEqual({ showApprovalGate: false, content: "questions" });
    expect(
      resolvePromptSlotView({
        hasApprovalGate: false,
        isWorkflowManagedConversation: false,
        hasPendingQuestions: false,
      }),
    ).toEqual({ showApprovalGate: false, content: "composer" });
  });
});

describe("PromptInputSlot", () => {
  it("renders IterationReadonlyBanner when isWorkflowManagedConversation=true", () => {
    render(
      <PromptInputSlot
        isWorkflowManagedConversation
        approvalGate={null}
        pendingQuestions={null}
        pendingQuestionId={null}
        currentQuestionIndex={0}
        navigateQuestion={vi.fn()}
        handleAnswerSubmit={vi.fn()}
        agentBackend="claude"
        promptComposerProps={composerStub}
      />,
    );

    expect(
      screen.getByText(/managed by a workflow execution and is read-only/i),
    ).toBeInTheDocument();
  });

  it("renders the question panel (not the read-only banner) for a workflow-managed lane with a pending question", () => {
    render(
      <PromptInputSlot
        isWorkflowManagedConversation
        approvalGate={null}
        pendingQuestions={sampleQuestions}
        pendingQuestionId="q-1"
        currentQuestionIndex={0}
        navigateQuestion={vi.fn()}
        handleAnswerSubmit={vi.fn()}
        agentBackend="claude"
        promptComposerProps={composerStub}
      />,
    );

    // Ask-in-workflow: the parked lane conversation must present its question
    // panel here, not the read-only banner (Req 4.2).
    expect(
      screen.getByRole("dialog", { name: /agent question/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/managed by a workflow execution and is read-only/i),
    ).toBeNull();
  });

  it("renders AskQuestionPanel when pendingQuestions and pendingQuestionId are set", () => {
    render(
      <PromptInputSlot
        isWorkflowManagedConversation={false}
        approvalGate={null}
        pendingQuestions={sampleQuestions}
        pendingQuestionId="q-1"
        currentQuestionIndex={0}
        navigateQuestion={vi.fn()}
        handleAnswerSubmit={vi.fn()}
        agentBackend="claude"
        promptComposerProps={composerStub}
      />,
    );

    // The question text appears in both the status rail and the detail card.
    expect(screen.getAllByText("Pick a flavor").length).toBeGreaterThan(0);
    expect(screen.getByText("vanilla")).toBeInTheDocument();
    expect(screen.getByText("chocolate")).toBeInTheDocument();
  });

  it("renders the approval gate panel above pending questions and bypasses the readonly banner while gated", () => {
    render(
      <PromptInputSlot
        isWorkflowManagedConversation
        approvalGate={approvalGateProps()}
        pendingQuestions={sampleQuestions}
        pendingQuestionId="q-1"
        currentQuestionIndex={0}
        navigateQuestion={vi.fn()}
        handleAnswerSubmit={vi.fn()}
        agentBackend="claude"
        promptComposerProps={composerStub}
      />,
    );

    const panel = screen.getByTestId("approval-gate-panel");
    // The rendered question text is a behavioral landmark — no assertion on the
    // migrated panel's internal DOM structure.
    const [question] = screen.getAllByText("Pick a flavor");
    expect(panel).toBeInTheDocument();
    expect(question).toBeInTheDocument();
    expect(
      screen.queryByText(/managed by a workflow execution and is read-only/i),
    ).toBeNull();
    // Gate panel renders above the question panel.
    expect(
      panel.compareDocumentPosition(question!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("forwards approve clicks from the gate panel", () => {
    const onApprove = vi.fn();
    render(
      <PromptInputSlot
        isWorkflowManagedConversation
        approvalGate={approvalGateProps({ onApprove })}
        pendingQuestions={sampleQuestions}
        pendingQuestionId="q-1"
        currentQuestionIndex={0}
        navigateQuestion={vi.fn()}
        handleAnswerSubmit={vi.fn()}
        agentBackend="claude"
        promptComposerProps={composerStub}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it.skip("renders PromptComposer in the default branch (requires deep provider/lazy setup; covered by PromptEditor.test.tsx)", () => {
    // The default branch falls through to <PromptComposer>, which lazy-loads
    // Tiptap and pulls in voice/query hooks. Verifying that branch with a
    // realistic stub would either need a full provider stack or aggressive
    // vi.mocks on internal modules — both violate the project's testing
    // rules. The "only pendingQuestions but no id" fallthrough hits the same
    // code path and is therefore also out of scope here. The gated→composer
    // selection is pinned by the resolvePromptSlotView tests above.
  });
});
