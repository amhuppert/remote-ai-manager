#!/usr/bin/env bun

import { migrateConfiguredStateFile } from "../src/lib/state-agent-backend-migration";

function printSummary(summary: {
  conversationsScanned: number;
  conversationsUpdated: number;
  forksUpdated: number;
  legacyFieldsRemoved: number;
}): void {
  console.log(`  Conversations scanned: ${summary.conversationsScanned}`);
  console.log(`  Conversations updated: ${summary.conversationsUpdated}`);
  console.log(`  Fork metadata updated: ${summary.forksUpdated}`);
  console.log(`  Legacy fields removed: ${summary.legacyFieldsRemoved}`);
}

async function main(): Promise<void> {
  const result = await migrateConfiguredStateFile();

  console.log("State Agent Backend Migration\n");
  console.log(`State file: ${result.stateFilePath}`);

  if (result.status === "missing_state_file") {
    console.log("\nNo state file found. Nothing to migrate.");
    return;
  }

  if (result.status === "no_changes") {
    console.log("\nState file is already migrated. No backup was created.");
    printSummary(result.summary);
    return;
  }

  console.log(`\nBackup created: ${result.backupPath}`);
  console.log("Migration complete.");
  printSummary(result.summary);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Migration failed:", message);
  process.exit(1);
});
