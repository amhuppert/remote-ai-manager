import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import {
  BUILD_MISMATCH_HEADER,
  CLI_BUILD_HEADER,
} from "@/lib/agent-gateway/build-parity";
import { getBuildStamp } from "@/lib/build-info";

import {
  buildParityHeaders,
  buildParityResponse,
  middleware,
} from "./middleware";

const SERVER_BUILD = "server-sha-1";
const SKEWED_CLI_BUILD = "other-sha";
const NEXT_HEADER = "x-middleware-next";

function headersWith(cliBuild: string | null): Headers {
  const headers = new Headers();
  if (cliBuild !== null) headers.set(CLI_BUILD_HEADER, cliBuild);
  return headers;
}

function requestFrom(method: string, cliBuild: string | null): NextRequest {
  return new NextRequest("http://localhost:3000/api/agent/ask", {
    method,
    headers: headersWith(cliBuild),
  });
}

describe("buildParityHeaders", () => {
  it("flags a cctl built from a different tree than the server", () => {
    const result = buildParityHeaders(headersWith("other-sha"), SERVER_BUILD);
    expect(result?.get(BUILD_MISMATCH_HEADER)).toBe(
      `server=${SERVER_BUILD} cli=other-sha`,
    );
  });

  it("stays silent for a cctl the server itself published", () => {
    expect(
      buildParityHeaders(headersWith(SERVER_BUILD), SERVER_BUILD),
    ).toBeNull();
  });

  it("stays silent for callers that are not cctl", () => {
    // The browser app hits the same /api routes on every page; a build header
    // it never sends must not turn into a warning it cannot act on.
    expect(buildParityHeaders(headersWith(null), SERVER_BUILD)).toBeNull();
  });
});

describe("buildParityResponse", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "refuses a skewed %s before the route handler runs",
    async (method) => {
      const response = buildParityResponse(
        requestFrom(method, SKEWED_CLI_BUILD),
        SERVER_BUILD,
      );

      expect(response.status).toBe(409);
      expect(response.headers.get(NEXT_HEADER)).toBeNull();
      expect(await response.json()).toEqual({
        error: expect.stringContaining("no changes were made"),
        code: "build_skew",
        details: { serverBuild: SERVER_BUILD, serverCliPath: null },
      });
    },
  );

  it("keeps the mismatch header on the refusal so a cctl that predates the code still exits 4", () => {
    const response = buildParityResponse(
      requestFrom("POST", SKEWED_CLI_BUILD),
      SERVER_BUILD,
    );

    expect(response.headers.get(BUILD_MISMATCH_HEADER)).toBe(
      `server=${SERVER_BUILD} cli=${SKEWED_CLI_BUILD}`,
    );
  });

  it.each(["GET", "HEAD"])(
    "forwards a skewed %s annotated — a read commits nothing",
    (method) => {
      const response = buildParityResponse(
        requestFrom(method, SKEWED_CLI_BUILD),
        SERVER_BUILD,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get(NEXT_HEADER)).toBe("1");
      expect(response.headers.get(BUILD_MISMATCH_HEADER)).toBe(
        `server=${SERVER_BUILD} cli=${SKEWED_CLI_BUILD}`,
      );
    },
  );

  it("forwards a matched-build mutation untouched", () => {
    const response = buildParityResponse(
      requestFrom("POST", SERVER_BUILD),
      SERVER_BUILD,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get(NEXT_HEADER)).toBe("1");
    expect(response.headers.get(BUILD_MISMATCH_HEADER)).toBeNull();
  });

  it("forwards a mutation from a caller that is not cctl", () => {
    // Every browser mutation lands here; a caller that states no build has no
    // skew to refuse.
    const response = buildParityResponse(
      requestFrom("POST", null),
      SERVER_BUILD,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get(NEXT_HEADER)).toBe("1");
  });
});

describe("middleware", () => {
  it("refuses a skewed mutation against this build's own stamp", async () => {
    const response = middleware(requestFrom("POST", SKEWED_CLI_BUILD));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: expect.any(String),
      code: "build_skew",
      details: { serverBuild: getBuildStamp(), serverCliPath: null },
    });
  });

  it("forwards a mutation from a cctl of this build", () => {
    const response = middleware(requestFrom("POST", getBuildStamp()));

    expect(response.headers.get(NEXT_HEADER)).toBe("1");
    expect(response.status).toBe(200);
  });
});
