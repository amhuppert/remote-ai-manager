import type { StateMigration } from "./types";
import {
  ensureFiniteWaitSourceCursor,
  retireConsumedFiniteWaitSources,
} from "../subscription-wait-lifecycle";

export const retireConsumedFiniteWaitSourcesMigration: StateMigration = {
  name: "0067-retire-consumed-finite-wait-sources",
  async up({ context }) {
    context.db
      .transaction(() => {
        ensureFiniteWaitSourceCursor(context.db);
        retireConsumedFiniteWaitSources(context.db);
      })
      .immediate();
  },
};
