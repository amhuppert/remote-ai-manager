import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GlobalConfig, ManagerState } from "@/types";
import { readConfig } from "@/lib/config";
import { createLogger } from "@/lib/logging";
import { managerStateSchema } from "@/lib/schemas";

const logger = createLogger("graph-workflow-context-validator-cutover");

const BACKUP_SUFFIX = "graph-workflow-context-validator-cutover";
const MARKER_FILE_NAME = "graph-workflow-context-validator-cutover.json";

export interface GraphWorkflowContextValidatorCutoverSummary {
  sessionsScanned: number;
  sessionsCleared: number;
  activeExecutionsCleared: number;
  archivedExecutionsCleared: number;
}

export type GraphWorkflowContextValidatorCutoverResult =
  | {
      status: "already_ran";
      markerPath: string;
      stateFilePath: string;
      stateBackupPath: null;
      workflowDefinitionsBackupPath: null;
      summary: GraphWorkflowContextValidatorCutoverSummary;
    }
  | {
      status: "completed";
      markerPath: string;
      stateFilePath: string;
      stateBackupPath: string | null;
      workflowDefinitionsBackupPath: string | null;
      summary: GraphWorkflowContextValidatorCutoverSummary;
    };

export interface GraphWorkflowContextValidatorCutoverDeps {
  readConfig(): Promise<GlobalConfig>;
}

function createEmptySummary(): GraphWorkflowContextValidatorCutoverSummary {
  return {
    sessionsScanned: 0,
    sessionsCleared: 0,
    activeExecutionsCleared: 0,
    archivedExecutionsCleared: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function buildGraphWorkflowCutoverBackupPath(
  stateFilePath: string,
): string {
  const basePath = `${stateFilePath}.${BACKUP_SUFFIX}`;
  const firstCandidate = `${basePath}.bak`;
  if (!existsSync(firstCandidate)) {
    return firstCandidate;
  }

  let index = 1;
  while (existsSync(`${basePath}.${index}.bak`)) {
    index += 1;
  }
  return `${basePath}.${index}.bak`;
}

function buildWorkflowDefinitionsArchivePath(workflowsDir: string): string {
  const firstCandidate = `${workflowsDir}.${BACKUP_SUFFIX}.bak`;
  if (!existsSync(firstCandidate)) {
    return firstCandidate;
  }

  let index = 1;
  while (existsSync(`${workflowsDir}.${BACKUP_SUFFIX}.${index}.bak`)) {
    index += 1;
  }
  return `${workflowsDir}.${BACKUP_SUFFIX}.${index}.bak`;
}

function clearPersistedGraphWorkflowState(rawState: unknown): {
  rewrittenState: ManagerState;
  summary: GraphWorkflowContextValidatorCutoverSummary;
} {
  const state = structuredClone(rawState);
  const summary = createEmptySummary();
  const projects = isRecord(state) ? state["projects"] : undefined;

  if (isRecord(projects)) {
    for (const project of Object.values(projects)) {
      if (!isRecord(project)) {
        continue;
      }
      const sessions = project["sessions"];
      if (!isRecord(sessions)) {
        continue;
      }

      for (const session of Object.values(sessions)) {
        if (!isRecord(session)) {
          continue;
        }

        summary.sessionsScanned += 1;

        const hadActiveExecution = session["graphWorkflowExecution"] != null;
        const archivedHistory = Array.isArray(
          session["graphWorkflowExecutionHistory"],
        )
          ? session["graphWorkflowExecutionHistory"]
          : [];

        if (hadActiveExecution) {
          summary.activeExecutionsCleared += 1;
        }
        if (archivedHistory.length > 0) {
          summary.archivedExecutionsCleared += archivedHistory.length;
        }
        if (hadActiveExecution || archivedHistory.length > 0) {
          summary.sessionsCleared += 1;
        }

        session["graphWorkflowExecution"] = null;
        session["graphWorkflowExecutionHistory"] = [];
      }
    }
  }

  const parsed = managerStateSchema.safeParse(state);
  if (!parsed.success) {
    throw new Error(
      `Cutover state failed schema validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  return {
    rewrittenState: parsed.data,
    summary,
  };
}

async function ensureDir(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }
}

async function writeMarkerFile(
  markerPath: string,
  result: {
    stateFilePath: string;
    stateBackupPath: string | null;
    workflowDefinitionsBackupPath: string | null;
    summary: GraphWorkflowContextValidatorCutoverSummary;
  },
): Promise<void> {
  await writeFile(
    markerPath,
    JSON.stringify(
      {
        appliedAt: new Date().toISOString(),
        ...result,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

export function createGraphWorkflowContextValidatorCutoverRunner(
  deps: GraphWorkflowContextValidatorCutoverDeps,
): () => Promise<GraphWorkflowContextValidatorCutoverResult> {
  return async () => {
    const config = await deps.readConfig();
    const stateFilePath = config.stateFilePath;
    const configDir = path.dirname(stateFilePath);
    const markerPath = path.join(configDir, MARKER_FILE_NAME);
    const workflowsDir = path.join(configDir, "workflows");

    logger.info("graph-workflow-cutover.start", {
      stateFilePath,
      markerPath,
      workflowsDir,
    });

    if (existsSync(markerPath)) {
      logger.info("graph-workflow-cutover.already_ran", {
        stateFilePath,
        markerPath,
      });
      return {
        status: "already_ran",
        markerPath,
        stateFilePath,
        stateBackupPath: null,
        workflowDefinitionsBackupPath: null,
        summary: createEmptySummary(),
      };
    }

    await ensureDir(configDir);

    let summary = createEmptySummary();
    let stateBackupPath: string | null = null;
    let workflowDefinitionsBackupPath: string | null = null;

    if (existsSync(stateFilePath)) {
      const raw = await readFile(stateFilePath, "utf-8");
      const parsedRaw = JSON.parse(raw) as unknown;
      const transformed = clearPersistedGraphWorkflowState(parsedRaw);

      summary = transformed.summary;
      stateBackupPath = buildGraphWorkflowCutoverBackupPath(stateFilePath);
      await copyFile(stateFilePath, stateBackupPath);
      await writeFile(
        stateFilePath,
        JSON.stringify(transformed.rewrittenState, null, 2),
        "utf-8",
      );

      logger.info("graph-workflow-cutover.backup_created", {
        stateFilePath,
        stateBackupPath,
        ...summary,
      });
    }

    if (existsSync(workflowsDir)) {
      workflowDefinitionsBackupPath =
        buildWorkflowDefinitionsArchivePath(workflowsDir);
      await rename(workflowsDir, workflowDefinitionsBackupPath);

      logger.info("graph-workflow-cutover.workflow_storage_archived", {
        workflowsDir,
        workflowDefinitionsBackupPath,
      });
    }

    await writeMarkerFile(markerPath, {
      stateFilePath,
      stateBackupPath,
      workflowDefinitionsBackupPath,
      summary,
    });

    logger.info("graph-workflow-cutover.complete", {
      stateFilePath,
      markerPath,
      stateBackupPath,
      workflowDefinitionsBackupPath,
      ...summary,
    });

    return {
      status: "completed",
      markerPath,
      stateFilePath,
      stateBackupPath,
      workflowDefinitionsBackupPath,
      summary,
    };
  };
}

const runGraphWorkflowContextValidatorCutoverImpl =
  createGraphWorkflowContextValidatorCutoverRunner({ readConfig });

export async function runGraphWorkflowContextValidatorCutover(): Promise<GraphWorkflowContextValidatorCutoverResult> {
  return runGraphWorkflowContextValidatorCutoverImpl();
}
