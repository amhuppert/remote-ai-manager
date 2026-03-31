import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "./test-fixtures";
import { createGraphWorkflowSharedDocumentRegistryService } from "./shared-documents";

describe("graph workflow shared document registry service", () => {
  it("registers a shared document inside the known worktree directory", () => {
    const service = createGraphWorkflowSharedDocumentRegistryService({
      now() {
        return "2026-03-27T18:00:00.000Z";
      },
      createDocumentId() {
        return "doc-2";
      },
    });
    const execution = createWorkflowExecution();

    const updated = service.upsert("/worktree", execution, {
      relativePath: ".cc/graph-workflow-docs/plan.md",
      description: "Shared implementation plan",
      readWhen: "Read before starting implementation work.",
      conversationId: "conversation-2",
    });

    expect(service.getDirectory("/worktree")).toBe(
      path.join("/worktree", ".cc", "graph-workflow-docs"),
    );
    expect(updated.sharedDocuments).toEqual([
      {
        id: "doc-2",
        relativePath: ".cc/graph-workflow-docs/plan.md",
        description: "Shared implementation plan",
        readWhen: "Read before starting implementation work.",
        createdAt: "2026-03-27T18:00:00.000Z",
        updatedAt: "2026-03-27T18:00:00.000Z",
        lastUpdatedByConversationId: "conversation-2",
      },
    ]);
  });

  it("updates existing shared documents and rejects paths outside the shared directory", () => {
    const service = createGraphWorkflowSharedDocumentRegistryService({
      now() {
        return "2026-03-27T18:10:00.000Z";
      },
    });
    const execution = createWorkflowExecution({
      sharedDocuments: [
        {
          id: "doc-1",
          relativePath: ".cc/graph-workflow-docs/plan.md",
          description: "Old plan",
          readWhen: "Old guidance",
          createdAt: "2026-03-27T17:00:00.000Z",
          updatedAt: "2026-03-27T17:00:00.000Z",
          lastUpdatedByConversationId: "conversation-1",
        },
      ],
    });

    const updated = service.upsert("/worktree", execution, {
      relativePath: ".cc/graph-workflow-docs/plan.md",
      description: "Latest plan",
      readWhen: "Read before editing runtime tasks.",
      conversationId: "conversation-3",
    });

    expect(updated.sharedDocuments[0]).toEqual({
      id: "doc-1",
      relativePath: ".cc/graph-workflow-docs/plan.md",
      description: "Latest plan",
      readWhen: "Read before editing runtime tasks.",
      createdAt: "2026-03-27T17:00:00.000Z",
      updatedAt: "2026-03-27T18:10:00.000Z",
      lastUpdatedByConversationId: "conversation-3",
    });

    expect(() =>
      service.upsert("/worktree", execution, {
        relativePath: "notes/outside.md",
        description: "Not allowed",
        readWhen: "Never",
      }),
    ).toThrow(
      "Shared documents must be registered inside .cc/graph-workflow-docs/",
    );
  });

  it("normalizes equivalent shared-document paths so updates do not duplicate entries", () => {
    const service = createGraphWorkflowSharedDocumentRegistryService({
      now() {
        return "2026-03-27T18:15:00.000Z";
      },
    });
    const execution = createWorkflowExecution({
      sharedDocuments: [
        {
          id: "doc-1",
          relativePath: ".cc/graph-workflow-docs/plan.md",
          description: "Old plan",
          readWhen: "Old guidance",
          createdAt: "2026-03-27T17:00:00.000Z",
          updatedAt: "2026-03-27T17:00:00.000Z",
          lastUpdatedByConversationId: "conversation-1",
        },
      ],
    });

    const updated = service.upsert("/worktree", execution, {
      relativePath: ".cc/graph-workflow-docs/./plan.md",
      description: "Normalized plan",
      readWhen: "Read before the next iteration.",
      conversationId: "conversation-4",
    });

    expect(updated.sharedDocuments).toEqual([
      {
        id: "doc-1",
        relativePath: ".cc/graph-workflow-docs/plan.md",
        description: "Normalized plan",
        readWhen: "Read before the next iteration.",
        createdAt: "2026-03-27T17:00:00.000Z",
        updatedAt: "2026-03-27T18:15:00.000Z",
        lastUpdatedByConversationId: "conversation-4",
      },
    ]);
  });
});
