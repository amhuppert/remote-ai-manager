import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "./test-fixtures";
import { createGraphWorkflowSharedDocumentRegistryService } from "./shared-documents";

describe("graph workflow shared document registry service", () => {
  it("registers a shared document inside the known worktree directory", async () => {
    const service = createGraphWorkflowSharedDocumentRegistryService({
      now() {
        return "2026-03-27T18:00:00.000Z";
      },
      createDocumentId() {
        return "doc-2";
      },
    });
    const execution = createWorkflowExecution();

    const updated = await service.upsert("/worktree", execution, {
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
        kind: "shared",
        createdAt: "2026-03-27T18:00:00.000Z",
        updatedAt: "2026-03-27T18:00:00.000Z",
        lastUpdatedByConversationId: "conversation-2",
      },
    ]);
  });

  it("updates existing shared documents and rejects paths outside the shared directory", async () => {
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
          kind: "shared",
          createdAt: "2026-03-27T17:00:00.000Z",
          updatedAt: "2026-03-27T17:00:00.000Z",
          lastUpdatedByConversationId: "conversation-1",
        },
      ],
    });

    const updated = await service.upsert("/worktree", execution, {
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
      kind: "shared",
      createdAt: "2026-03-27T17:00:00.000Z",
      updatedAt: "2026-03-27T18:10:00.000Z",
      lastUpdatedByConversationId: "conversation-3",
    });

    await expect(
      service.upsert("/worktree", execution, {
        relativePath: "notes/outside.md",
        description: "Not allowed",
        readWhen: "Never",
      }),
    ).rejects.toThrow(/must be written under \.cc\/graph-workflow-docs\//);
  });

  it("normalizes equivalent shared-document paths so updates do not duplicate entries", async () => {
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
          kind: "shared",
          createdAt: "2026-03-27T17:00:00.000Z",
          updatedAt: "2026-03-27T17:00:00.000Z",
          lastUpdatedByConversationId: "conversation-1",
        },
      ],
    });

    const updated = await service.upsert("/worktree", execution, {
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
        kind: "shared",
        createdAt: "2026-03-27T17:00:00.000Z",
        updatedAt: "2026-03-27T18:15:00.000Z",
        lastUpdatedByConversationId: "conversation-4",
      },
    ]);
  });

  it("fails the workflow with ArtifactRequiredFailure when a required upsert path escapes the shared directory", async () => {
    const service = createGraphWorkflowSharedDocumentRegistryService();
    const execution = createWorkflowExecution();

    await expect(
      service.upsert("/worktree", execution, {
        relativePath: "../escape.md",
        description: "boom",
        readWhen: "never",
      }),
    ).rejects.toMatchObject({
      name: "ArtifactRequiredFailure",
      kind: "graph_shared_document",
      stage: "path_resolution",
    });
  });

  it("degrades to skipped_warning outcome when an optional upsert path is invalid", async () => {
    const service = createGraphWorkflowSharedDocumentRegistryService();
    const execution = createWorkflowExecution();

    const outcome = await service.upsertOptional("/worktree", execution, {
      relativePath: "notes/outside.md",
      description: "should be skipped, not propagated",
      readWhen: "n/a",
    });

    expect(outcome.status).toBe("skipped_warning");
    if (outcome.status === "skipped_warning") {
      expect(outcome.warning).toMatch(
        /must be written under \.cc\/graph-workflow-docs\//,
      );
    }
    expect(execution.sharedDocuments).toEqual([]);
  });

  it("makes the registered shared document discoverable via list()", async () => {
    const service = createGraphWorkflowSharedDocumentRegistryService({
      now() {
        return "2026-04-01T10:00:00.000Z";
      },
      createDocumentId() {
        return "doc-list";
      },
    });
    const execution = createWorkflowExecution();

    const next = await service.upsert("/worktree", execution, {
      relativePath: ".cc/graph-workflow-docs/notes.md",
      description: "Cross-context notes",
      readWhen: "Read before next planning round.",
      conversationId: "conv-list",
    });

    expect(service.list(next).map((entry) => entry.relativePath)).toContain(
      ".cc/graph-workflow-docs/notes.md",
    );
    expect(service.list(next)).toHaveLength(1);
    expect(service.list(next)[0]).toMatchObject({
      id: "doc-list",
      description: "Cross-context notes",
      readWhen: "Read before next planning round.",
      lastUpdatedByConversationId: "conv-list",
    });
  });
});
