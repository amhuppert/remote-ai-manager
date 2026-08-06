import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { createGraphWorkflowArchivedExecutionsRepo } from "../graph-workflow-archived-executions-repo";
import { createGraphWorkflowExecutionsRepo } from "../graph-workflow-executions-repo";
import { scriptValidatorCommands } from "./0013-script-validator-commands";

type Db = InstanceType<typeof Database>;

const SESSION_NAME = "session-1";
const tempDirs: string[] = [];
const fixtures: PersistenceFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.close();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function freshDb(projectPath: string): Db {
  const fixture = createPersistenceFixture();
  fixtures.push(fixture);
  fixture.seedProject(projectPath);
  fixture.seedSession(projectPath, SESSION_NAME);
  return fixture.db;
}

function freshFixtureRoot(): string {
  const tempRoot = path.join(process.cwd(), ".cc", "temp");
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(path.join(tempRoot, "script-validator-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function readJson<T = unknown>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

interface StoredWorkflowFixture {
  definition: {
    workflowConfig: { scriptValidator: { commands: string[] } };
    executionContexts: Array<{
      scriptValidator?: { commands: string[] };
    }>;
  };
}

function workflowPath(
  configDir: string,
  projectPath: string,
  id = "wf-1",
): string {
  const projectKey = Buffer.from(projectPath).toString("base64url");
  return path.join(configDir, "workflows", projectKey, `${id}.json`);
}

function seedWorkflow(
  configDir: string,
  projectPath: string,
  definition: unknown,
): string {
  const filePath = workflowPath(configDir, projectPath);
  writeJson(filePath, {
    id: "wf-1",
    name: "Stored workflow",
    definition,
  });
  return filePath;
}

function seedExecutionRows(db: Db, projectPath: string): void {
  const activeRepo = createGraphWorkflowExecutionsRepo(db);
  const active = createWorkflowExecution({
    id: "exec-active",
    status: "running",
  });
  activeRepo.setActive(
    projectPath,
    SESSION_NAME,
    active,
    "2026-08-05T00:00:00.000Z",
  );
  const activeRow = db
    .prepare(
      `SELECT definition_json
         FROM graph_workflow_executions
        WHERE execution_id = ?`,
    )
    .get(active.id) as { definition_json: string };
  db.prepare(
    `UPDATE graph_workflow_executions
        SET definition_json = ?
      WHERE execution_id = ?`,
  ).run(
    withLegacyScriptValidators(activeRow.definition_json, [true, false]),
    active.id,
  );

  const archived = createWorkflowExecution({
    id: "exec-archived",
    status: "completed",
    completedAt: "2026-08-05T01:00:00.000Z",
  });
  createGraphWorkflowArchivedExecutionsRepo(db).insert({
    projectPath,
    sessionName: SESSION_NAME,
    executionId: archived.id,
    archivedAt: "2026-08-05T01:00:00.000Z",
    status: "completed",
    startedAt: archived.startedAt,
    completedAt: archived.completedAt,
    execution: archived,
  });
  const archivedRow = db
    .prepare(
      `SELECT execution_json
         FROM graph_workflow_archived_executions
        WHERE execution_id = ?`,
    )
    .get(archived.id) as { execution_json: string };
  db.prepare(
    `UPDATE graph_workflow_archived_executions
        SET execution_json = ?
      WHERE execution_id = ?`,
  ).run(
    withLegacyScriptValidators(archivedRow.execution_json, [true]),
    archived.id,
  );
}

function withLegacyScriptValidators(
  raw: string,
  enabledValues: readonly boolean[],
): string {
  const value = JSON.parse(raw) as {
    workingDefinition: {
      executionContexts: Array<Record<string, unknown>>;
    };
  };
  enabledValues.forEach((enabled, index) => {
    const context = value.workingDefinition.executionContexts[index];
    if (context === undefined) {
      throw new Error(`execution context ${index} is unavailable`);
    }
    context.scriptValidator = { enabled };
  });
  return JSON.stringify(value);
}

async function runMigration(db: Db, configDir: string): Promise<void> {
  await scriptValidatorCommands.up({
    name: scriptValidatorCommands.name,
    context: { db, configDir },
  });
}

describe("0013-script-validator-commands", () => {
  it("maps enabled flags in global defaults, stored definitions, active executions, and archives", async () => {
    const root = freshFixtureRoot();
    const configDir = path.join(root, "config");
    const projectPath = path.join(root, "project");
    const db = freshDb(projectPath);
    writeJson(path.join(configDir, "config.json"), {
      workflowDefaults: { scriptValidator: { enabled: true } },
    });
    writeJson(path.join(projectPath, "CommandCenter.json"), {
      validation: {
        commands: {
          "pre-merge": { command: "scripts/pre-merge.sh", cost: 8 },
        },
      },
    });
    const storedPath = seedWorkflow(configDir, projectPath, {
      workflowConfig: { scriptValidator: { enabled: false } },
      executionContexts: [
        { id: "context-on", scriptValidator: { enabled: true } },
        { id: "context-inherit" },
      ],
    });
    seedExecutionRows(db, projectPath);

    await runMigration(db, configDir);

    expect(readJson(path.join(configDir, "config.json"))).toMatchObject({
      workflowDefaults: { scriptValidator: { commands: ["pre-merge"] } },
    });
    const stored = readJson<StoredWorkflowFixture>(storedPath);
    expect(stored.definition.workflowConfig.scriptValidator).toEqual({
      commands: [],
    });
    expect(stored.definition.executionContexts[0]?.scriptValidator).toEqual({
      commands: ["pre-merge"],
    });
    expect(
      stored.definition.executionContexts[1]?.scriptValidator,
    ).toBeUndefined();

    const active = createGraphWorkflowExecutionsRepo(db).getActive(
      projectPath,
      SESSION_NAME,
    );
    expect(
      active?.workingDefinition.executionContexts
        .slice(0, 2)
        .map((context) => context.scriptValidator),
    ).toEqual([{ commands: ["pre-merge"] }, { commands: [] }]);

    const archived = createGraphWorkflowArchivedExecutionsRepo(
      db,
    ).findByExecution(projectPath, SESSION_NAME, "exec-archived");
    expect(
      archived?.workingDefinition.executionContexts[0]?.scriptValidator,
    ).toEqual({ commands: ["pre-merge"] });

    await runMigration(db, configDir);
    expect(
      readJson<StoredWorkflowFixture>(storedPath).definition
        .executionContexts[0]?.scriptValidator,
    ).toEqual({ commands: ["pre-merge"] });
  });

  it("rejects a legacy-only preMergeCommand during final-build preflight", async () => {
    const root = freshFixtureRoot();
    const configDir = path.join(root, "config");
    const projectPath = path.join(root, "project");
    const db = freshDb(projectPath);
    writeJson(path.join(projectPath, "CommandCenter.json"), {
      preMergeCommand: "scripts/pre-merge.sh",
    });
    const storedPath = seedWorkflow(configDir, projectPath, {
      workflowConfig: { scriptValidator: { enabled: true } },
      executionContexts: [{ id: "context-inherit" }],
    });
    const before = readFileSync(storedPath, "utf-8");

    await expect(runMigration(db, configDir)).rejects.toThrow(
      `${path.join(projectPath, "CommandCenter.json")}: register validation.commands.pre-merge`,
    );
    expect(readFileSync(storedPath, "utf-8")).toBe(before);
  });

  it("rejects an invalid pre-merge registry entry during preflight", async () => {
    const root = freshFixtureRoot();
    const configDir = path.join(root, "config");
    const projectPath = path.join(root, "project");
    const db = freshDb(projectPath);
    writeJson(path.join(projectPath, "CommandCenter.json"), {
      validation: {
        commands: {
          "pre-merge": { command: "scripts/pre-merge.sh", cost: 0 },
        },
      },
    });
    const storedPath = seedWorkflow(configDir, projectPath, {
      workflowConfig: { scriptValidator: { enabled: true } },
      executionContexts: [{ id: "context-inherit" }],
    });
    const before = readFileSync(storedPath, "utf-8");

    await expect(runMigration(db, configDir)).rejects.toThrow(
      `${path.join(projectPath, "CommandCenter.json")}: register validation.commands.pre-merge`,
    );
    expect(readFileSync(storedPath, "utf-8")).toBe(before);
  });

  it("fails closed with the workflow and selector paths before rewriting when pre-merge is unavailable", async () => {
    const root = freshFixtureRoot();
    const configDir = path.join(root, "config");
    const projectPath = path.join(root, "project");
    const db = freshDb(projectPath);
    const storedPath = seedWorkflow(configDir, projectPath, {
      workflowConfig: {},
      executionContexts: [
        { id: "context-on", scriptValidator: { enabled: true } },
      ],
    });
    const before = readFileSync(storedPath, "utf-8");

    await expect(runMigration(db, configDir)).rejects.toThrow(
      new RegExp(
        `${storedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: definition\\.executionContexts\\.0\\.scriptValidator`,
      ),
    );
    await expect(runMigration(db, configDir)).rejects.toThrow(
      `${path.join(projectPath, "CommandCenter.json")}: register validation.commands.pre-merge`,
    );
    expect(readFileSync(storedPath, "utf-8")).toBe(before);
    expect(existsSync(path.join(configDir, "config.json"))).toBe(false);
  });
});
