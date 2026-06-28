import { describe, expect, it } from "vitest";
import {
  commentAnchorSchema,
  commentStatusSchema,
  documentCommentSchema,
  documentFeedbackItemSchema,
  documentFeedbackPayloadSchema,
  documentFeedbackTargetSchema,
  documentRefSchema,
  type CommentAnchor,
  type DocumentComment,
  type DocumentFeedbackPayload,
  type DocumentFeedbackTarget,
} from "./schemas";

function maximalAnchor(): CommentAnchor {
  return {
    sectionId: "2-design",
    headingLabel: "2 › 2.1 Design",
    line: 42,
    charStart: 5,
    charEnd: 18,
    quote: "exact quoted text",
    prefix: "the words before ",
    suffix: " the words after",
    docRevision: "sha256:abcdef0123456789",
  };
}

function maximalComment(): DocumentComment {
  return {
    id: "dc-maximal",
    projectPath: "/Users/alex/github/command-center",
    sessionName: "csm/example",
    docPath: ".kiro/specs/markdown-doc-feedback/design.md",
    anchor: maximalAnchor(),
    note: "Please tighten this paragraph.",
    status: "sent",
    createdAt: "2026-06-27T08:00:00.000Z",
    updatedAt: "2026-06-27T08:05:00.000Z",
    sentAt: "2026-06-27T08:05:00.000Z",
  };
}

function maximalTarget(): DocumentFeedbackTarget {
  return {
    projectName: "command-center",
    projectPath: "/Users/alex/github/command-center",
    sessionName: "csm/example",
    conversationId: "conv-123",
    backend: "claude",
    status: "running",
  };
}

function maximalPayload(): DocumentFeedbackPayload {
  return {
    items: [
      {
        docPath: ".kiro/specs/markdown-doc-feedback/design.md",
        path: ".kiro/specs/markdown-doc-feedback/design.md",
        headingLabel: "2 › 2.1 Design",
        line: 42,
        quote: "exact quoted text",
        note: "Please tighten this paragraph.",
      },
    ],
  };
}

describe("commentStatusSchema", () => {
  it("accepts the two valid statuses", () => {
    expect(commentStatusSchema.parse("pending")).toBe("pending");
    expect(commentStatusSchema.parse("sent")).toBe("sent");
  });

  it("rejects any other status", () => {
    expect(commentStatusSchema.safeParse("deleted").success).toBe(false);
    expect(commentStatusSchema.safeParse("").success).toBe(false);
  });
});

describe("commentAnchorSchema", () => {
  it("parses a maximal anchor", () => {
    expect(commentAnchorSchema.parse(maximalAnchor())).toEqual(maximalAnchor());
  });

  it("rejects a non-integer line", () => {
    const bad = { ...maximalAnchor(), line: 4.5 };
    expect(commentAnchorSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a missing offset", () => {
    const bad: Record<string, unknown> = { ...maximalAnchor() };
    delete bad.charEnd;
    expect(commentAnchorSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-string quote", () => {
    const bad = { ...maximalAnchor(), quote: 123 };
    expect(commentAnchorSchema.safeParse(bad).success).toBe(false);
  });
});

describe("documentCommentSchema", () => {
  it("parses a maximal comment with a nested anchor", () => {
    expect(documentCommentSchema.parse(maximalComment())).toEqual(
      maximalComment(),
    );
  });

  it("accepts a null sentAt (never sent)", () => {
    const pending: DocumentComment = {
      ...maximalComment(),
      status: "pending",
      sentAt: null,
    };
    expect(documentCommentSchema.parse(pending)).toEqual(pending);
  });

  it("rejects an invalid status", () => {
    const bad = { ...maximalComment(), status: "archived" };
    expect(documentCommentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a malformed nested anchor", () => {
    const bad = {
      ...maximalComment(),
      anchor: { ...maximalAnchor(), line: "forty-two" },
    };
    expect(documentCommentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an omitted sentAt (must be explicit string or null)", () => {
    const bad: Record<string, unknown> = { ...maximalComment() };
    delete bad.sentAt;
    expect(documentCommentSchema.safeParse(bad).success).toBe(false);
  });
});

describe("documentRefSchema", () => {
  it("parses a maximal document ref", () => {
    const ref = {
      projectName: "command-center",
      sessionName: "csm/example",
      docPath: ".kiro/specs/markdown-doc-feedback/design.md",
      title: "Design Document",
    };
    expect(documentRefSchema.parse(ref)).toEqual(ref);
  });

  it("rejects a missing docPath", () => {
    const bad = {
      projectName: "command-center",
      sessionName: "csm/example",
      title: "Design Document",
    };
    expect(documentRefSchema.safeParse(bad).success).toBe(false);
  });
});

describe("documentFeedbackTargetSchema", () => {
  it("parses a maximal target carrying the full routing identity", () => {
    expect(documentFeedbackTargetSchema.parse(maximalTarget())).toEqual(
      maximalTarget(),
    );
  });

  it("rejects an unknown backend", () => {
    const bad = { ...maximalTarget(), backend: "gemini" };
    expect(documentFeedbackTargetSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown conversation status", () => {
    const bad = { ...maximalTarget(), status: "exploded" };
    expect(documentFeedbackTargetSchema.safeParse(bad).success).toBe(false);
  });
});

describe("documentFeedbackItemSchema / documentFeedbackPayloadSchema", () => {
  it("parses a maximal feedback item", () => {
    const item = maximalPayload().items[0];
    expect(documentFeedbackItemSchema.parse(item)).toEqual(item);
  });

  it("parses a maximal feedback payload", () => {
    expect(documentFeedbackPayloadSchema.parse(maximalPayload())).toEqual(
      maximalPayload(),
    );
  });

  it("rejects a feedback item with a non-numeric line", () => {
    const bad = { ...maximalPayload().items[0], line: "x" };
    expect(documentFeedbackItemSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a payload whose items are not an array", () => {
    const bad = { items: maximalPayload().items[0] };
    expect(documentFeedbackPayloadSchema.safeParse(bad).success).toBe(false);
  });
});
