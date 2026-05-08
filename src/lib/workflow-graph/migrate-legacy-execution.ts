export interface LegacyMigrationResult {
  upgradedRecord: Record<string, unknown>;
  repairedFields: string[];
  executionId: string | null;
}

export class LegacyExecutionMigrationError extends Error {
  constructor(
    message: string,
    public readonly rawRecord: unknown,
  ) {
    super(message);
    this.name = "LegacyExecutionMigrationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== null
  );
}

function objectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function needsLegacyMigration(raw: unknown): boolean {
  if (!objectLike(raw)) return false;
  return "activeContextId" in raw;
}

export function migrateLegacyExecution(
  rawRecord: unknown,
): LegacyMigrationResult {
  if (!isPlainObject(rawRecord)) {
    throw new LegacyExecutionMigrationError(
      "migrateLegacyExecution requires a plain-object record",
      rawRecord,
    );
  }

  const upgraded: Record<string, unknown> = { ...rawRecord };
  const repaired: string[] = [];

  if ("activeContextId" in upgraded) {
    delete upgraded.activeContextId;
    repaired.push("activeContextId");
  }

  if (upgraded.status !== "paused") {
    upgraded.status = "paused";
    repaired.push("status");
  }

  const existingActiveContextIds = upgraded.activeContextIds;
  const alreadyEmptyArray =
    Array.isArray(existingActiveContextIds) &&
    existingActiveContextIds.length === 0;
  if (!alreadyEmptyArray) {
    upgraded.activeContextIds = [];
    repaired.push("activeContextIds");
  }

  const contextStates = upgraded.contextStates;
  if (objectLike(contextStates)) {
    let resetCount = 0;
    const nextStates: Record<string, unknown> = { ...contextStates };
    for (const [key, value] of Object.entries(nextStates)) {
      if (objectLike(value) && value.status === "running") {
        nextStates[key] = { ...value, status: "ready" };
        resetCount += 1;
      }
    }
    if (resetCount > 0) {
      upgraded.contextStates = nextStates;
      repaired.push("contextStates.running");
    }
  }

  const executionId =
    typeof upgraded.id === "string" && upgraded.id.length > 0
      ? upgraded.id
      : null;

  return {
    upgradedRecord: upgraded,
    repairedFields: repaired,
    executionId,
  };
}
