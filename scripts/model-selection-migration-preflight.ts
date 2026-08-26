import path from "node:path";

import Database from "better-sqlite3";

import {
  preflightGeneralizedModelSelection,
  type GeneralizedModelSelectionPreflightCounts,
} from "../src/lib/state-store/migrations/0035-generalized-model-selection";

export type ModelSelectionMigrationPreflightCounts =
  GeneralizedModelSelectionPreflightCounts;

export interface ModelSelectionMigrationPreflightDeps<DatabaseHandle> {
  openDatabase(databasePath: string): DatabaseHandle;
  closeDatabase(database: DatabaseHandle): void;
  preflight(
    database: DatabaseHandle,
    configDir: string,
  ): Promise<ModelSelectionMigrationPreflightCounts>;
  writeOutput(message: string): void;
}

export async function runModelSelectionMigrationPreflight<DatabaseHandle>(
  args: readonly string[],
  deps: ModelSelectionMigrationPreflightDeps<DatabaseHandle>,
): Promise<ModelSelectionMigrationPreflightCounts> {
  const configDirArg = args[1];
  if (
    args.length !== 2 ||
    args[0] !== "--config-dir" ||
    configDirArg === undefined ||
    configDirArg.trim().length === 0
  ) {
    throw new Error(
      "Usage: bun scripts/model-selection-migration-preflight.ts --config-dir <path>",
    );
  }

  const configDir = path.resolve(configDirArg);
  const database = deps.openDatabase(path.join(configDir, "command-center.db"));
  try {
    const counts = await deps.preflight(database, configDir);
    deps.writeOutput(
      `Generalized model selection migration preflight passed: ${[
        plural(counts.configCount, "config"),
        plural(counts.snapshotCount, "snapshot"),
        plural(counts.transcriptCount, "transcript"),
        plural(counts.workflowCount, "workflow"),
        plural(counts.contextArtifactCount, "context artifact"),
      ].join(", ")}.`,
    );
    return counts;
  } finally {
    deps.closeDatabase(database);
  }
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function productionDeps(): ModelSelectionMigrationPreflightDeps<
  InstanceType<typeof Database>
> {
  return {
    openDatabase(databasePath) {
      return new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
      });
    },
    closeDatabase(database) {
      database.close();
    },
    preflight(database, configDir) {
      return preflightGeneralizedModelSelection({ db: database, configDir });
    },
    writeOutput(message) {
      console.log(message);
    },
  };
}

if (import.meta.main) {
  runModelSelectionMigrationPreflight(
    process.argv.slice(2),
    productionDeps(),
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Generalized model selection preflight failed: ${message}`);
    process.exitCode = 1;
  });
}
