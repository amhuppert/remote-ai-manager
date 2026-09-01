import { NextResponse } from "next/server";
import type { ApiError } from "@/lib/api/errors";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { createLogger, withTracing } from "@/lib/logging";
import {
  getConversationSnapshotRefreshService,
  getLegacyRelatedTicketAdapter,
} from "./service-factory";
import type { LegacyRelatedTicketAdapter } from "./legacy-related-ticket-adapter";
import {
  conversationSnapshotRefreshInputSchema,
  type ConversationSnapshotRefreshService,
} from "./snapshot-refresh";
import {
  resolveIdentity,
  ticketResponse,
  validationFailedResponse,
  type RouteContext,
} from "./route-handlers";
import { toTicketValidationIssues } from "./service";

const logger = createLogger("tickets.snapshot-refresh.routes");

export interface ConversationSnapshotRefreshRouteDeps {
  getService(): ConversationSnapshotRefreshService;
  getLegacyRelatedTicketAdapter(): LegacyRelatedTicketAdapter;
  auth: AgentAuth;
}

export interface ConversationSnapshotRefreshRouteHandlers {
  refreshPOST(request: Request, context: RouteContext): Promise<Response>;
}

function internalErrorResponse(): Response {
  return NextResponse.json(
    {
      error: "Conversation snapshot refresh failed",
      code: "internal_error",
    } satisfies ApiError,
    { status: 500 },
  );
}

export function createConversationSnapshotRefreshRouteHandlers(
  deps: ConversationSnapshotRefreshRouteDeps = defaultDeps(),
): ConversationSnapshotRefreshRouteHandlers {
  return {
    async refreshPOST(request, context) {
      const validation = await deps.auth.validateOptionalToken(request);
      if (validation.kind === "invalid") {
        return NextResponse.json(
          { error: "Invalid Command Center API token" } satisfies ApiError,
          { status: 401 },
        );
      }

      const identity = await resolveIdentity(context);
      const params = await context.params;
      const parsed = conversationSnapshotRefreshInputSchema.safeParse({
        ...identity,
        attachmentId: params["attachmentId"] ?? "",
      });
      if (!parsed.success) {
        return validationFailedResponse(toTicketValidationIssues(parsed.error));
      }

      try {
        const result = await deps.getService().refresh(parsed.data);
        if (!result.ok && result.error.code === "attachment_not_found") {
          const handle = await deps
            .getLegacyRelatedTicketAdapter()
            .isRelationshipHandle(parsed.data);
          if (!handle.ok) return ticketResponse(handle);
          if (handle.value) {
            return validationFailedResponse([
              {
                path: "attachmentId",
                message: "relationships do not have refreshable snapshots",
              },
            ]);
          }
        }
        return ticketResponse(result);
      } catch (error) {
        logger.error("tickets.snapshot_refresh.routes.failed", {
          ...parsed.data,
          error: error instanceof Error ? error.message : String(error),
        });
        return internalErrorResponse();
      }
    },
  };
}

function defaultDeps(): ConversationSnapshotRefreshRouteDeps {
  return {
    getService: () => getConversationSnapshotRefreshService(),
    getLegacyRelatedTicketAdapter: () => getLegacyRelatedTicketAdapter(),
    auth: createAgentAuth(),
  };
}

const handlers = createConversationSnapshotRefreshRouteHandlers();
export const refreshConversationSnapshot = withTracing(handlers.refreshPOST);
