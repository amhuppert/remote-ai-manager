import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSharedDocumentStore } from "./shared-document-store";
import { createWorkflowDocumentMaterializer } from "./document-materialization";
import { renderCharterMarkdown } from "./charter/render";
import { createWorkflowExecution } from "./test-fixtures";
import type { GraphWorkflowSharedDocumentEntry } from "@/lib/workflow-graph/definition-schemas";

const CHARTER_PATH = ".cc/graph-workflow-docs/charter.md";
const PLAN_PATH = ".cc/graph-workflow-docs/plan.md";
const GHOST_PATH = ".cc/graph-workflow-docs/ghost.md";

function charterEntry(): GraphWorkflowSharedDocumentEntry {
  return {
    id: "doc-charter",
    relativePath: CHARTER_PATH,
    description: "charter",
    readWhen: "always",
    kind: "charter",
    createdAt: "2026-03-27T12:00:00.000Z",
    updatedAt: "2026-03-27T12:00:00.000Z",
    lastUpdatedByConversationId: null,
  };
}

function sharedEntry(
  relativePath: string,
  id: string,
  contentHash?: string,
): GraphWorkflowSharedDocumentEntry {
  return {
    id,
    relativePath,
    contentHash,
    description: "shared",
    readWhen: "before work",
    kind: "shared",
    createdAt: "2026-03-27T12:00:00.000Z",
    updatedAt: "2026-03-27T12:00:00.000Z",
    lastUpdatedByConversationId: "conv-1",
  };
}

describe("workflow document materializer", () => {
  let configDir: string;
  let sourceWorktree: string;
  let laneWorktree: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "cc-mat-config-"));
    sourceWorktree = await mkdtemp(path.join(tmpdir(), "cc-mat-source-"));
    laneWorktree = await mkdtemp(path.join(tmpdir(), "cc-mat-lane-"));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
    await rm(sourceWorktree, { recursive: true, force: true });
    await rm(laneWorktree, { recursive: true, force: true });
  });

  it("leaves an active reader on its complete revision while atomically publishing the next document", async () => {
    const store = createSharedDocumentStore({
      resolveConfigDir: () => configDir,
    });
    const source = path.join(sourceWorktree, PLAN_PATH);
    const published = path.join(laneWorktree, PLAN_PATH);
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(path.dirname(published), { recursive: true });
    await writeFile(source, "Complete approved revision");
    await writeFile(published, "Complete prior revision");
    const { contentHash } = await store.captureFromWorktree({
      executionId: "execution-1",
      worktreePath: sourceWorktree,
      relativePath: PLAN_PATH,
    });
    const reader = await open(published, "r");
    try {
      await createWorkflowDocumentMaterializer({ store }).materialize({
        execution: createWorkflowExecution({
          sharedDocuments: [sharedEntry(PLAN_PATH, "doc-plan", contentHash)],
        }),
        worktreePath: laneWorktree,
      });
      expect(await reader.readFile("utf-8")).toBe("Complete prior revision");
      expect(await readFile(published, "utf-8")).toBe(
        "Complete approved revision",
      );
    } finally {
      await reader.close();
    }
  });

  it("materializes the rendered charter and captured shared docs into a lane worktree", async () => {
    const store = createSharedDocumentStore({
      resolveConfigDir: () => configDir,
    });

    // A different lane authored plan.md and registered it (captured to store).
    const planAbsolute = path.join(sourceWorktree, PLAN_PATH);
    await mkdir(path.dirname(planAbsolute), { recursive: true });
    await writeFile(planAbsolute, "# Plan\nstep one", "utf-8");
    const { contentHash } = await store.captureFromWorktree({
      executionId: "execution-1",
      worktreePath: sourceWorktree,
      relativePath: PLAN_PATH,
    });

    const execution = createWorkflowExecution({
      id: "execution-1",
      sharedDocuments: [
        charterEntry(),
        sharedEntry(PLAN_PATH, "doc-plan", contentHash),
      ],
    });

    const materializer = createWorkflowDocumentMaterializer({ store });
    const result = await materializer.materialize({
      execution,
      worktreePath: laneWorktree,
    });

    expect(result).toEqual({
      charterWritten: true,
      sharedWritten: 1,
      missing: [],
    });

    await expect(
      readFile(path.join(laneWorktree, CHARTER_PATH), "utf-8"),
    ).resolves.toBe(renderCharterMarkdown(execution.charter));
    await expect(
      readFile(path.join(laneWorktree, PLAN_PATH), "utf-8"),
    ).resolves.toBe("# Plan\nstep one");
  });

  it("refuses delivery when a registered document has unavailable content", async () => {
    const store = createSharedDocumentStore({
      resolveConfigDir: () => configDir,
    });
    const execution = createWorkflowExecution({
      id: "execution-1",
      sharedDocuments: [charterEntry(), sharedEntry(GHOST_PATH, "doc-ghost")],
    });

    const materializer = createWorkflowDocumentMaterializer({ store });
    await expect(
      materializer.materialize({
        execution,
        worktreePath: laneWorktree,
      }),
    ).rejects.toThrow(/unavailable.*ghost|ghost.*unavailable/);
    expect(existsSync(path.join(laneWorktree, GHOST_PATH))).toBe(false);
  });
});
