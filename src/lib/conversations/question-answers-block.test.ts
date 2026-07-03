import { describe, expect, it } from "vitest";
import { coalesceContent } from "./message-queue-service";
import type { PendingQueuedMessage } from "./message-queue-schemas";
import {
  formatQuestionAnswersBlock,
  parseQuestionAnswersBlock,
  splitQuestionAnswersBlock,
} from "./question-answers-block";
import type { AskQuestionAnswer } from "./schemas";

const answers: Record<string, AskQuestionAnswer> = {
  approach: {
    selected: ["Phases in order"],
    note: "but land 2.3 early",
    skipped: false,
    question: "Which migration order?",
  },
  naming: { selected: [], note: null, skipped: true },
};

describe("question answers block", () => {
  it("round-trips batch id and answers through format → parse", () => {
    const text = formatQuestionAnswersBlock("q_ab12", answers);
    expect(parseQuestionAnswersBlock(text)).toEqual({
      questionBatchId: "q_ab12",
      answers,
    });
  });

  it("survives queue coalescing with neighboring text rows", () => {
    const row = (id: string, text: string): PendingQueuedMessage => ({
      id,
      content: [{ type: "text", text }],
      status: "pending",
      enqueuedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      deliveryStartedAt: null,
      deliveredAt: null,
      cancelledAt: null,
      failedAt: null,
      deliveryAttemptId: null,
      attemptCount: 0,
      error: null,
      metadata: null,
    });

    const coalesced = coalesceContent([
      row("m1", "unrelated earlier message"),
      row("m2", formatQuestionAnswersBlock("q_ab12", answers)),
      row("m3", "and a follow-up"),
    ]);
    const joined = coalesced
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n");

    expect(parseQuestionAnswersBlock(joined)).toEqual({
      questionBatchId: "q_ab12",
      answers,
    });
  });

  it("splits surrounding prose from the block for display", () => {
    const text = `before text\n${formatQuestionAnswersBlock("q_ab12", answers)}\nafter text`;
    const split = splitQuestionAnswersBlock(text);
    expect(split).not.toBeNull();
    expect(split?.before).toBe("before text");
    expect(split?.after).toBe("after text");
    expect(split?.block).toEqual({ questionBatchId: "q_ab12", answers });
  });

  it("splits a block-only message into empty before/after", () => {
    const split = splitQuestionAnswersBlock(
      formatQuestionAnswersBlock("q_ab12", answers),
    );
    expect(split?.before).toBe("");
    expect(split?.after).toBe("");
  });

  it("split returns null when no valid block is present", () => {
    expect(splitQuestionAnswersBlock("no block here")).toBeNull();
    expect(
      splitQuestionAnswersBlock(
        '<cc-question-answers batch="q_x">not json</cc-question-answers>',
      ),
    ).toBeNull();
  });

  it("returns null for absent or malformed blocks", () => {
    expect(parseQuestionAnswersBlock("no block here")).toBeNull();
    expect(
      parseQuestionAnswersBlock(
        '<cc-question-answers batch="q_x">not json</cc-question-answers>',
      ),
    ).toBeNull();
    expect(
      parseQuestionAnswersBlock(
        '<cc-question-answers batch="q_x">{"a":{"bogus":true}}</cc-question-answers>',
      ),
    ).toBeNull();
  });
});
