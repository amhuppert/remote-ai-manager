import { describe, expect, it } from "vitest";
import {
  markdownDocumentListItemSchema,
  sessionMarkdownDocumentSchema,
} from "./schemas";

describe("session Markdown document schemas", () => {
  it("round-trips a persisted document", () => {
    const value = {
      docPath: "/shared/runbook.md",
      origin: "read",
      firstSeenAt: "2026-07-11T10:00:00.000Z",
      lastSeenAt: "2026-07-11T11:00:00.000Z",
    };
    expect(sessionMarkdownDocumentSchema.parse(value)).toEqual(value);
  });

  it("round-trips a unified external registered item", () => {
    const value = {
      docPath: "/shared/runbook.md",
      title: "runbook.md",
      origin: "registered",
      firstSeenAt: "2026-07-11T10:00:00.000Z",
      lastSeenAt: "2026-07-11T10:00:00.000Z",
      location: "external",
      registered: true,
      description: "Operations runbook",
    };
    expect(markdownDocumentListItemSchema.parse(value)).toEqual(value);
  });

  it("rejects unsupported origins", () => {
    expect(
      sessionMarkdownDocumentSchema.safeParse({
        docPath: "a.md",
        origin: "opened",
        firstSeenAt: "x",
        lastSeenAt: "y",
      }).success,
    ).toBe(false);
  });
});
