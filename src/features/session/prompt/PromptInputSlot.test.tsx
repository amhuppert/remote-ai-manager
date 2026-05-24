// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import PromptInputSlot from "@/features/session/prompt/PromptInputSlot";
import type { AskQuestionItem } from "@/lib/conversations/schemas";
import type PromptComposer from "@/features/session/prompt/PromptComposer";

type PromptComposerProps = ComponentProps<typeof PromptComposer>;

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
    options: [{ label: "vanilla" }, { label: "chocolate" }],
    multiSelect: false,
  },
];

describe("PromptInputSlot", () => {
  it("renders IterationReadonlyBanner when isWorkflowManagedConversation=true", () => {
    render(
      <PromptInputSlot
        isWorkflowManagedConversation
        pendingQuestions={null}
        pendingQuestionId={null}
        currentQuestionIndex={0}
        navigateQuestion={vi.fn()}
        handleAnswerSubmit={vi.fn()}
        promptComposerProps={composerStub}
      />,
    );

    expect(
      screen.getByText(/managed by a workflow execution and is read-only/i),
    ).toBeInTheDocument();
  });

  it("takes the workflow-managed branch even when pending questions exist", () => {
    render(
      <PromptInputSlot
        isWorkflowManagedConversation
        pendingQuestions={sampleQuestions}
        pendingQuestionId="q-1"
        currentQuestionIndex={0}
        navigateQuestion={vi.fn()}
        handleAnswerSubmit={vi.fn()}
        promptComposerProps={composerStub}
      />,
    );

    expect(
      screen.getByText(/managed by a workflow execution and is read-only/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Pick a flavor/)).toBeNull();
  });

  it("renders AskQuestionPanel when pendingQuestions and pendingQuestionId are set", () => {
    render(
      <PromptInputSlot
        isWorkflowManagedConversation={false}
        pendingQuestions={sampleQuestions}
        pendingQuestionId="q-1"
        currentQuestionIndex={0}
        navigateQuestion={vi.fn()}
        handleAnswerSubmit={vi.fn()}
        promptComposerProps={composerStub}
      />,
    );

    expect(screen.getByText("Pick a flavor")).toBeInTheDocument();
    expect(screen.getByText("vanilla")).toBeInTheDocument();
    expect(screen.getByText("chocolate")).toBeInTheDocument();
  });

  it.skip("renders PromptComposer in the default branch (requires deep provider/lazy setup; covered by PromptEditor.test.tsx)", () => {
    // The default branch falls through to <PromptComposer>, which lazy-loads
    // Tiptap and pulls in voice/query hooks. Verifying that branch with a
    // realistic stub would either need a full provider stack or aggressive
    // vi.mocks on internal modules — both violate the project's testing
    // rules. The "only pendingQuestions but no id" fallthrough hits the same
    // code path and is therefore also out of scope here.
  });
});
