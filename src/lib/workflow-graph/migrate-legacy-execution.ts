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

function isFlatLaneStates(laneStates: Record<string, unknown>): boolean {
  for (const value of Object.values(laneStates)) {
    if (
      objectLike(value) &&
      typeof (value as Record<string, unknown>).engine === "string"
    ) {
      return true;
    }
  }
  return false;
}

export function needsLegacyMigration(raw: unknown): boolean {
  if (!objectLike(raw)) return false;
  if ("activeContextId" in raw) return true;
  const laneStates = (raw as Record<string, unknown>).laneStates;
  if (
    objectLike(laneStates) &&
    isFlatLaneStates(laneStates as Record<string, unknown>)
  ) {
    return true;
  }
  return false;
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

  const laneStates = upgraded.laneStates;
  if (
    objectLike(laneStates) &&
    isFlatLaneStates(laneStates as Record<string, unknown>)
  ) {
    const flat = laneStates as Record<string, unknown>;
    const nested: Record<string, Record<string, unknown>> = {};
    for (const [lane, value] of Object.entries(flat)) {
      if (!objectLike(value)) continue;
      const contextId = (value as Record<string, unknown>).contextId;
      if (typeof contextId !== "string" || contextId.length === 0) continue;
      const bucket = nested[contextId] ?? {};
      bucket[lane] = value;
      nested[contextId] = bucket;
    }
    upgraded.laneStates = nested;
    repaired.push("laneStates");
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
