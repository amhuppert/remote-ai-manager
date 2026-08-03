import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  BUILD_MISMATCH_HEADER,
  CLI_BUILD_HEADER,
  buildMismatchHeaderValue,
} from "@/lib/agent-gateway/build-parity";
import { getBuildStamp } from "@/lib/build-info";

/**
 * The mismatch headers this response should carry, or null when the caller and
 * this server are the same build. Exported for direct test; the middleware
 * below is the only production caller.
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

/**
 * Stamp every agent-facing API response with the build the caller is skewed
 * against. The gateway handshake reported this already, but a mismatch only
 * matters at the moment a command runs — an agent holding a stale cctl reads a
 * surface that does not match the server's state and concludes the feature is
 * missing. `cliRequest` turns this header into exit 4.
 */
export function middleware(request: NextRequest): NextResponse {
  const headers = buildParityHeaders(request.headers, getBuildStamp());
  if (headers === null) return NextResponse.next();
  return NextResponse.next({ headers });
}

export const config = { matcher: "/api/:path*" };
