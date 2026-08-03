import { describe, expect, it } from "vitest";

import {
  BUILD_MISMATCH_HEADER,
  CLI_BUILD_HEADER,
} from "@/lib/agent-gateway/build-parity";

import { buildParityHeaders } from "./middleware";

const SERVER_BUILD = "server-sha-1";

function headersWith(cliBuild: string | null): Headers {
  const headers = new Headers();
  if (cliBuild !== null) headers.set(CLI_BUILD_HEADER, cliBuild);
  return headers;
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
