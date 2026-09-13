import { addColumnToleratingRace } from "../state-db";
import type { StateMigration } from "./types";

export const mergeCompletionOption: StateMigration = {
  name: "0046-merge-completion-option",
  up: async ({ context: { db } }) => {
    const columns = db.pragma("table_info(job_records)") as Array<{
      name: string;
    }>;
    if (
      !columns.length ||
      columns.some(({ name }) => name === "skip_mark_merged")
    )
      return;
    addColumnToleratingRace(db, "job_records", "skip_mark_merged", "INTEGER");
  },
};
