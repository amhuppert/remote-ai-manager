import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  BUILD_MISMATCH_HEADER,
  BUILD_SKEW_CODE,
  CLI_BUILD_HEADER,
  buildMismatchHeaderValue,
} from "@/lib/agent-gateway/build-parity";
import { getBuildStamp } from "@/lib/build-info";

/**
 * The mismatch headers this response should carry, or null when the caller and
 * this server are the same build. Exported for direct test;
 * {@link buildParityResponse} is the only production caller.
 */
export function buildParityHeaders(
  requestHeaders: Headers,
  serverBuild: string,
): Headers | null {
  const value = buildMismatchHeaderValue(
    requestHeaders.get(CLI_BUILD_HEADER),
    serverBuild,
  );
  if (value === null) return null;
  const headers = new Headers();
  headers.set(BUILD_MISMATCH_HEADER, value);
  return headers;
}

const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

interface BuildSkewBody {
  error: string;
  code: typeof BUILD_SKEW_CODE;
  details: {
    serverBuild: string;
    /**
     * Absolute path of the cctl this server publishes, or null when the
     * middleware cannot name it. Resolving it needs the config-dir/home lookup,
     * which would pull the config loader and logging into a module that runs
     * ahead of every /api request, so the handshake (`cctl doctor`) stays the
     * surface that reports the path.
     */
    serverCliPath: string | null;
  };
}

function buildSkewBody(serverBuild: string): BuildSkewBody {
  return {
    error: `refused before execution: this cctl is not the build this server published (server build ${serverBuild}) — no changes were made; rerun with the cctl this server publishes (\`cctl doctor\` prints its path)`,
    code: BUILD_SKEW_CODE,
    details: { serverBuild, serverCliPath: null },
  };
}

/**
 * Decide what a skewed caller gets. A mutation is refused here, before the
 * route handler runs: the server is the only party that knows whether the write
 * committed, so a binary that checks parity on the response can only report a
 * mutation it already caused. Reads are forwarded with the mismatch header —
 * they commit nothing, and the caller can still refuse the payload.
 *
 * A caller that states no build (the browser, curl, internal fetches) is never
 * a cctl and is never refused.
 */
export function buildParityResponse(
  request: NextRequest,
  serverBuild: string,
): NextResponse {
  const headers = buildParityHeaders(request.headers, serverBuild);
  if (headers === null) return NextResponse.next();
  if (MUTATING_METHODS.has(request.method)) {
    // The mismatch header rides the refusal too, so a binary that predates the
    // `build_skew` code still reads it as skew (exit 4) rather than as a
    // generic 409.
    return NextResponse.json(buildSkewBody(serverBuild), {
      status: 409,
      headers,
    });
  }
  return NextResponse.next({ headers });
}

export function middleware(request: NextRequest): NextResponse {
  return buildParityResponse(request, getBuildStamp());
}

export const config = { matcher: "/api/:path*" };
