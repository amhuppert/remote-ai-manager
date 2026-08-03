/**
 * Agent gateway — HTTP surface for the cctl CLI (docs/design/cc-cli/01).
 * Endpoints are token-gated via createAgentAuth, EXCEPT /api/agent/identity:
 * the boot self-probe must distinguish "this instance" from a foreign one
 * before any token exchange (a foreign server would 401 first). This is a
 * deliberate unauthenticated exposure of the random per-boot nonce and the
 * build stamp: the nonce carries nothing beyond instance identity and rotates
 * every boot, and the build stamp is a non-sensitive version string. The
 * browser UI never calls these.
 */

import { NextResponse } from "next/server";
import { getBuildStamp } from "@/lib/build-info";
import { getConfigDirPath } from "@/lib/config/loader";
import {
  BUILD_MISMATCH_HEADER,
  CLI_BUILD_HEADER,
  buildMismatchHeaderValue,
} from "./build-parity";
import { cctlInstallPath } from "./install-cli";
import { createLogger, withTracing } from "@/lib/logging";
import { getServerBootNonce } from "./server-url";
import { createAgentAuth } from "./token";

const log = createLogger("agent-gateway");

export { BUILD_MISMATCH_HEADER, CLI_BUILD_HEADER } from "./build-parity";

export interface AgentGatewayDeps {
  /** Config dir holding the api-token file; defaults to the live config dir. */
  configDir?: string;
  getServerBuildStamp?(): string;
  getBootNonce?(): string | null;
  /** Absolute path of the cctl this server publishes. */
  getCliPath?(): string;
}

export function createAgentGatewayHandlers(deps: AgentGatewayDeps = {}) {
  const auth = createAgentAuth(
    deps.configDir === undefined ? {} : { configDir: deps.configDir },
  );
  const getServerBuildStamp = deps.getServerBuildStamp ?? getBuildStamp;
  const getBootNonce = deps.getBootNonce ?? getServerBootNonce;
  const getCliPath =
    deps.getCliPath ??
    (() => cctlInstallPath(deps.configDir ?? getConfigDirPath()));

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
    const mismatch = buildMismatchHeaderValue(cliBuild, serverBuild);
    if (mismatch !== null) {
      headers.set(BUILD_MISMATCH_HEADER, mismatch);
      log.warn("agent-gateway.build_mismatch", { serverBuild, cliBuild });
    }

    log.info("agent-gateway.handshake", { ...identity, cliBuild });
    // cliPath is what makes a build mismatch actionable: this server owns a
    // stamped binary, and doctor is the command that can name it.
    return NextResponse.json(
      { serverBuild, identity, tokenValid: true, cliPath: getCliPath() },
      { headers },
    );
  }

  async function identityGET(): Promise<Response> {
    const instanceNonce = getBootNonce();
    log.info("agent-gateway.identity_probe", {
      hasNonce: instanceNonce !== null,
    });
    return NextResponse.json({
      instanceNonce,
      serverBuild: getServerBuildStamp(),
    });
  }

  return { handshakeGET, identityGET };
}

const defaultHandlers = createAgentGatewayHandlers();

/** GET /api/agent/handshake — build stamp, identity echo, token validity */
export const GET = withTracing(defaultHandlers.handshakeGET);

/** GET /api/agent/identity — per-boot instance nonce for the URL self-probe */
export const IDENTITY_GET = withTracing(defaultHandlers.identityGET);
