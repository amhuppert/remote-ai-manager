import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { createLogger } from "@/lib/logging";
import { atomicWriteJson } from "@/lib/shared/atomic-write-json";
import { getErrorMessage } from "@/lib/shared/errors";
import { repoValidationConfigSchema } from "@/lib/validation/schemas";
import { stableStringify } from "../serialization";
import type { StateMigration } from "./types";

type Db = InstanceType<typeof Database>;

const MIGRATION_NAME = "0013-script-validator-commands";
const PRE_MERGE_COMMAND = "pre-merge";
const GLOBAL_SCOPE_KEY = "global.shared";
const logger = createLogger("state-store/migrations");

interface JsonFilePlan {
  filePath: string;
  value: Record<string, unknown>;
  changed: boolean;
}

interface StoredDefinitionPlan extends JsonFilePlan {
  projectPath: string | null;
  preMergeSelections: string[];
}

interface ActiveExecutionPlan {
  rowid: number;
  before: string;
  after: string;
}

interface ArchivedExecutionPlan {
  rowid: number;
  before: string;
  after: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseJsonRecord(
  raw: string,
  locator: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${locator}: invalid JSON: ${getErrorMessage(err)}`);
  }
  const record = asRecord(parsed);
  if (record === null) {
    throw new Error(`${locator}: expected a JSON object`);
  }
  return record;
}

function migrateScriptValidatorBlock(
  parent: Record<string, unknown>,
  field: string,
  locator: string,
  required: boolean,
): boolean {
  const existing = parent[field];
  if (existing === undefined) {
    if (!required) return false;
    parent[field] = { commands: [] };
    return true;
  }

  const block = asRecord(existing);
  if (block === null) return false;

  if (!("enabled" in block)) {
    if ("commands" in block) return false;
    block.commands = [];
    return true;
  }

  if (typeof block.enabled !== "boolean") {
    throw new Error(`${locator}.enabled: expected a boolean`);
  }
  block.commands = block.enabled ? [PRE_MERGE_COMMAND] : [];
  delete block.enabled;
  return true;
}

function migrateDefinition(
  definition: Record<string, unknown>,
  locatorPrefix: string,
  resolved: boolean,
): boolean {
  let changed = false;
  if (!resolved) {
    const workflowConfig = asRecord(definition.workflowConfig);
    if (workflowConfig !== null) {
      changed =
        migrateScriptValidatorBlock(
          workflowConfig,
          "scriptValidator",
          `${locatorPrefix}.workflowConfig.scriptValidator`,
          false,
        ) || changed;
    }
  }

  if (!Array.isArray(definition.executionContexts)) return changed;
  definition.executionContexts.forEach((candidate, index) => {
    const context = asRecord(candidate);
    if (context === null) return;
    changed =
      migrateScriptValidatorBlock(
        context,
        "scriptValidator",
        `${locatorPrefix}.executionContexts.${index}.scriptValidator`,
        resolved,
      ) || changed;
  });
  return changed;
}

function commandsFrom(parent: Record<string, unknown> | null): string[] | null {
  const scriptValidator = asRecord(parent?.scriptValidator);
  if (!Array.isArray(scriptValidator?.commands)) return null;
  return scriptValidator.commands.filter(
    (command): command is string => typeof command === "string",
  );
}

function collectPreMergeSelections(
  definition: Record<string, unknown>,
  globalCommands: readonly string[],
): string[] {
  const workflowConfig = asRecord(definition.workflowConfig);
  const workflowCommands = commandsFrom(workflowConfig);
  if (!Array.isArray(definition.executionContexts)) return [];

  const selections: string[] = [];
  definition.executionContexts.forEach((candidate, index) => {
    const context = asRecord(candidate);
    if (context === null) return;
    const effective = commandsFrom(context) ??
      workflowCommands ?? [...globalCommands];
    if (effective.includes(PRE_MERGE_COMMAND)) {
      selections.push(`definition.executionContexts.${index}.scriptValidator`);
    }
  });
  return selections;
}

function decodeProjectScopeKey(scopeKey: string, locator: string): string {
  let decoded: string;
  try {
    decoded = Buffer.from(scopeKey, "base64url").toString("utf-8");
  } catch (err) {
    throw new Error(
      `${locator}: invalid project workflow scope: ${getErrorMessage(err)}`,
    );
  }
  if (Buffer.from(decoded).toString("base64url") !== scopeKey) {
    throw new Error(`${locator}: invalid project workflow scope key`);
  }
  return decoded;
}

async function readOptionalJsonRecord(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    return parseJsonRecord(await readFile(filePath, "utf-8"), filePath);
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

async function planGlobalConfig(
  configDir: string,
): Promise<{ plan: JsonFilePlan | null; commands: string[] }> {
  const filePath = path.join(configDir, "config.json");
  const value = await readOptionalJsonRecord(filePath);
  if (value === null) return { plan: null, commands: [] };

  const workflowDefaults = asRecord(value.workflowDefaults);
  const changed =
    workflowDefaults === null
      ? false
      : migrateScriptValidatorBlock(
          workflowDefaults,
          "scriptValidator",
          `${filePath}: workflowDefaults.scriptValidator`,
          false,
        );
  return {
    plan: { filePath, value, changed },
    commands: commandsFrom(workflowDefaults) ?? [],
  };
}

async function planStoredDefinitions(
  configDir: string,
  globalCommands: readonly string[],
): Promise<StoredDefinitionPlan[]> {
  const workflowsRoot = path.join(configDir, "workflows");
  let scopes;
  try {
    scopes = await readdir(workflowsRoot, { withFileTypes: true });
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      return [];
    }
    throw err;
  }

  const plans: StoredDefinitionPlan[] = [];
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    const scopeDir = path.join(workflowsRoot, scope.name);
    const projectPath =
      scope.name === GLOBAL_SCOPE_KEY
        ? null
        : decodeProjectScopeKey(scope.name, scopeDir);
    const entries = await readdir(scopeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(scopeDir, entry.name);
      const value = parseJsonRecord(
        await readFile(filePath, "utf-8"),
        filePath,
      );
      const definition = asRecord(value.definition);
      if (definition === null) continue;
      const changed = migrateDefinition(
        definition,
        `${filePath}: definition`,
        false,
      );
      plans.push({
        filePath,
        value,
        changed,
        projectPath,
        preMergeSelections:
          projectPath === null
            ? []
            : collectPreMergeSelections(definition, globalCommands),
      });
    }
  }
  return plans;
}

function hasRegisteredPreMerge(config: Record<string, unknown>): boolean {
  const result = repoValidationConfigSchema.safeParse(config.validation);
  return (
    result.success && result.data.commands[PRE_MERGE_COMMAND] !== undefined
  );
}

async function preflightStoredDefinitions(
  plans: readonly StoredDefinitionPlan[],
): Promise<void> {
  const configByProject = new Map<string, Record<string, unknown> | null>();
  const issues: string[] = [];
  for (const plan of plans) {
    if (plan.projectPath === null || plan.preMergeSelections.length === 0) {
      continue;
    }
    let config = configByProject.get(plan.projectPath);
    if (config === undefined) {
      config = await readOptionalJsonRecord(
        path.join(plan.projectPath, "CommandCenter.json"),
      );
      configByProject.set(plan.projectPath, config);
    }
    if (config !== null && hasRegisteredPreMerge(config)) continue;
    const configPath = path.join(plan.projectPath, "CommandCenter.json");
    for (const selection of plan.preMergeSelections) {
      issues.push(
        `${plan.filePath}: ${selection}: selects "${PRE_MERGE_COMMAND}", but ${configPath}: register validation.commands.pre-merge`,
      );
    }
  }
  if (issues.length > 0) {
    throw new Error(
      `Script-validator command migration preflight failed:\n${issues.join("\n")}`,
    );
  }
}

function planActiveExecutions(db: Db): ActiveExecutionPlan[] {
  const rows = db
    .prepare(`SELECT rowid, definition_json FROM graph_workflow_executions`)
    .all() as Array<{ rowid: number; definition_json: string }>;
  return rows.flatMap((row) => {
    const value = parseJsonRecord(
      row.definition_json,
      `graph_workflow_executions.rowid=${row.rowid}.definition_json`,
    );
    const definition = asRecord(value.workingDefinition);
    if (
      definition === null ||
      !migrateDefinition(
        definition,
        `graph_workflow_executions.rowid=${row.rowid}.definition_json.workingDefinition`,
        true,
      )
    ) {
      return [];
    }
    return [
      {
        rowid: row.rowid,
        before: row.definition_json,
        after: stableStringify(value),
      },
    ];
  });
}

function planArchivedExecutions(db: Db): ArchivedExecutionPlan[] {
  const rows = db
    .prepare(
      `SELECT rowid, execution_json FROM graph_workflow_archived_executions`,
    )
    .all() as Array<{ rowid: number; execution_json: string }>;
  return rows.flatMap((row) => {
    const value = parseJsonRecord(
      row.execution_json,
      `graph_workflow_archived_executions.rowid=${row.rowid}.execution_json`,
    );
    const definition = asRecord(value.workingDefinition);
    if (
      definition === null ||
      !migrateDefinition(
        definition,
        `graph_workflow_archived_executions.rowid=${row.rowid}.execution_json.workingDefinition`,
        true,
      )
    ) {
      return [];
    }
    return [
      {
        rowid: row.rowid,
        before: row.execution_json,
        after: stableStringify(value),
      },
    ];
  });
}

function applyExecutionPlans(
  db: Db,
  active: readonly ActiveExecutionPlan[],
  archived: readonly ArchivedExecutionPlan[],
): void {
  const updateActive = db.prepare(
    `UPDATE graph_workflow_executions
        SET definition_json = ?
      WHERE rowid = ? AND definition_json = ?`,
  );
  const updateArchived = db.prepare(
    `UPDATE graph_workflow_archived_executions
        SET execution_json = ?
      WHERE rowid = ? AND execution_json = ?`,
  );
  db.transaction(() => {
    for (const plan of active) {
      updateActive.run(plan.after, plan.rowid, plan.before);
    }
    for (const plan of archived) {
      updateArchived.run(plan.after, plan.rowid, plan.before);
    }
  }).immediate();
}

export const scriptValidatorCommands: StateMigration = {
  name: MIGRATION_NAME,
  async up({ context }) {
    const globalPlan =
      context.configDir === null
        ? { plan: null, commands: [] }
        : await planGlobalConfig(context.configDir);
    const storedPlans =
      context.configDir === null
        ? []
        : await planStoredDefinitions(context.configDir, globalPlan.commands);
    await preflightStoredDefinitions(storedPlans);

    const activePlans = planActiveExecutions(context.db);
    const archivedPlans = planArchivedExecutions(context.db);

    if (globalPlan.plan?.changed) {
      await atomicWriteJson(globalPlan.plan.filePath, globalPlan.plan.value);
    }
    for (const plan of storedPlans) {
      if (plan.changed) await atomicWriteJson(plan.filePath, plan.value);
    }
    applyExecutionPlans(context.db, activePlans, archivedPlans);

    logger.info("state-store.migration_script_validator_commands", {
      migration: MIGRATION_NAME,
      globalConfigChanged: globalPlan.plan?.changed ?? false,
      storedDefinitionsChanged: storedPlans.filter((plan) => plan.changed)
        .length,
      activeExecutionsChanged: activePlans.length,
      archivedExecutionsChanged: archivedPlans.length,
    });
  },
};
