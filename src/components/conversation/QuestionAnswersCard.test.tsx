// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatQuestionAnswersBlock } from "@/lib/conversations/question-answers-block";
import type { AskQuestionAnswer } from "@/lib/conversations/schemas";
import MessageContent from "@/components/MessageContent";
import QuestionAnswersCard from "./QuestionAnswersCard";

const answers: Record<string, AskQuestionAnswer> = {
  approach: {
    selected: ["Phases in order"],
    note: "but land 2.3 early",
    skipped: false,
    question: "Which migration order?",
  },
  naming: { selected: [], note: null, skipped: true },
};

describe("QuestionAnswersCard", () => {
  it("renders each answer with its question, selections, and note", () => {
    render(
      <QuestionAnswersCard block={{ questionBatchId: "q_ab12", answers }} />,
    );

    expect(screen.getByTestId("question-answers-card")).toBeInTheDocument();
    expect(screen.getByText("Which migration order?")).toBeInTheDocument();
    expect(screen.getByText("Phases in order")).toBeInTheDocument();
    expect(screen.getByText("but land 2.3 early")).toBeInTheDocument();
  });

  it("marks a skipped answer as declined (proceed with best judgment)", () => {
    render(
      <QuestionAnswersCard block={{ questionBatchId: "q_ab12", answers }} />,
    );
    expect(screen.getByText(/skipped/i)).toBeInTheDocument();
  });
});

describe("MessageContent queued-row metadata gate", () => {
  it("renders the answer card for a queue row tagged question_answers", () => {
    const text = formatQuestionAnswersBlock("q_ab12", answers);
    render(
      <MessageContent
        content={[{ type: "text", text }]}
        queuedMetadata={{ kind: "question_answers", questionBatchId: "q_ab12" }}
      />,
    );

    expect(screen.getByTestId("question-answers-card")).toBeInTheDocument();
    expect(screen.getByText("Which migration order?")).toBeInTheDocument();
  });

  it("does not sniff an untagged queue row's text for the block (metadata drives the card)", () => {
    // A queue row is a message the user typed: even literal block text stays
    // raw text unless the row's provenance metadata marks it as answers.
    const text = formatQuestionAnswersBlock("q_ab12", answers);
    render(
      <MessageContent
        content={[{ type: "text", text }]}
        queuedMetadata={null}
      />,
    );

    expect(
      screen.queryByTestId("question-answers-card"),
    ).not.toBeInTheDocument();
  });
});

describe("MessageContent answer-block branch (delivered transcript rows)", () => {
  it("renders a text block containing <cc-question-answers> as an answer card, not raw text", () => {
    const text = formatQuestionAnswersBlock("q_ab12", answers);
    render(<MessageContent content={[{ type: "text", text }]} />);

    expect(screen.getByTestId("question-answers-card")).toBeInTheDocument();
    expect(
      screen.queryByText(/<cc-question-answers/, { exact: false }),
    ).not.toBeInTheDocument();
  });

  it("keeps surrounding prose visible around the card", () => {
    const text = `earlier note\n${formatQuestionAnswersBlock("q_ab12", answers)}\nlater note`;
    render(<MessageContent content={[{ type: "text", text }]} />);

    expect(screen.getByTestId("question-answers-card")).toBeInTheDocument();
    expect(screen.getByText("earlier note")).toBeInTheDocument();
    expect(screen.getByText("later note")).toBeInTheDocument();
  });

  it("renders ordinary text without a card", () => {
    render(
      <MessageContent content={[{ type: "text", text: "plain message" }]} />,
    );
    expect(
      screen.queryByTestId("question-answers-card"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("plain message")).toBeInTheDocument();
  });
});
