import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "@/lib/shared/atomic-write-json";
import { createLogger } from "@/lib/logging";
import {
  cursorBillingLedgerSchema,
  emptyCursorBillingLedger,
  type CursorBillingLedger,
} from "./billing-ledger";

const logger = createLogger("cursor:billing-ledger");

export interface CursorBillingStore {
  load(): Promise<CursorBillingLedger>;
  save(ledger: CursorBillingLedger): Promise<void>;
}

/**
 * The conversation's billing ledger on disk, beside the provider task ledger
 * under the Command Center-owned agent store. A missing file is an empty
 * ledger; a file that does not parse is an error, because a fresh zero
 * history would silently re-apply every settlement the lost one had recorded.
 */
export function createCursorBillingStore(
  storePath: string,
): CursorBillingStore {
  const file = path.join(storePath, "cc-billing-ledger.json");
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return emptyCursorBillingLedger();
        logger.error("cursor-billing.ledger_read_failed", { file });
        throw error;
      }
      const parsed = cursorBillingLedgerSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        logger.error("cursor-billing.ledger_invalid", {
          file,
          issueCount: parsed.error.issues.length,
        });
        throw new Error("Invalid Cursor billing ledger");
      }
      return parsed.data;
    },
    async save(ledger) {
      await atomicWriteJson(file, cursorBillingLedgerSchema.parse(ledger));
      logger.debug("cursor-billing.ledger_saved", {
        turnCount: ledger.turns.length,
        availability: ledger.availability.state,
      });
    },
  };
}
