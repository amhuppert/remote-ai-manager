import { SPEC_DELIVERY_VERDICTS_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

export const addSpecDeliveryVerdicts: StateMigration = {
  name: "0029-add-spec-delivery-verdicts",
  async up({ context }) {
    context.db.exec(SPEC_DELIVERY_VERDICTS_SCHEMA_DDL);
  },
};
