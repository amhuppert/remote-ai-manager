import { z } from "zod";
import { getStateDb } from "../state-store/store";
import { createLogger } from "../logging";
import { timedSync } from "../logging/timed";
import { PersistenceError } from "../shared/errors";
import { parseTrusted, registerTrustedSchema } from "../shared/parse-trusted";
import { mergeIntentSchema } from "./schemas";
import type { MergeIntent, MergeIntentSource } from "./schemas";

const logger = createLogger("state-store.merge-intents");

const mergeIntentRowSchema = registerTrustedSchema(
  z.object({
    project_path: z.string(),
    commit_sha: z.string(),
    intent: z.string(),
    source: z.string(),
    created_at: z.string(),
  }),
  "mergeIntentRowSchema",
);

function logAndThrowValidationFailure(
  identifier: string | undefined,
  issues: unknown,
): never {
  const payload: Record<string, unknown> = { issues };
  if (identifier !== undefined) payload.identifier = identifier;
  logger.error("state-store.merge-intents.schema_validation_failure", payload);
  throw new PersistenceError({
    kind: "validation",
    entity: "merge_intent",
    ...(identifier !== undefined ? { identifier } : {}),
    issues,
  });
}

function parseMergeIntentOrFail(
  candidate: unknown,
  identifier: string,
): MergeIntent {
  const result = mergeIntentSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowValidationFailure(identifier, result.error.issues);
  }
  return result.data;
}

function rowToMergeIntent(rawRow: unknown): MergeIntent {
  const row = parseTrusted(mergeIntentRowSchema, rawRow, (issues) =>
    logAndThrowValidationFailure(undefined, issues),
  );
  return parseTrusted(
    mergeIntentSchema,
    {
      projectPath: row.project_path,
      commitSha: row.commit_sha,
      intent: row.intent,
      source: row.source,
      createdAt: row.created_at,
    },
    (issues) => logAndThrowValidationFailure(row.commit_sha, issues),
  );
}

export interface RecordMergeIntentInput {
  projectPath: string;
  commitSha: string;
  intent: string;
  source: MergeIntentSource;
}

export function recordMergeIntent(input: RecordMergeIntentInput): void {
  timedSync(
    logger,
    "state-db.recordMergeIntent",
    { commitSha: input.commitSha, source: input.source },
    () => {
      const validated = parseMergeIntentOrFail(
        { ...input, createdAt: new Date().toISOString() },
        input.commitSha,
      );
      const db = getStateDb();
      db.prepare(
        `INSERT OR REPLACE INTO merge_intents (project_path, commit_sha, intent, source, created_at)
     VALUES (?, ?, ?, ?, ?)`,
      ).run(
        validated.projectPath,
        validated.commitSha,
        validated.intent,
        validated.source,
        validated.createdAt,
      );
    },
  );
}

export function getMergeIntents(
  projectPath: string,
  commitShas: string[],
): MergeIntent[] {
  if (commitShas.length === 0) return [];
  return timedSync(
    logger,
    "state-db.getMergeIntents",
    { shaCount: commitShas.length },
    () => {
      const db = getStateDb();
      const placeholders = commitShas.map(() => "?").join(", ");
      const rawRows = db
        .prepare(
          `SELECT * FROM merge_intents WHERE project_path = ? AND commit_sha IN (${placeholders})`,
        )
        .all(projectPath, ...commitShas) as unknown[];
      return rawRows.map(rowToMergeIntent);
    },
    (result) => ({ foundCount: result.length }),
  );
}
