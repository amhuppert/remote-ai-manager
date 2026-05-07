import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  GraphWorkflowVisualLayout,
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/types";
import { getConfigDirPath } from "../config";
import { validateWorkflowDefinition } from "./validation";
import {
  assertDefinitionRecordSupported,
  assertNoLegacyWorkflowFields,
} from "./schema-cutover-guard";

export interface WorkflowStorageDeps {
  resolveConfigDir?: () => string;
}

export interface WorkflowDefinitionDraft {
  name: string;
  description: string | null;
  definition: WorkflowSemanticDefinition;
  layout: GraphWorkflowVisualLayout;
}

export interface WorkflowDefinitionSummary {
  id: string;
  name: string;
  description: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

function getProjectStorageDir(configDir: string, projectPath: string): string {
  const projectKey = Buffer.from(projectPath).toString("base64url");
  return path.join(configDir, "workflows", projectKey);
}

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function writeJsonAtomically(
  filePath: string,
  value: unknown,
): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(value, null, 2), "utf-8");
  await rename(tmpPath, filePath);
}

async function readRecord(filePath: string): Promise<WorkflowDefinitionRecord> {
  const raw = await readFile(filePath, "utf-8");
  return assertDefinitionRecordSupported(JSON.parse(raw));
}

function assertValidDefinition(definition: WorkflowSemanticDefinition): void {
  const result = validateWorkflowDefinition(definition);
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.code).join(", "));
  }
}

export function createWorkflowStorageService(deps: WorkflowStorageDeps = {}) {
  const resolveConfigDir = deps.resolveConfigDir ?? getConfigDirPath;

  async function list(
    projectPath: string,
  ): Promise<WorkflowDefinitionSummary[]> {
    const dir = getProjectStorageDir(resolveConfigDir(), projectPath);
    if (!existsSync(dir)) {
      return [];
    }

    const entries = await readdir(dir);
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => readRecord(path.join(dir, entry))),
    );

    return records.map((record) => ({
      id: record.id,
      name: record.name,
      description: record.description,
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
  }

  async function get(
    projectPath: string,
    workflowId: string,
  ): Promise<WorkflowDefinitionRecord | null> {
    const filePath = path.join(
      getProjectStorageDir(resolveConfigDir(), projectPath),
      `${workflowId}.json`,
    );
    if (!existsSync(filePath)) {
      return null;
    }
    return readRecord(filePath);
  }

  async function create(
    projectPath: string,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord> {
    assertNoLegacyWorkflowFields(
      draft.definition,
      "Workflow definition (save)",
    );
    assertValidDefinition(draft.definition);

    const workflowId = randomUUID();
    const now = new Date().toISOString();
    const record: WorkflowDefinitionRecord = {
      id: workflowId,
      name: draft.name,
      description: draft.description,
      schemaVersion: 1,
      revision: 1,
      definition: draft.definition,
      layout: {
        ...draft.layout,
        workflowId,
      },
      createdAt: now,
      updatedAt: now,
    };

    const filePath = path.join(
      getProjectStorageDir(resolveConfigDir(), projectPath),
      `${workflowId}.json`,
    );
    await writeJsonAtomically(filePath, record);
    return record;
  }

  async function update(
    projectPath: string,
    workflowId: string,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord> {
    assertNoLegacyWorkflowFields(
      draft.definition,
      "Workflow definition (save)",
    );
    assertValidDefinition(draft.definition);

    const existing = await get(projectPath, workflowId);
    if (!existing) {
      throw new Error(`Workflow "${workflowId}" not found`);
    }

    const record: WorkflowDefinitionRecord = {
      ...existing,
      name: draft.name,
      description: draft.description,
      revision: existing.revision + 1,
      definition: draft.definition,
      layout: {
        ...draft.layout,
        workflowId,
      },
      updatedAt: new Date().toISOString(),
    };

    const filePath = path.join(
      getProjectStorageDir(resolveConfigDir(), projectPath),
      `${workflowId}.json`,
    );
    await writeJsonAtomically(filePath, record);
    return record;
  }

  async function remove(
    projectPath: string,
    workflowId: string,
  ): Promise<boolean> {
    const filePath = path.join(
      getProjectStorageDir(resolveConfigDir(), projectPath),
      `${workflowId}.json`,
    );
    if (!existsSync(filePath)) {
      return false;
    }
    await rm(filePath, { force: true });
    return true;
  }

  return {
    list,
    get,
    create,
    update,
    delete: remove,
  };
}
