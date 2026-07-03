/**
 * Agent gateway — HTTP surface for the cctl CLI (docs/design/cc-cli/01).
 * All endpoints here are token-gated via createAgentAuth; the browser UI
 * never calls them.
 */

import { NextResponse } from "next/server";
import { getBuildStamp } from "@/lib/build-info";
import { createLogger, withTracing } from "@/lib/logging";
import { createAgentAuth } from "./token";

const log = createLogger("agent-gateway");

export const CLI_BUILD_HEADER = "x-cc-cli-build";
export const BUILD_MISMATCH_HEADER = "x-cc-build-mismatch";

export interface AgentGatewayDeps {
  /** Config dir holding the api-token file; defaults to the live config dir. */
  configDir?: string;
  getServerBuildStamp?(): string;
}

export function createAgentGatewayHandlers(deps: AgentGatewayDeps = {}) {
  const auth = createAgentAuth(
    deps.configDir === undefined ? {} : { configDir: deps.configDir },
  );
  const getServerBuildStamp = deps.getServerBuildStamp ?? getBuildStamp;

  async function handshakeGET(request: Request): Promise<Response> {
    const denied = await auth.requireToken(request);
    if (denied) return denied;

    const url = new URL(request.url);
    const identity = {
      project: url.searchParams.get("project"),
      session: url.searchParams.get("session"),
      conversation: url.searchParams.get("conversation"),
    };

    const serverBuild = getServerBuildStamp();
    const cliBuild = request.headers.get(CLI_BUILD_HEADER);
    const headers = new Headers();
    if (cliBuild !== null && cliBuild !== serverBuild) {
      headers.set(
        BUILD_MISMATCH_HEADER,
        `server=${serverBuild} cli=${cliBuild}`,
      );
      log.warn("agent-gateway.build_mismatch", { serverBuild, cliBuild });
    }

    log.info("agent-gateway.handshake", { ...identity, cliBuild });
    return NextResponse.json(
      { serverBuild, identity, tokenValid: true },
      { headers },
    );
  }

  return { handshakeGET };
}

const defaultHandlers = createAgentGatewayHandlers();

/** GET /api/agent/handshake — build stamp, identity echo, token validity */
export const GET = withTracing(defaultHandlers.handshakeGET);
