/**
 * Version route handler — exposes the commit SHA, build time, and latest commit
 * message captured for this production build (see
 * scripts/generate-build-info.ts) as JSON.
 *
 * The route file delegates here; tests inject a fixed BuildInfo via
 * `createVersionRouteHandlers(deps)` so assertions never chase the live SHA.
 */

import { NextResponse } from "next/server";

import { createLogger, withTracing } from "@/lib/logging";

import { getBuildInfo } from "./index";
import { toVersionResponse, type BuildInfo } from "./stamp";

const log = createLogger("build-info");

export interface VersionRouteDeps {
  getBuildInfo(): BuildInfo;
}

const defaultDeps: VersionRouteDeps = { getBuildInfo };

export function createVersionRouteHandlers(
  deps: VersionRouteDeps = defaultDeps,
) {
  async function GET(): Promise<Response> {
    const info = deps.getBuildInfo();
    log.debug("version.read", { sha: info.sha });
    return NextResponse.json(toVersionResponse(info));
  }

  return { GET };
}

const defaultHandlers = createVersionRouteHandlers();

/** GET /api/version — commit SHA, build time, and message of this production build. */
export const GET = withTracing(defaultHandlers.GET);
