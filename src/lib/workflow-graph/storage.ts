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
import { validateAuthoredDefinition } from "./definition-validation";
import {
  assertDefinitionRecordSupported,
  assertNoLegacyWorkflowFields,
} from "./schema-cutover-guard";
import type { GraphWorkflowExecution } from "./schemas";
import {
  findChangedLockedRegion,
  regionLockedInstruction,
  regionLockedMessage,
  type LockedRegionMatch,
} from "./locked-regions";
import {
  WorkflowAssignmentReferenceError,
  createAssignmentReferenceChecker,
  type AssignmentReferenceChecker,
} from "./assignment-references";
import { locatePlanIssues } from "@/lib/workflows/plan-issue-locator";
import {
  workflowDefinitionFilePath,
  workflowScopeFromDirName,
  workflowScopeStorageDir,
} from "./storage-paths";

const logger = createLogger("workflow-storage");

export interface WorkflowStorageDeps {
  resolveConfigDir?: () => string;
  listActiveExecutions?(): Promise<ReadonlyMap<string, GraphWorkflowExecution>>;
  assignmentReferences?: AssignmentReferenceChecker;
}

export class WorkflowRegionLockedError extends Error {
  readonly code = "region_locked" as const;
  readonly instruction: string;

  constructor(
    readonly locked: LockedRegionMatch,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowRegionLockedError";
    this.instruction = regionLockedInstruction(locked);
  }

  get lockedPath(): string {
    return this.locked.lockedPath;
  }

  get sourceUri(): string {
    return this.locked.sourceUri;
  }
}

export class StaleWorkflowDefinitionError extends Error {
  readonly code = "stale_workflow_definition" as const;

  constructor(
    readonly workflowId: string,
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `Workflow "${workflowId}" is at revision ${currentRevision}; expected revision ${expectedRevision}.`,
    );
    this.name = "StaleWorkflowDefinitionError";
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

function readScopeDirs(configDir: string): Promise<string[]> {
  const root = path.join(configDir, "workflows");
  if (!existsSync(root)) return Promise.resolve([]);
  return readdir(root);
}

/**
 * The inverse of {@link getScopeStorageDir}. A name that does not round-trip
 * through the encoding was not written by this module — a stray file, an
 * editor artifact — and is skipped rather than decoded into an invented
 * project path.
 */
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
  const assignmentReferences =
    deps.assignmentReferences ?? createAssignmentReferenceChecker();

  /**
   * Reference existence and the tier-scope rule, checked against the SAME scope
   * the record is being written to — so a global template is held to the
   * global-document rule while a project definition may reach all three tiers.
   * Async, and therefore separate from the synchronous shape validation above.
   */
  async function assertResolvableAssignments(
    scope: WorkflowScope,
    definition: WorkflowSemanticDefinition,
  ): Promise<void> {
    const issues = locatePlanIssues(
      await assignmentReferences.checkDefinition(
        definition,
        scope,
        "definition",
      ),
      definition,
    );
    if (issues.length === 0) return;

    // Paths only — an issue message quotes authored assignment ids, which are
    // author content and stay out of the log for the same reason the shape
    // rejection above logs codes rather than values.
    logger.warn("workflow-storage.assignment-reference-rejected", {
      scope: scope.kind,
      paths: issues.map((issue) => issue.path),
    });
    throw new WorkflowAssignmentReferenceError(issues);
  }

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
    throw new WorkflowRegionLockedError(locked, regionLockedMessage(locked));
  }

  /**
   * Every scope that currently stores workflows.
   *
   * Exists so the base64url scope encoding stays private to this module: a
   * caller that has to sweep all scopes — the agent-profile deletion reference
   * reporter, which must find a global-tier profile's holders in every
   * project — asks for scopes rather than for directory names it would have to
   * decode itself.
   */
  async function listScopes(): Promise<WorkflowScope[]> {
    const names = await readScopeDirs(resolveConfigDir());
    return names
      .map(workflowScopeFromDirName)
      .filter((scope): scope is WorkflowScope => scope !== null);
  }

  async function list(
    scope: WorkflowScope,
  ): Promise<WorkflowDefinitionSummary[]> {
    return timed(
      logger,
      "workflow-storage.list",
      { scope: scope.kind },
      async () => {
        const dir = workflowScopeStorageDir(resolveConfigDir(), scope);
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
        const filePath = workflowDefinitionFilePath(
          resolveConfigDir(),
          scope,
          workflowId,
        );
        if (!existsSync(filePath)) {
          return null;
        }
        return readRecord(filePath);
      },
      (record) => ({ found: record !== null }),
    );
  }

  async function createWithId(
    scope: WorkflowScope,
    workflowId: string,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord> {
    assertNoLegacyWorkflowFields(
      draft.definition,
      "Workflow definition (save)",
    );
    assertValidDefinition(draft.definition);
    await assertResolvableAssignments(scope, draft.definition);

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

        const filePath = workflowDefinitionFilePath(
          resolveConfigDir(),
          scope,
          workflowId,
        );
        if (existsSync(filePath)) {
          throw new Error(`Workflow "${workflowId}" already exists`);
        }
        await atomicWriteJson(filePath, record);
        return record;
      },
    );
  }

  async function create(
    scope: WorkflowScope,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord> {
    return createWithId(scope, randomUUID(), draft);
  }

  async function update(
    scope: WorkflowScope,
    workflowId: string,
    expectedRevision: number,
    draft: WorkflowDefinitionDraft,
  ): Promise<WorkflowDefinitionRecord> {
    assertNoLegacyWorkflowFields(
      draft.definition,
      "Workflow definition (save)",
    );
    assertValidDefinition(draft.definition);
    await assertResolvableAssignments(scope, draft.definition);

    return timed(
      logger,
      "workflow-storage.update",
      { workflowId },
      async () => {
        const existing = await get(scope, workflowId);
        if (!existing) {
          throw new Error(`Workflow "${workflowId}" not found`);
        }
        if (existing.revision !== expectedRevision) {
          throw new StaleWorkflowDefinitionError(
            workflowId,
            expectedRevision,
            existing.revision,
          );
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

        const filePath = workflowDefinitionFilePath(
          resolveConfigDir(),
          scope,
          workflowId,
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
        const filePath = workflowDefinitionFilePath(
          resolveConfigDir(),
          scope,
          workflowId,
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
    listScopes,
    list,
    get,
    create,
    createWithId,
    update,
    delete: remove,
  };
}
