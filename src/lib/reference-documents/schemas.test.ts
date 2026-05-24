import { describe, it, expect } from "vitest";
import { referenceDocumentSchema } from "./schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";

// ===========================================================================
// referenceDocumentSchema
// ===========================================================================

describe("referenceDocumentSchema", () => {
  it("parses a valid reference document", () => {
    const doc = {
      id: "abc-123",
      filePath: ".cc/references/design.md",
      description: "Architecture design notes",
      createdAt: "2026-03-30T12:00:00.000Z",
    };
    const result = referenceDocumentSchema.safeParse(doc);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(doc);
    }
  });

  it("rejects when required fields are missing", () => {
    const result = referenceDocumentSchema.safeParse({ id: "abc" });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// sessionStateSchema — referenceDocuments field
// ===========================================================================

describe("sessionStateSchema — referenceDocuments field", () => {
  const baseSession = {
    sessionName: "test-session",
    worktreePath: "/tmp/test",
    branchName: "csm/test",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    archived: false,
    conversations: [],
  };

  it("defaults referenceDocuments to empty array when not provided", () => {
    const result = sessionStateSchema.safeParse(baseSession);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.referenceDocuments).toEqual([]);
    }
  });

  it("preserves provided referenceDocuments", () => {
    const docs = [
      {
        id: "doc-1",
        filePath: "memory-bank/focus.md",
        description: "Session focus",
        createdAt: "2026-03-30T12:00:00.000Z",
      },
    ];
    const result = sessionStateSchema.safeParse({
      ...baseSession,
      referenceDocuments: docs,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.referenceDocuments).toEqual(docs);
    }
  });
});
