import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { PersistenceError } from "../shared/errors";

export function createSpecRepoHelpers(moduleName: string) {
  const logger = createLogger(moduleName);

  function parseRow<T>(
    schema: z.ZodType<T>,
    entity: string,
    identifier: string,
    value: unknown,
  ): T {
    const result = schema.safeParse(value);
    if (result.success) return result.data;

    logger.error(`${moduleName}.schema_validation_failure`, {
      entity,
      identifier,
      issues: result.error.issues,
    });
    throw new PersistenceError({
      kind: "validation",
      entity,
      identifier,
      issues: result.error.issues,
    });
  }

  function timed<T>(
    operation: string,
    entity: string,
    identifier: string,
    fn: () => T,
  ): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      logger.info(`${moduleName}.${operation}.timing`, {
        entity,
        identifier,
        durationMs: +(performance.now() - start).toFixed(3),
      });
    }
  }

  function readOne<T>(
    schema: z.ZodType<T>,
    entity: string,
    identifier: string,
    read: () => unknown,
  ): T | null {
    const row = read();
    if (row === undefined) return null;
    return parseRow(schema, entity, identifier, row);
  }

  function readMany<T>(
    schema: z.ZodType<T>,
    entity: string,
    scope: string,
    read: () => unknown[],
  ): T[] {
    return read().map((row, index) =>
      parseRow(schema, entity, `${scope}:${index}`, row),
    );
  }

  return { parseRow, readMany, readOne, timed };
}
