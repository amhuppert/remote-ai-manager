import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import {
  createSharedDocumentStore,
  hashSharedDocumentContent,
} from "@/lib/workflow-graph/shared-document-store";
import { createWorkflowDocumentMaterializer } from "@/lib/workflow-graph/document-materialization";
import { createGraphWorkflowExecutionsRepo } from "../graph-workflow-executions-repo";
import { createGraphWorkflowPendingArtifactsRepo } from "../graph-workflow-pending-artifacts-repo";
import { graphWorkflowDocumentContent } from "./0048-graph-workflow-document-content";

let fixture: PersistenceFixture | null = null;
const directories: string[] = [];
afterEach(async () => {
  fixture?.close();
  fixture = null;
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("graph workflow document content cutover", () => {
  it("retains immutable content after reload, marks missing bytes unavailable, and is idempotent", async () => {
    fixture = createPersistenceFixture();
    fixture.seedProject("/repo");
    fixture.seedSession("/repo", "session-1");
    const configDir = await mkdtemp(
      path.join(tmpdir(), "cc-document-cutover-"),
    );
    directories.push(configDir);
    const documentPath = ".cc/graph-workflow-docs/plan.md";
    const execution = createWorkflowExecution({
      sharedDocuments: [
        {
          id: "plan",
          kind: "shared",
          relativePath: documentPath,
          description: "plan",
          readWhen: "before work",
          createdAt: "2026-09-15",
          updatedAt: "2026-09-15",
          lastUpdatedByConversationId: null,
        },
        {
          id: "missing",
          kind: "shared",
          relativePath: ".cc/graph-workflow-docs/missing.md",
          description: "missing",
          readWhen: "before work",
          createdAt: "2026-09-15",
          updatedAt: "2026-09-15",
          lastUpdatedByConversationId: null,
        },
      ],
    });
    fixture.graphWorkflowExecutions.setActive(
      "/repo",
      "session-1",
      execution,
      "2026-09-15",
    );
    const oldPath = path.join(
      configDir,
      "workflow-docs",
      execution.id,
      documentPath,
    );
    await mkdir(path.dirname(oldPath), { recursive: true });
    await writeFile(oldPath, "original published plan");
    const migrationInput = {
      name: graphWorkflowDocumentContent.name,
      context: { db: fixture.db, configDir },
    };
    await graphWorkflowDocumentContent.up(migrationInput);
    await writeFile(oldPath, "changed after cutover");
    await graphWorkflowDocumentContent.up(migrationInput);
    const reloaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
      "/repo",
      "session-1",
    )!;
    expect(reloaded.sharedDocuments[0]?.contentHash).toBe(
      hashSharedDocumentContent("original published plan"),
    );
    expect(reloaded.sharedDocuments[1]?.contentHash).toBeNull();
    const store = createSharedDocumentStore({
      resolveConfigDir: () => configDir,
    });
    expect(
      await store.read({
        executionId: execution.id,
        ...reloaded.sharedDocuments[0]!,
      }),
    ).toBe("original published plan");
    expect(
      await store.read({
        executionId: execution.id,
        ...reloaded.sharedDocuments[1]!,
      }),
    ).toBeNull();
    expect(await readFile(oldPath, "utf8")).toBe("changed after cutover");
  });

  it("recovers unmaterialized seeded bytes from durable launch debt", async () => {
    fixture = createPersistenceFixture();
    fixture.seedProject("/repo");
    fixture.seedSession("/repo", "session-1");
    const configDir = await mkdtemp(
      path.join(tmpdir(), "cc-document-seed-cutover-"),
    );
    directories.push(configDir);
    const relativePath = ".cc/graph-workflow-docs/spec.md";
    const execution = createWorkflowExecution({
      sharedDocuments: [
        {
          id: "seed",
          kind: "seeded",
          relativePath,
          description: "spec",
          readWhen: "before work",
          createdAt: "2026-09-15",
          updatedAt: "2026-09-15",
          lastUpdatedByConversationId: null,
        },
      ],
    });
    fixture.graphWorkflowExecutions.setActive(
      "/repo",
      "session-1",
      execution,
      "2026-09-15",
    );
    createGraphWorkflowPendingArtifactsRepo(fixture.db).record({
      executionId: execution.id,
      projectPath: "/repo",
      sessionName: "session-1",
      recordedAt: "2026-09-15",
      documents: [
        {
          relativePath,
          contents: "pinned contract",
          description: "spec",
          readWhen: "before work",
        },
      ],
    });
    await graphWorkflowDocumentContent.up({
      name: graphWorkflowDocumentContent.name,
      context: { db: fixture.db, configDir },
    });
    const reloaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
      "/repo",
      "session-1",
    )!;
    const worktreePath = path.join(configDir, "worktree");
    await createWorkflowDocumentMaterializer({
      store: createSharedDocumentStore({ resolveConfigDir: () => configDir }),
    }).materialize({ execution: reloaded, worktreePath });
    expect(await readFile(path.join(worktreePath, relativePath), "utf8")).toBe(
      "pinned contract",
    );
  });
});
