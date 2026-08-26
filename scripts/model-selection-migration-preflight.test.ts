import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  runModelSelectionMigrationPreflight,
  type ModelSelectionMigrationPreflightDeps,
} from "./model-selection-migration-preflight";

interface FakeDatabase {
  readonly path: string;
}

function deps(): ModelSelectionMigrationPreflightDeps<FakeDatabase> {
  return {
    openDatabase: vi.fn((databasePath) => ({ path: databasePath })),
    closeDatabase: vi.fn(),
    preflight: vi.fn(async () => ({
      configCount: 2,
      snapshotCount: 3,
      transcriptCount: 5,
      workflowCount: 7,
      contextArtifactCount: 11,
    })),
    writeOutput: vi.fn(),
  };
}

describe("model-selection migration preflight command", () => {
  it("opens the selected database read-only through its dependency and reports every affected holder count", async () => {
    const commandDeps = deps();
    const configDir = path.resolve("/tmp/cc-model-selection-preflight");

    await expect(
      runModelSelectionMigrationPreflight(
        ["--config-dir", configDir],
        commandDeps,
      ),
    ).resolves.toEqual({
      configCount: 2,
      snapshotCount: 3,
      transcriptCount: 5,
      workflowCount: 7,
      contextArtifactCount: 11,
    });

    expect(commandDeps.openDatabase).toHaveBeenCalledWith(
      path.join(configDir, "command-center.db"),
    );
    expect(commandDeps.preflight).toHaveBeenCalledWith(
      { path: path.join(configDir, "command-center.db") },
      configDir,
    );
    expect(commandDeps.writeOutput).toHaveBeenCalledWith(
      "Generalized model selection migration preflight passed: 2 configs, 3 snapshots, 5 transcripts, 7 workflows, 11 context artifacts.",
    );
    expect(commandDeps.closeDatabase).toHaveBeenCalledOnce();
  });

  it("requires an explicit config directory without opening a database", async () => {
    const commandDeps = deps();

    await expect(
      runModelSelectionMigrationPreflight([], commandDeps),
    ).rejects.toThrow(/--config-dir/);
    expect(commandDeps.openDatabase).not.toHaveBeenCalled();
  });

  it("closes the database when preflight refuses a holder", async () => {
    const commandDeps = deps();
    vi.mocked(commandDeps.preflight).mockRejectedValue(
      new Error("transcript line 4 is ambiguous"),
    );

    await expect(
      runModelSelectionMigrationPreflight(
        ["--config-dir", "/tmp/cc-refusal"],
        commandDeps,
      ),
    ).rejects.toThrow(/transcript line 4/);
    expect(commandDeps.closeDatabase).toHaveBeenCalledOnce();
    expect(commandDeps.writeOutput).not.toHaveBeenCalled();
  });
});
