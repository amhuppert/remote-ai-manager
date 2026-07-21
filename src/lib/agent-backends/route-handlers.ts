/**
 * Catalog route for the registered agent backends. Serves descriptor metadata
 * and capability labels only — provider adapters, factories, and config
 * payloads never cross this wire (the projection is `catalogEntryFromDescriptor`).
 */

import { NextResponse } from "next/server";
import { createLogger, withTracing } from "@/lib/logging";
import { listBackends } from "./registry";
import {
  backendCatalogResponseSchema,
  catalogEntryFromDescriptor,
  type BackendCatalogResponse,
} from "./catalog";

const log = createLogger("agent-backends:catalog-route");

async function getBackendCatalog(): Promise<
  NextResponse<BackendCatalogResponse>
> {
  const backends = listBackends().map(catalogEntryFromDescriptor);
  log.debug("catalog.served", {
    backendCount: backends.length,
    backends: backends.map((b) => b.id),
  });
  return NextResponse.json(backendCatalogResponseSchema.parse({ backends }));
}

export const GET = withTracing(getBackendCatalog);
