import { readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJson } from "@/lib/shared/atomic-write-json";
import type {
  GraphWorkflowVisualLayout,
  ParameterDeclaration,
  WorkflowDefinitionRecord,
  WorkflowPrerequisite,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { getConfigDirPath } from "../config/loader";
import { createLogger } from "../logging";
import { timed } from "../logging/timed";
import { validateAuthoredDefinition } from "./validation";
import {
  assertDefinitionRecordSupported,
  assertNoLegacyWorkflowFields,
} from "./schema-cutover-guard";
import type { GraphWorkflowExecution } from "./schemas";
import {
  findChangedLockedRegion,
  regionLockedInstruction,
  regionLockedMessage,
} from "./locked-regions";

const logger = createLogger("workflow-storage");

export interface WorkflowStorageDeps {
  resolveConfigDir?: () => string;
  listActiveExecutions?(): Promise<ReadonlyMap<string, GraphWorkflowExecution>>;
}

export class WorkflowRegionLockedError extends Error {
  readonly code = "region_locked" as const;
  readonly instruction: string;

  constructor(
    readonly lockedPath: string,
    readonly sourceUri: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowRegionLockedError";
    this.instruction = regionLockedInstruction(sourceUri);
  }
}

/**
 * Storage scope discriminator. A `project` scope keys storage by an opaque
 * project path; the `global` scope is a single cross-project tier shared by
 * every project.
 */
export type WorkflowScope =
  | { kind: "project"; projectPath: string }
  | { kind: "global" };

/**
 * Reserved directory key for the global tier. It contains a `.` — a character
 * outside the base64url alphabet (`A–Za–z0–9-_`) — so it can never equal
 * `base64url(projectPath)` for any project path. This makes a collision with a
 * per-project key structurally impossible, with no runtime guard required.
 */
const GLOBAL_SCOPE_KEY = "global.shared";

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
  // Surfaced from the underlying definition so a launcher (UI/agent) can build a
  // parameterized, prerequisite-aware launch from a single list call — no N+1
  // per-item fetch. Populated in `list` from the already-read record.
  parameters: ParameterDeclaration[];
  prerequisites: WorkflowPrerequisite[];
}

function getScopeStorageDir(configDir: string, scope: WorkflowScope): string {
  const scopeKey =
    scope.kind === "global"
      ? GLOBAL_SCOPE_KEY
      : Buffer.from(scope.projectPath).toString("base64url");
  return path.join(configDir, "workflows", scopeKey);
}

async function readRecord(filePath: string): Promise<WorkflowDefinitionRecord> {
  const raw = await readFile(filePath, "utf-8");
  return assertDefinitionRecordSupported(JSON.parse(raw));
}

function assertValidDefinition(definition: WorkflowSemanticDefinition): void {
  const result = validateAuthoredDefinition(definition);
  if (!result.ok) {
    const codes = result.errors.map((error) => error.code);
    // Log rejection codes only — never the offending field values — to keep
    // authored content (and any inadvertent secrets in it) out of logs.
    logger.warn("workflow-storage.accept-time-rejected", { codes });
    throw new Error(codes.join(", "));
  }
}

export function createWorkflowStorageService(deps: WorkflowStorageDeps = {}) {
  const resolveConfigDir = deps.resolveConfigDir ?? getConfigDirPath;

  async function listActiveExecutions(): Promise<
    ReadonlyMap<string, GraphWorkflowExecution>
  > {
    if (deps.listActiveExecutions) {
      return deps.listActiveExecutions();
    }
    const stateStore = await import("@/lib/state-store");
    return stateStore.listActiveGraphWorkflowExecutions();
  }

  async function assertLockedReplaceAllowed(
    scope: WorkflowScope,
    existing: WorkflowDefinitionRecord,
    next: WorkflowSemanticDefinition,
  ): Promise<void> {
    const locked = findChangedLockedRegion(existing.definition, next);
    if (!locked) return;

    const activeExecutions = await listActiveExecutions();
    const hasSeededExecution = Array.from(activeExecutions.entries()).some(
      ([sessionKey, execution]) => {
        if (execution.seedDefinitionId !== existing.id) return false;
        if (scope.kind === "global") return true;
        const separatorIndex = sessionKey.indexOf("\0");
        const executionProjectPath =
          separatorIndex === -1
            ? sessionKey
            : sessionKey.slice(0, separatorIndex);
        return executionProjectPath === scope.projectPath;
      },
    );
    if (!hasSeededExecution) return;

    logger.warn("workflow-storage.region_locked", {
      workflowId: existing.id,
      lockedPath: locked.lockedPath,
      sourceUri: locked.sourceUri,
      scope: scope.kind,
    });
    throw new WorkflowRegionLockedError(
      locked.lockedPath,
      locked.sourceUri,
      regionLockedMessage(locked),
    );
  }

  async function list(
    scope: WorkflowScope,
  ): Promise<WorkflowDefinitionSummary[]> {
    return timed(
      logger,
      "workflow-storage.list",
      { scope: scope.kind },
      async () => {
        const dir = getScopeStorageDir(resolveConfigDir(), scope);
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
          parameters: record.definition.parameters,
          prerequisites: record.definition.prerequisites,
        }));
      },
      (summaries) => ({ workflowCount: summaries.length }),
    );
  }

  async function get(
    scope: WorkflowScope,
    workflowId: string,
  ): Promise<WorkflowDefinitionRecord | null> {
    return timed(
      logger,
      "workflow-storage.get",
      { workflowId },
      async () => {
        const filePath = path.join(
          getScopeStorageDir(resolveConfigDir(), scope),
          `${workflowId}.json`,
        );
        if (!existsSync(filePath)) {
          return null;
        }
        return readRecord(filePath);
      },
      (record) => ({ found: record !== null }),
    );
  }

  async function create(
    scope: WorkflowScope,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord> {
    assertNoLegacyWorkflowFields(
      draft.definition,
      "Workflow definition (save)",
    );
    assertValidDefinition(draft.definition);

    const workflowId = randomUUID();

    return timed(
      logger,
      "workflow-storage.create",
      { workflowId },
      async () => {
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
          getScopeStorageDir(resolveConfigDir(), scope),
          `${workflowId}.json`,
        );
        await atomicWriteJson(filePath, record);
        return record;
      },
    );
  }

  async function update(
    scope: WorkflowScope,
    workflowId: string,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord> {
    assertNoLegacyWorkflowFields(
      draft.definition,
      "Workflow definition (save)",
    );
    assertValidDefinition(draft.definition);

    return timed(
      logger,
      "workflow-storage.update",
      { workflowId },
      async () => {
        const existing = await get(scope, workflowId);
        if (!existing) {
          throw new Error(`Workflow "${workflowId}" not found`);
        }

        await assertLockedReplaceAllowed(scope, existing, draft.definition);

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
          getScopeStorageDir(resolveConfigDir(), scope),
          `${workflowId}.json`,
        );
        await atomicWriteJson(filePath, record);
        return record;
      },
      (record) => ({ revision: record.revision }),
    );
  }

  async function remove(
    scope: WorkflowScope,
    workflowId: string,
  ): Promise<boolean> {
    return timed(
      logger,
      "workflow-storage.delete",
      { workflowId },
      async () => {
        const filePath = path.join(
          getScopeStorageDir(resolveConfigDir(), scope),
          `${workflowId}.json`,
        );
        if (!existsSync(filePath)) {
          return false;
        }
        await rm(filePath, { force: true });
        return true;
      },
      (deleted) => ({ deleted }),
    );
  }

  return {
    list,
    get,
    create,
    update,
    delete: remove,
  };
}
