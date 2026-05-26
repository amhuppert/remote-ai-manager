/**
 * All-conversations route handler — extracted for dependency injection.
 *
 * Returns every conversation across every project so the `#`-trigger
 * autocomplete can surface cross-session targets. Filters archived items
 * unless `?includeArchived=true` is set.
 */

import { NextResponse } from "next/server";
import {
  listAllConversations as defaultListAllConversations,
  type ListAllConversationsResult,
} from "./cross-project-list";
import { createLogger } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";

const log = createLogger("all-conversations-route-handlers");

export interface AllConversationsRouteDeps {
  listAllConversations(opts: {
    includeArchived: boolean;
  }): Promise<ListAllConversationsResult>;
}

const defaultDeps: AllConversationsRouteDeps = {
  listAllConversations: defaultListAllConversations,
};

export function createAllConversationsRouteHandlers(
  deps: AllConversationsRouteDeps = defaultDeps,
) {
  async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    try {
      const result = await deps.listAllConversations({ includeArchived });
      return NextResponse.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("listAllConversations failed", { err: message });
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }
  }
  return { GET };
}

export const { GET: GET_AllConversations } =
  createAllConversationsRouteHandlers();
