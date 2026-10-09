import { CONVERSATION_SUBSCRIPTIONS_SCHEMA_DDL } from "../state-db";

/** The subscription tables as they were before run sources and waking follows (schema 29). */
export const SUBSCRIPTIONS_DDL_BEFORE_RUN_SOURCE =
  CONVERSATION_SUBSCRIPTIONS_SCHEMA_DDL.replaceAll(",'run'", "").replace(
    /\n\s*--[^\n]*\n\s*wakes INTEGER[^\n]*/,
    "",
  );
