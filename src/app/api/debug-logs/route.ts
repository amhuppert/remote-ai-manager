import { createDebugLogsIngestHandlers } from "@/lib/debug-logs-ingest-route-handlers";

export const dynamic = "force-dynamic";

const handlers = createDebugLogsIngestHandlers();

export const OPTIONS = handlers.OPTIONS;
export const POST = handlers.POST;
