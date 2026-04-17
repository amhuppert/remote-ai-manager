import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfigReader } from "@/lib/config";
import {
  buildGraphWorkflowCutoverBackupPath,
  createGraphWorkflowContextValidatorCutoverRunner,
} from "./context-validator-cutover";

function makeState() {
  return {
    projects: {
      "/repo": {
        rootPath: "/repo",
        roadmapItems: [],
        sessions: {
          "session-1": {
            sessionName: "session-1",
            worktreePath: "/repo/.worktrees/session-1",
            branchName: "csm/session-1",
            createdAt: "2026-04-16T00:00:00.000Z",
            lastActivityAt: "2026-04-16T00:00:00.000Z",
            archived: false,
            finished: false,
            conversations: [],
            source: "cc",
            objective: null,
            creationMode: "fast",
            tddEnabled: true,
            targetBranch: "main",
            parentSessionName: null,
            graphWorkflowExecution: {
              executionId: "execution-1",
              legacy: true,
            },
            graphWorkflowExecutionHistory: [
              { executionId: "archived-1" },
              { executionId: "archived-2" },
            ],
            referenceDocuments: [],
          },
          "session-2": {
            sessionName: "session-2",
            worktreePath: "/repo/.worktrees/session-2",
            branchName: "csm/session-2",
            createdAt: "2026-04-16T00:00:00.000Z",
            lastActivityAt: "2026-04-16T00:00:00.000Z",
            archived: false,
            finished: false,
            conversations: [],
            source: "cc",
            objective: null,
            creationMode: "fast",
            tddEnabled: true,
            targetBranch: "main",
            parentSessionName: null,
            graphWorkflowExecution: null,
            graphWorkflowExecutionHistory: [],
            referenceDocuments: [],
          },
        },
      },
    },
    archivedProjects: [],
    pinnedProjects: [],
  };
}

describe("buildGraphWorkflowCutoverBackupPath", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(
      path.join(os.tmpdir(), "cc-graph-workflow-cutover-backup-"),
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("increments the suffix when prior backups already exist", async () => {
    const stateFilePath = path.join(tempDir, "state.json");
    await writeFile(stateFilePath, "{}", "utf-8");
    await writeFile(
      `${stateFilePath}.graph-workflow-context-validator-cutover.bak`,
      "older",
      "utf-8",
    );
    await writeFile(
      `${stateFilePath}.graph-workflow-context-validator-cutover.1.bak`,
      "oldest",
      "utf-8",
    );

    expect(buildGraphWorkflowCutoverBackupPath(stateFilePath)).toBe(
      `${stateFilePath}.graph-workflow-context-validator-cutover.2.bak`,
    );
  });
});

describe("createGraphWorkflowContextValidatorCutoverRunner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(
      path.join(os.tmpdir(), "cc-graph-workflow-cutover-runner-"),
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("backs up state, clears persisted executions, archives workflows, and writes a marker", async () => {
    const configReader = createConfigReader(tempDir);
    const config = await configReader.readConfig();
    const stateFilePath = config.stateFilePath;
    const originalRaw = JSON.stringify(makeState(), null, 2);
    const workflowsDir = path.join(tempDir, "workflows");
    const projectWorkflowDir = path.join(
      workflowsDir,
      Buffer.from("/repo").toString("base64url"),
    );

    await writeFile(stateFilePath, originalRaw, "utf-8");
    await mkdir(projectWorkflowDir, { recursive: true });
    await writeFile(
      path.join(projectWorkflowDir, "workflow.json"),
      "{}",
      "utf-8",
    );
    await mkdir(
      path.join(
        tempDir,
        "workflows.graph-workflow-context-validator-cutover.bak",
      ),
      { recursive: true },
    );

    const runCutover = createGraphWorkflowContextValidatorCutoverRunner({
      readConfig: () => configReader.readConfig(),
    });

    const result = await runCutover();

    expect(result.status).toBe("completed");
    expect(result.stateBackupPath).toBe(
      `${stateFilePath}.graph-workflow-context-validator-cutover.bak`,
    );
    expect(result.workflowDefinitionsBackupPath).toBe(
      path.join(
        tempDir,
        "workflows.graph-workflow-context-validator-cutover.1.bak",
      ),
    );
    await expect(readFile(result.stateBackupPath!, "utf-8")).resolves.toBe(
      originalRaw,
    );

    const rewritten = JSON.parse(await readFile(stateFilePath, "utf-8")) as {
      projects: Record<
        string,
        {
          sessions: Record<
            string,
            {
              graphWorkflowExecution: unknown;
              graphWorkflowExecutionHistory: unknown[];
            }
          >;
        }
      >;
    };

    expect(
      rewritten.projects["/repo"]!.sessions["session-1"]!
        .graphWorkflowExecution,
    ).toBeNull();
    expect(
      rewritten.projects["/repo"]!.sessions["session-1"]!
        .graphWorkflowExecutionHistory,
    ).toEqual([]);
    expect(
      rewritten.projects["/repo"]!.sessions["session-2"]!
        .graphWorkflowExecution,
    ).toBeNull();
    expect(
      rewritten.projects["/repo"]!.sessions["session-2"]!
        .graphWorkflowExecutionHistory,
    ).toEqual([]);

    expect(existsSync(workflowsDir)).toBe(false);
    expect(
      existsSync(
        path.join(
          result.workflowDefinitionsBackupPath!,
          Buffer.from("/repo").toString("base64url"),
          "workflow.json",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(tempDir, "graph-workflow-context-validator-cutover.json"),
      ),
    ).toBe(true);
  });

  it("does nothing after the marker file exists", async () => {
    const configReader = createConfigReader(tempDir);
    const config = await configReader.readConfig();
    const stateFilePath = config.stateFilePath;
    const originalRaw = JSON.stringify(makeState(), null, 2);
    const workflowsDir = path.join(tempDir, "workflows");

    await writeFile(stateFilePath, originalRaw, "utf-8");
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(
      path.join(tempDir, "graph-workflow-context-validator-cutover.json"),
      JSON.stringify({ appliedAt: "2026-04-16T00:00:00.000Z" }, null, 2),
      "utf-8",
    );

    const runCutover = createGraphWorkflowContextValidatorCutoverRunner({
      readConfig: () => configReader.readConfig(),
    });

    const result = await runCutover();

    expect(result.status).toBe("already_ran");
    await expect(readFile(stateFilePath, "utf-8")).resolves.toBe(originalRaw);
    expect(existsSync(workflowsDir)).toBe(true);
    expect(result.stateBackupPath).toBeNull();
    expect(result.workflowDefinitionsBackupPath).toBeNull();
  });

  it("writes the marker even when there is nothing to clean", async () => {
    const configReader = createConfigReader(tempDir);
    await configReader.readConfig();

    const runCutover = createGraphWorkflowContextValidatorCutoverRunner({
      readConfig: () => configReader.readConfig(),
    });

    const result = await runCutover();

    expect(result.status).toBe("completed");
    expect(result.stateBackupPath).toBeNull();
    expect(result.workflowDefinitionsBackupPath).toBeNull();
    expect(
      existsSync(
        path.join(tempDir, "graph-workflow-context-validator-cutover.json"),
      ),
    ).toBe(true);
  });
});
