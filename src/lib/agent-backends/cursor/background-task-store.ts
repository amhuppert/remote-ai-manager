import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "@/lib/shared/atomic-write-json";
import { createLogger } from "@/lib/logging";
import {
  cursorTaskStateSchema,
  type CursorTaskStore,
} from "./background-tasks";
const logger = createLogger("cursor:background-tasks");
export function createCursorTaskStore(storePath: string): CursorTaskStore {
  const file = path.join(storePath, "cc-provider-tasks.json");
  return {
    async load() {
      try {
        const decoded: unknown = JSON.parse(await readFile(file, "utf8"));
        const parsed = cursorTaskStateSchema.safeParse(decoded);
        if (!parsed.success)
          throw new Error("Invalid Cursor provider task ledger");
        return parsed.data;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];
        logger.error("cursor-tasks.ledger_read_failed", { file });
        throw error;
      }
    },
    async save(tasks) {
      await atomicWriteJson(file, cursorTaskStateSchema.parse(tasks));
      logger.debug("cursor-tasks.ledger_saved", { taskCount: tasks.length });
    },
  };
}
