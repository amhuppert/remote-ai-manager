import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
} from "./test-fixtures";
import { createWorkflowStorageService, type WorkflowScope } from "./storage";

const PROJECT_PATH = "/repo";
const PROJECT_SCOPE: WorkflowScope = {
  kind: "project",
  projectPath: PROJECT_PATH,
};
const GLOBAL_SCOPE: WorkflowScope = { kind: "global" };

const REPRESENTATIVE_PROJECT_PATHS = [
  "/repo",
  "/Users/alex/github/command-center",
  "/tmp/some project with spaces",
  "C:\\Users\\alex\\repo",
  "",
];

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "cc-workflow-storage-scope-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function storageFor() {
  return createWorkflowStorageService({ resolveConfigDir: () => tempDir });
}

function draft() {
  return {
    name: "Scope Workflow",
    description: "Scoped workflow",
    definition: createWorkflowDefinition(),
    layout: createWorkflowDefinitionRecord().layout,
  };
}

describe("workflow storage — global scope round-trip", () => {
  it("creates, lists, gets, updates, and deletes a global-scope record under the reserved directory", async () => {
    const storage = storageFor();

    const created = await storage.create(GLOBAL_SCOPE, draft());
    expect(created.id).toBeTruthy();
    expect(created.revision).toBe(1);

    // The record lands under the reserved global key directory, NOT under any
    // base64url(projectPath) directory.
    const reservedDir = path.join(tempDir, "workflows", "global.shared");
    expect(existsSync(path.join(reservedDir, `${created.id}.json`))).toBe(true);

    const listed = await storage.list(GLOBAL_SCOPE);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);

    const loaded = await storage.get(GLOBAL_SCOPE, created.id);
    expect(loaded?.name).toBe("Scope Workflow");

    const updated = await storage.update(GLOBAL_SCOPE, created.id, {
      ...draft(),
      name: "Updated Global",
    });
    expect(updated.revision).toBe(2);
    expect(updated.name).toBe("Updated Global");

    expect(await storage.delete(GLOBAL_SCOPE, created.id)).toBe(true);
    expect(await storage.get(GLOBAL_SCOPE, created.id)).toBeNull();
  });

  it("isolates the global tier from the project tier (no cross-scope visibility)", async () => {
    const storage = storageFor();

    const globalRecord = await storage.create(GLOBAL_SCOPE, draft());
    const projectRecord = await storage.create(PROJECT_SCOPE, draft());

    // A project-scope get never resolves a global record and vice versa.
    expect(await storage.get(PROJECT_SCOPE, globalRecord.id)).toBeNull();
    expect(await storage.get(GLOBAL_SCOPE, projectRecord.id)).toBeNull();

    expect(await storage.list(GLOBAL_SCOPE)).toHaveLength(1);
    expect(await storage.list(PROJECT_SCOPE)).toHaveLength(1);
    expect((await storage.list(GLOBAL_SCOPE))[0]?.id).toBe(globalRecord.id);
    expect((await storage.list(PROJECT_SCOPE))[0]?.id).toBe(projectRecord.id);
  });

  it("runs accept-time validation under the global scope (rejects an invalid definition)", async () => {
    const storage = storageFor();

    await expect(
      storage.create(GLOBAL_SCOPE, {
        ...draft(),
        definition: createWorkflowDefinition({
          tasks: [
            {
              id: "task-bad",
              contextId: "missing",
              order: 1,
              title: "Bad task",
              instructions: "Broken",
              source: "user",
            },
          ],
        }),
      }),
    ).rejects.toThrow("unknown-task-context");
  });

  it("runs the parameter-reference lint under the global scope", async () => {
    const storage = storageFor();
    const base = createWorkflowDefinition();

    await expect(
      storage.create(GLOBAL_SCOPE, {
        ...draft(),
        definition: createWorkflowDefinition({
          tasks: base.tasks.map((task, index) =>
            index === 0
              ? { ...task, instructions: "Build {{inputs.unknown-name}} now" }
              : task,
          ),
        }),
      }),
    ).rejects.toThrow("undeclared-parameter-reference");
  });
});

describe("workflow storage — project scope path is byte-for-byte unchanged", () => {
  it("resolves the project tier to <configDir>/workflows/<base64url(projectPath)> exactly as before scope", async () => {
    const storage = storageFor();

    const created = await storage.create(PROJECT_SCOPE, draft());

    // The pre-change resolver was `Buffer.from(projectPath).toString("base64url")`.
    const expectedKey = Buffer.from(PROJECT_PATH).toString("base64url");
    const expectedFile = path.join(
      tempDir,
      "workflows",
      expectedKey,
      `${created.id}.json`,
    );
    expect(existsSync(expectedFile)).toBe(true);
  });
});

describe("reserved global key collision-impossibility", () => {
  it("contains at least one character outside the base64url alphabet", () => {
    const reservedKey = "global.shared";
    const base64urlAlphabet = /^[A-Za-z0-9_-]+$/;
    expect(base64urlAlphabet.test(reservedKey)).toBe(false);
    // Specifically a '.' segment, which base64url never emits.
    expect(reservedKey).toContain(".");
  });

  it("is never equal to base64url(projectPath) for representative paths", () => {
    const reservedKey = "global.shared";
    for (const projectPath of REPRESENTATIVE_PROJECT_PATHS) {
      const projectKey = Buffer.from(projectPath).toString("base64url");
      expect(projectKey).not.toBe(reservedKey);
    }
  });

  it("places global and project records under distinct directories", async () => {
    const storage = storageFor();

    const globalRecord = await storage.create(GLOBAL_SCOPE, draft());
    const projectRecord = await storage.create(PROJECT_SCOPE, draft());

    const globalDir = path.join(tempDir, "workflows", "global.shared");
    const projectDir = path.join(
      tempDir,
      "workflows",
      Buffer.from(PROJECT_PATH).toString("base64url"),
    );

    expect(globalDir).not.toBe(projectDir);
    expect(existsSync(path.join(globalDir, `${globalRecord.id}.json`))).toBe(
      true,
    );
    expect(existsSync(path.join(projectDir, `${projectRecord.id}.json`))).toBe(
      true,
    );
  });
});
