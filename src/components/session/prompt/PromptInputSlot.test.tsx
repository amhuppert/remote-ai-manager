// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import PromptInputSlot, {
  resolvePromptSlotView,
} from "@/components/session/prompt/PromptInputSlot";
import type { AskQuestionItem } from "@/lib/conversations/schemas";
import type PromptComposer from "@/components/session/prompt/PromptComposer";

type PromptComposerProps = ComponentProps<typeof PromptComposer>;

// PromptComposer requires a deep tree (Tiptap editor, lazy chunks, query
// providers, voice hooks, etc.). The default branch is exercised by
// PromptEditor.test.tsx / PromptComposer-targeted stories; here we only need
// to verify branch selection happens before PromptComposer renders, so we
// pass a cast stub object and avoid re-exercising that provider stack.
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

describe("resolvePromptSlotView", () => {
  it("restores the read-only treatment once the gate clears", () => {
    expect(
      resolvePromptSlotView({
        isWorkflowManagedConversation: true,
        hasPendingQuestions: false,
      }),
    ).toEqual({ content: "readonly" });
  });

  it("selects questions then composer for regular conversations", () => {
    expect(
      resolvePromptSlotView({
        isWorkflowManagedConversation: false,
        hasPendingQuestions: true,
      }),
    ).toEqual({ content: "questions" });
    expect(
      resolvePromptSlotView({
        isWorkflowManagedConversation: false,
        hasPendingQuestions: false,
      }),
    ).toEqual({ content: "composer" });
  });
});

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
        agentBackend="claude"
        promptComposerProps={composerStub}
      />,
    );

    expect(
      screen.getByText(/managed by a workflow execution and is read-only/i),
    ).toBeInTheDocument();
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
        agentBackend="claude"
        promptComposerProps={composerStub}
      />,
    );

    // The question text appears in both the status rail and the detail card.
    expect(screen.getAllByText("Pick a flavor").length).toBeGreaterThan(0);
    expect(screen.getByText("vanilla")).toBeInTheDocument();
    expect(screen.getByText("chocolate")).toBeInTheDocument();
  });
});
