import { describe, expect, it } from "vitest";

import {
  answerQuestionRequestSchema,
  askQuestionItemSchema,
} from "@/lib/conversations/schemas";

describe("askQuestionItemSchema", () => {
  it("applies defaults for the new gating + suggestion fields", () => {
    const parsed = askQuestionItemSchema.parse({
      question: "Which store?",
      options: [{ label: "SQLite" }],
    });

    expect(parsed.required).toBe(true);
    expect(parsed.allowNote).toBe(true);
    expect(parsed.options[0]?.recommended).toBe(false);
    expect(parsed.id).toBeUndefined();
    expect(parsed.context).toBeUndefined();
  });

  it("keeps id optional but rejects an empty id when provided", () => {
    expect(
      askQuestionItemSchema.safeParse({
        id: "",
        question: "Q",
        options: [{ label: "A" }],
      }).success,
    ).toBe(false);

    const withId = askQuestionItemSchema.parse({
      id: "storage",
      question: "Q",
      options: [{ label: "A" }],
    });
    expect(withId.id).toBe("storage");
  });

  it("round-trips a maximal item with context, tradeoffs, and overrides", () => {
    const parsed = askQuestionItemSchema.parse({
      id: "storage",
      header: "Architecture",
      context: "The cache holds **decoded** state.\n- reuses `better-sqlite3`",
      question: "Which backing store?",
      multiSelect: true,
      required: false,
      allowNote: false,
      options: [
        {
          label: "SQLite",
          description: "Embedded.",
          recommended: true,
          tradeoff: { pro: "No new dependency.", con: "Single-writer." },
        },
      ],
    });

    expect(parsed.required).toBe(false);
    expect(parsed.allowNote).toBe(false);
    expect(parsed.multiSelect).toBe(true);
    expect(parsed.options[0]?.recommended).toBe(true);
    expect(parsed.options[0]?.tradeoff).toEqual({
      pro: "No new dependency.",
      con: "Single-writer.",
    });
  });
});

describe("answerQuestionRequestSchema", () => {
  it("validates the structured selection-plus-note answer payload", () => {
    const parsed = answerQuestionRequestSchema.parse({
      questionId: "abc",
      answers: {
        storage: {
          selected: ["SQLite (WAL mode)"],
          note: "gate behind a flag for v1",
          skipped: false,
          question: "Which backing store?",
        },
        naming: { selected: [], note: null, skipped: true },
      },
    });

    expect(parsed.answers["storage"]?.selected).toEqual(["SQLite (WAL mode)"]);
    expect(parsed.answers["storage"]?.note).toBe("gate behind a flag for v1");
    expect(parsed.answers["naming"]?.skipped).toBe(true);
    expect(parsed.answers["naming"]?.note).toBeNull();
  });

  it("rejects the legacy flat string answer shape", () => {
    const result = answerQuestionRequestSchema.safeParse({
      questionId: "abc",
      answers: { "Which backing store?": "SQLite (WAL mode)" },
    });
    expect(result.success).toBe(false);
  });
});
