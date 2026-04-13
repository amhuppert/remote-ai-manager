import { copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ManagerState } from "@/types";
import { readConfig } from "./config";
import { createLogger } from "./logging";
import { managerStateSchema } from "./schemas";

const logger = createLogger("state-agent-backend-migration");

const BACKUP_SUFFIX = "agent-backend-migration";

export interface StateAgentBackendMigrationSummary {
  conversationsScanned: number;
  conversationsUpdated: number;
  forksUpdated: number;
  legacyFieldsRemoved: number;
}

export interface LegacyStateAgentBackendTransformResult {
  changed: boolean;
  migratedState: ManagerState;
  summary: StateAgentBackendMigrationSummary;
}

export type StateAgentBackendMigrationResult =
  | {
      status: "missing_state_file";
      stateFilePath: string;
      backupPath: null;
      summary: StateAgentBackendMigrationSummary;
    }
  | {
      status: "no_changes";
      stateFilePath: string;
      backupPath: null;
      summary: StateAgentBackendMigrationSummary;
    }
  | {
      status: "migrated";
      stateFilePath: string;
      backupPath: string;
      summary: StateAgentBackendMigrationSummary;
    };

function createEmptySummary(): StateAgentBackendMigrationSummary {
  return {
    conversationsScanned: 0,
    conversationsUpdated: 0,
    forksUpdated: 0,
    legacyFieldsRemoved: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function buildAgentBackendMigrationBackupPath(
  stateFilePath: string,
  fileExists: (path: string) => boolean = existsSync,
): string {
  const basePath = `${stateFilePath}.${BACKUP_SUFFIX}`;
  const firstCandidate = `${basePath}.bak`;
  if (!fileExists(firstCandidate)) {
    return firstCandidate;
  }

  let index = 1;
  while (fileExists(`${basePath}.${index}.bak`)) {
    index += 1;
  }
  return `${basePath}.${index}.bak`;
}

function normalizeForkedFrom(
  forkedFrom: Record<string, unknown>,
  summary: StateAgentBackendMigrationSummary,
): boolean {
  let changed = false;
  const legacySourceClaudeSessionId = forkedFrom["sourceClaudeSessionId"];
  const legacyForkPointAssistantUuid = forkedFrom["forkPointAssistantUuid"];
  const existingSourceBackendRef = forkedFrom["sourceBackendRef"];

  if (
    !isRecord(existingSourceBackendRef) &&
    typeof legacySourceClaudeSessionId === "string" &&
    legacySourceClaudeSessionId.length > 0
  ) {
    forkedFrom["sourceBackendRef"] = {
      backend: "claude",
      sessionId: legacySourceClaudeSessionId,
    };
    changed = true;
  }

  const normalizedSourceBackendRef = forkedFrom["sourceBackendRef"];
  if (
    (forkedFrom["sourceBackend"] === undefined ||
      forkedFrom["sourceBackend"] === null) &&
    isRecord(normalizedSourceBackendRef) &&
    typeof normalizedSourceBackendRef["backend"] === "string"
  ) {
    forkedFrom["sourceBackend"] = normalizedSourceBackendRef["backend"];
    changed = true;
  }

  if (
    (forkedFrom["forkLocator"] === undefined ||
      forkedFrom["forkLocator"] === null) &&
    typeof legacyForkPointAssistantUuid === "string" &&
    legacyForkPointAssistantUuid.length > 0
  ) {
    forkedFrom["forkLocator"] = legacyForkPointAssistantUuid;
    changed = true;
  }

  if ("sourceClaudeSessionId" in forkedFrom) {
    delete forkedFrom["sourceClaudeSessionId"];
    summary.legacyFieldsRemoved += 1;
    changed = true;
  }

  if ("forkPointAssistantUuid" in forkedFrom) {
    delete forkedFrom["forkPointAssistantUuid"];
    summary.legacyFieldsRemoved += 1;
    changed = true;
  }

  if (changed) {
    summary.forksUpdated += 1;
  }

  return changed;
}

function normalizeConversation(
  conversation: Record<string, unknown>,
  summary: StateAgentBackendMigrationSummary,
): boolean {
  summary.conversationsScanned += 1;

  let changed = false;
  const legacyClaudeSessionId = conversation["claudeSessionId"];
  const existingBackendRef = conversation["backendRef"];

  if (
    !isRecord(existingBackendRef) &&
    typeof legacyClaudeSessionId === "string" &&
    legacyClaudeSessionId.length > 0
  ) {
    conversation["backendRef"] = {
      backend: "claude",
      sessionId: legacyClaudeSessionId,
    };
    changed = true;
  }

  if (!("backendRef" in conversation)) {
    conversation["backendRef"] = null;
    changed = true;
  }

  const normalizedBackendRef = conversation["backendRef"];
  if (
    conversation["agentBackend"] === undefined ||
    conversation["agentBackend"] === null
  ) {
    if (
      isRecord(normalizedBackendRef) &&
      typeof normalizedBackendRef["backend"] === "string"
    ) {
      conversation["agentBackend"] = normalizedBackendRef["backend"];
    } else {
      conversation["agentBackend"] = "claude";
    }
    changed = true;
  }

  if ("claudeSessionId" in conversation) {
    delete conversation["claudeSessionId"];
    summary.legacyFieldsRemoved += 1;
    changed = true;
  }

  const forkedFrom = conversation["forkedFrom"];
  if (isRecord(forkedFrom) && normalizeForkedFrom(forkedFrom, summary)) {
    changed = true;
  }

  if (changed) {
    summary.conversationsUpdated += 1;
  }

  return changed;
}

function formatValidationError(message: string): string {
  return `Migrated state failed schema validation: ${message}`;
}

export function migrateLegacyAgentBackendState(
  rawState: unknown,
): LegacyStateAgentBackendTransformResult {
  const summary = createEmptySummary();
  const state = structuredClone(rawState);
  let changed = false;

  const projects = isRecord(state) ? state["projects"] : undefined;
  if (isRecord(projects)) {
    for (const project of Object.values(projects)) {
      if (!isRecord(project)) continue;
      const sessions = project["sessions"];
      if (!isRecord(sessions)) continue;

      for (const session of Object.values(sessions)) {
        if (!isRecord(session)) continue;
        const conversations = session["conversations"];
        if (!Array.isArray(conversations)) continue;

        for (const conversation of conversations) {
          if (!isRecord(conversation)) continue;
          if (normalizeConversation(conversation, summary)) {
            changed = true;
          }
        }
      }
    }
  }

  const parsed = managerStateSchema.safeParse(state);
  if (!parsed.success) {
    throw new Error(
      formatValidationError(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      ),
    );
  }

  return {
    changed,
    migratedState: parsed.data,
    summary,
  };
}

export async function migrateStateFileWithBackup(
  stateFilePath: string,
): Promise<StateAgentBackendMigrationResult> {
  logger.info("state-agent-backend-migration.start", { stateFilePath });

  if (!existsSync(stateFilePath)) {
    logger.info("state-agent-backend-migration.missing_state_file", {
      stateFilePath,
    });
    return {
      status: "missing_state_file",
      stateFilePath,
      backupPath: null,
      summary: createEmptySummary(),
    };
  }

  const raw = await readFile(stateFilePath, "utf-8");
  const parsedRaw = JSON.parse(raw) as unknown;
  const transformed = migrateLegacyAgentBackendState(parsedRaw);

  if (!transformed.changed) {
    logger.info("state-agent-backend-migration.no_changes", {
      stateFilePath,
      conversationsScanned: transformed.summary.conversationsScanned,
    });
    return {
      status: "no_changes",
      stateFilePath,
      backupPath: null,
      summary: transformed.summary,
    };
  }

  const backupPath = buildAgentBackendMigrationBackupPath(stateFilePath);
  await copyFile(stateFilePath, backupPath);
  logger.info("state-agent-backend-migration.backup_created", {
    stateFilePath,
    backupPath,
  });

  await writeFile(
    stateFilePath,
    JSON.stringify(transformed.migratedState, null, 2),
    "utf-8",
  );

  logger.info("state-agent-backend-migration.complete", {
    stateFilePath,
    backupPath,
    ...transformed.summary,
  });

  return {
    status: "migrated",
    stateFilePath,
    backupPath,
    summary: transformed.summary,
  };
}

export async function migrateConfiguredStateFile(): Promise<StateAgentBackendMigrationResult> {
  const config = await readConfig();
  return migrateStateFileWithBackup(config.stateFilePath);
}
