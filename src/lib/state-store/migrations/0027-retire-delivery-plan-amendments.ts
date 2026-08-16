import { createLogger } from "@/lib/logging";
import type { StateMigration } from "./types";

const logger = createLogger("state-store/migrations");

/**
 * Delivery-plan executions no longer have a separate live-amend path. The
 * event existed only to audit that retired surface, so preserving it would
 * require a legacy event decoder in the active runtime.
 */
export const retireDeliveryPlanAmendments: StateMigration = {
  name: "0027-retire-delivery-plan-amendments",
  async up({ context }) {
    const result = context.db
      .prepare(
        `DELETE FROM graph_workflow_events
          WHERE event_type = 'graph-workflow-execution-amended'`,
      )
      .run();

    logger.info("state-store.delivery_plan_amendments_retired", {
      deletedEventCount: result.changes,
    });
  },
};
