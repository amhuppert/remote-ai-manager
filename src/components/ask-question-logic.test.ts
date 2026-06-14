import { describe, expect, it } from "vitest";

import type { AskQuestionItem } from "@/lib/conversations/schemas";
import {
  OTHER_SENTINEL,
  acceptAllSuggested,
  buildAnswerPayload,
  computeProgress,
  initDraftMap,
  isAnswered,
  isResolved,
  parseContext,
  parseInline,
  questionKey,
  statusOfQuestion,
  summaryOfQuestion,
  toggleOption,
  type AnswerDraft,
} from "@/components/ask-question-logic";

function item(overrides: Partial<AskQuestionItem> = {}): AskQuestionItem {
  return {
    question: "Which store?",
    options: [{ label: "SQLite", recommended: false }],
    multiSelect: false,
    required: true,
    allowNote: true,
    ...overrides,
  };
}

const emptyDraft: AnswerDraft = {
  selected: [],
  note: "",
  noteOpen: false,
  otherText: "",
  skipped: false,
};

describe("questionKey", () => {
  it("uses the explicit id when present", () => {
    expect(questionKey(item({ id: "storage" }), 3)).toBe("storage");
  });
  it("falls back to the stringified index", () => {
    expect(questionKey(item(), 2)).toBe("2");
  });
});

describe("initDraftMap", () => {
  it("seeds an empty draft keyed by question key", () => {
    const map = initDraftMap([item({ id: "a" }), item()]);
    expect(Object.keys(map).sort()).toEqual(["1", "a"]);
    expect(map["a"]).toEqual(emptyDraft);
    expect(map["1"]).toEqual(emptyDraft);
  });
});

describe("toggleOption", () => {
  it("single-select replaces the selection and clears skipped", () => {
    const draft: AnswerDraft = {
      ...emptyDraft,
      selected: ["A"],
      skipped: true,
    };
    const next = toggleOption(draft, "B", false);
    expect(next.selected).toEqual(["B"]);
    expect(next.skipped).toBe(false);
  });
  it("single-select toggling the same label clears it", () => {
    const next = toggleOption({ ...emptyDraft, selected: ["A"] }, "A", false);
    expect(next.selected).toEqual([]);
  });
  it("multi-select toggles labels independently", () => {
    const a = toggleOption(emptyDraft, "A", true);
    const ab = toggleOption(a, "B", true);
    expect(ab.selected).toEqual(["A", "B"]);
    const b = toggleOption(ab, "A", true);
    expect(b.selected).toEqual(["B"]);
  });
});

describe("isAnswered / isResolved", () => {
  it("treats a real selection as answered", () => {
    expect(isAnswered({ ...emptyDraft, selected: ["A"] })).toBe(true);
  });
  it("does not treat a bare 'Something else' with no text as answered", () => {
    expect(isAnswered({ ...emptyDraft, selected: [OTHER_SENTINEL] })).toBe(
      false,
    );
  });
  it("treats 'Something else' with text as answered", () => {
    expect(
      isAnswered({
        ...emptyDraft,
        selected: [OTHER_SENTINEL],
        otherText: "Redis",
      }),
    ).toBe(true);
  });
  it("treats a skipped-but-unanswered draft as resolved, not answered", () => {
    const draft: AnswerDraft = { ...emptyDraft, skipped: true };
    expect(isAnswered(draft)).toBe(false);
    expect(isResolved(draft)).toBe(true);
  });
});

describe("computeProgress", () => {
  const questions = [
    item({ id: "a", required: true }),
    item({ id: "b", required: false }),
    item({
      id: "c",
      required: true,
      options: [{ label: "X", recommended: true }],
    }),
  ];

  it("gates submit on required questions only", () => {
    const drafts = initDraftMap(questions);
    drafts["a"] = { ...emptyDraft, selected: ["SQLite"] };
    const progress = computeProgress(questions, drafts);
    expect(progress.answeredCount).toBe(1);
    expect(progress.requiredRemaining).toBe(1); // c still unanswered
    expect(progress.canSubmit).toBe(false);
    expect(progress.hasSuggestions).toBe(true);
  });

  it("counts an optional skip toward percent but allows submit once required are answered", () => {
    const drafts = initDraftMap(questions);
    drafts["a"] = { ...emptyDraft, selected: ["SQLite"] };
    drafts["c"] = { ...emptyDraft, selected: ["X"] };
    drafts["b"] = { ...emptyDraft, skipped: true };
    const progress = computeProgress(questions, drafts);
    expect(progress.requiredRemaining).toBe(0);
    expect(progress.canSubmit).toBe(true);
    expect(progress.percent).toBe(100); // 2 answered + 1 skipped = 3 resolved / 3
  });
});

describe("acceptAllSuggested", () => {
  it("fills the first recommended option for single-select and all for multi", () => {
    const questions = [
      item({
        id: "single",
        multiSelect: false,
        options: [
          { label: "A", recommended: false },
          { label: "B", recommended: true },
        ],
      }),
      item({
        id: "multi",
        multiSelect: true,
        options: [
          { label: "X", recommended: true },
          { label: "Y", recommended: true },
          { label: "Z", recommended: false },
        ],
      }),
      item({ id: "none", options: [{ label: "Q", recommended: false }] }),
    ];
    const next = acceptAllSuggested(questions, initDraftMap(questions));
    expect(next["single"]?.selected).toEqual(["B"]);
    expect(next["multi"]?.selected).toEqual(["X", "Y"]);
    expect(next["none"]?.selected).toEqual([]); // untouched
  });
});

describe("statusOfQuestion", () => {
  it("returns the right status per draft state", () => {
    const recommended = item({ options: [{ label: "X", recommended: true }] });
    expect(
      statusOfQuestion(item(), { ...emptyDraft, selected: ["SQLite"] }),
    ).toBe("answered");
    expect(statusOfQuestion(item(), { ...emptyDraft, skipped: true })).toBe(
      "skipped",
    );
    expect(statusOfQuestion(recommended, emptyDraft)).toBe("suggested");
    expect(statusOfQuestion(item({ required: true }), emptyDraft)).toBe(
      "required-empty",
    );
    expect(statusOfQuestion(item({ required: false }), emptyDraft)).toBe("");
  });
});

describe("summaryOfQuestion", () => {
  it("summarizes selections, other text, and note presence", () => {
    expect(summaryOfQuestion({ ...emptyDraft, selected: ["SQLite"] })).toBe(
      "SQLite",
    );
    expect(
      summaryOfQuestion({
        ...emptyDraft,
        selected: [OTHER_SENTINEL],
        otherText: "Redis",
      }),
    ).toBe("“Redis”");
    expect(
      summaryOfQuestion({
        ...emptyDraft,
        selected: ["SQLite"],
        note: "flag it",
      }),
    ).toBe("SQLite + note");
    expect(summaryOfQuestion({ ...emptyDraft, note: "just a note" })).toBe(
      "Note only",
    );
    expect(summaryOfQuestion({ ...emptyDraft, skipped: true })).toBe("Skipped");
  });
});

describe("buildAnswerPayload", () => {
  it("keys answers by question key, strips the sentinel, and appends other text", () => {
    const questions = [
      item({ id: "storage", question: "Which store?" }),
      item({
        id: "legacy",
        multiSelect: true,
        question: "Which legacy paths?",
      }),
      item({ id: "naming", required: false, question: "Name?" }),
    ];
    const drafts = initDraftMap(questions);
    drafts["storage"] = {
      ...emptyDraft,
      selected: ["SQLite", OTHER_SENTINEL],
      otherText: "  Postgres  ",
      note: "  gate behind a flag  ",
    };
    drafts["legacy"] = { ...emptyDraft, selected: ["Reader", "REST"] };
    drafts["naming"] = { ...emptyDraft, skipped: true };

    const payload = buildAnswerPayload(questions, drafts);

    expect(payload["storage"]).toEqual({
      selected: ["SQLite", "Postgres"],
      note: "gate behind a flag",
      skipped: false,
      question: "Which store?",
    });
    expect(payload["legacy"]?.selected).toEqual(["Reader", "REST"]);
    expect(payload["legacy"]?.note).toBeNull();
    expect(payload["naming"]).toEqual({
      selected: [],
      note: null,
      skipped: true,
      question: "Name?",
    });
  });

  it("falls back to index keys when ids are absent", () => {
    const questions = [
      item({ question: "First?" }),
      item({ question: "Second?" }),
    ];
    const drafts = initDraftMap(questions);
    drafts["0"] = { ...emptyDraft, selected: ["SQLite"] };
    const payload = buildAnswerPayload(questions, drafts);
    expect(Object.keys(payload)).toEqual(["0", "1"]);
    expect(payload["0"]?.selected).toEqual(["SQLite"]);
  });
});

describe("parseInline", () => {
  it("splits bold and code runs from plain text", () => {
    expect(parseInline("a **b** c `d` e")).toEqual([
      { kind: "text", text: "a " },
      { kind: "bold", text: "b" },
      { kind: "text", text: " c " },
      { kind: "code", text: "d" },
      { kind: "text", text: " e" },
    ]);
  });
  it("returns a single text span when there is no markup", () => {
    expect(parseInline("plain")).toEqual([{ kind: "text", text: "plain" }]);
  });
});

describe("parseContext", () => {
  it("groups consecutive bullet lines into a list and keeps paragraphs", () => {
    const blocks = parseContext("Intro line\n- one\n- two\nOutro");
    expect(blocks).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "Intro line" }] },
      {
        kind: "ul",
        items: [
          [{ kind: "text", text: "one" }],
          [{ kind: "text", text: "two" }],
        ],
      },
      { kind: "p", spans: [{ kind: "text", text: "Outro" }] },
    ]);
  });
});
