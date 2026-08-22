// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import type { UserInputStanding } from "@/hooks/use-user-input-gate";
import ParkedQuestionPanel from "./ParkedQuestionPanel";

function standing(
  overrides: Partial<UserInputStanding> = {},
): UserInputStanding {
  return {
    contextId: "context-implement",
    laneKey: "implementer",
    conversationId: "conv-1",
    questionBatchId: "batch-1",
    questions: [
      {
        id: "q1",
        question: "Should the toggle default to on?",
        header: "Toggle",
        multiSelect: false,
        required: true,
        allowNote: true,
        options: [{ label: "yes", recommended: true, description: "" }],
      },
    ],
    ...overrides,
  };
}

function renderPanel(value: UserInputStanding) {
  return renderWithQuery(
    <ParkedQuestionPanel
      projectName="test-project"
      sessionName="test-session"
      standing={value}
    />,
  );
}

describe("ParkedQuestionPanel", () => {
  it("frames the wait as a parked question and names the lane that asked it", () => {
    renderPanel(standing());

    const panel = screen.getByTestId("parked-question-panel");
    expect(
      within(panel).getByText("Parked question — Implementer"),
    ).toBeInTheDocument();
  });

  it("names the validator seat when a cohort member is the one waiting", () => {
    renderPanel(standing({ laneKey: "context_validator:security-reviewer" }));

    expect(
      screen.getByText("Parked question — security-reviewer"),
    ).toBeInTheDocument();
  });

  it("says how many questions the lane is waiting on", () => {
    renderPanel(
      standing({
        questions: [
          ...standing().questions,
          {
            id: "q2",
            question: "Which rollout?",
            header: "Rollout",
            multiSelect: false,
            required: true,
            allowNote: true,
            options: [{ label: "canary", recommended: false, description: "" }],
          },
        ],
      }),
    );

    expect(screen.getByText("2 questions awaiting you")).toBeInTheDocument();
  });

  it("keeps the answering surface intact inside the card", () => {
    renderPanel(standing());

    const panel = screen.getByTestId("parked-question-panel");
    expect(
      within(panel).getByText("Should the toggle default to on?"),
    ).toBeInTheDocument();
    expect(within(panel).getByRole("radio", { name: /yes/ })).toBeEnabled();
  });
});
