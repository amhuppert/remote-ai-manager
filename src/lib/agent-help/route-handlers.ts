/**
 * Agent-facing help-context endpoint (docs/design/cc-cli/04 §4.2).
 *
 *   GET /api/agent/help-context?command=<space-joined path>
 *       &project=&session=&conversation=&executionId=&contextId=
 *
 * Token-gated like every agent endpoint. Returns server-rendered `context:`
 * blocks the CLI appends to static `--help` best-effort. An unknown command
 * returns 200 { blocks: [] }, NEVER 404 — the CLI treats this endpoint as
 * garnish, and a 404 would be indistinguishable from a wrong URL.
 */
import { NextResponse } from "next/server";

import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { withTracing } from "@/lib/logging";

import { createDefaultProviderDeps } from "./provider-deps";
import { buildHelpContextProviders } from "./providers";
import { helpContextQuerySchema, type HelpContextResponse } from "./schemas";
import { createHelpContextService, type HelpContextService } from "./service";

export interface AgentHelpRouteDeps {
  auth: AgentAuth;
  service: HelpContextService;
}

export interface AgentHelpRouteHandlers {
  helpContextGET(request: Request): Promise<Response>;
}

const EMPTY: HelpContextResponse = { blocks: [] };

/** A present, non-empty query param; empty or absent both read as "not sent". */
function paramOrUndefined(
  params: URLSearchParams,
  name: string,
): string | undefined {
  const value = params.get(name);
  return value !== null && value.length > 0 ? value : undefined;
}

export function createAgentHelpRouteHandlers(
  deps: AgentHelpRouteDeps,
): AgentHelpRouteHandlers {
  return {
    async helpContextGET(request) {
      const denied = await deps.auth.requireToken(request);
      if (denied) return denied;

      const params = new URL(request.url).searchParams;
      const parsed = helpContextQuerySchema.safeParse({
        command: paramOrUndefined(params, "command"),
        project: paramOrUndefined(params, "project"),
        session: paramOrUndefined(params, "session"),
        conversation: paramOrUndefined(params, "conversation"),
        executionId: paramOrUndefined(params, "executionId"),
        contextId: paramOrUndefined(params, "contextId"),
      });
      // A malformed query (no command) is not an error the CLI can act on —
      // return empty blocks, never a non-200 that would train agents to fear help.
      if (!parsed.success) return NextResponse.json(EMPTY);

      const response = await deps.service.resolveHelpContext(parsed.data);
      return NextResponse.json(response);
    },
  };
}

/**
 * Lazily build the production service so importing this module (route shells do
 * so at registration time) never eagerly constructs providers or opens a DB.
 */
let memoizedService: HelpContextService | null = null;
function getProductionService(): HelpContextService {
  memoizedService ??= createHelpContextService({
    providers: buildHelpContextProviders(createDefaultProviderDeps()),
  });
  return memoizedService;
}

const defaultHandlers = createAgentHelpRouteHandlers({
  auth: createAgentAuth(),
  get service() {
    return getProductionService();
  },
});

/** GET /api/agent/help-context — dynamic help-context blocks for a command. */
export const GET = withTracing(defaultHandlers.helpContextGET);
