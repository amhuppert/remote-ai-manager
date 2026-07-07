import { describe, expect, it } from "vitest";
import { fetchHelpContext, type HelpContextParams } from "./help-context";
import type { CliHost, FetchInit } from "./shared";

interface Recorded {
  url: string;
  init: FetchInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeHost(
  fetchImpl: CliHost["fetch"],
): CliHost & { requests: Recorded[] } {
  const requests: Recorded[] = [];
  return {
    requests,
    async fetch(url, init) {
      requests.push({ url, init });
      return fetchImpl(url, init);
    },
    async readTextFile() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

const baseParams: HelpContextParams = {
  server: "http://127.0.0.1:3000",
  token: "tok",
  command: "dev ensure",
  project: "cc",
  session: "s1",
  conversation: "c1",
  executionId: null,
  contextId: null,
};

describe("fetchHelpContext", () => {
  it("returns the server's blocks on a valid 200 response", async () => {
    const host = makeHost(async () =>
      jsonResponse({
        blocks: [{ title: "dev servers", body: "web — running" }],
      }),
    );
    const blocks = await fetchHelpContext(host, baseParams);
    expect(blocks).toEqual([{ title: "dev servers", body: "web — running" }]);
  });

  it("GETs /api/agent/help-context with command, identity, and bearer token", async () => {
    const host = makeHost(async () => jsonResponse({ blocks: [] }));
    await fetchHelpContext(host, baseParams);

    const req = host.requests[0];
    expect(req).toBeDefined();
    if (!req) return;
    const url = new URL(req.url);
    expect(url.pathname).toBe("/api/agent/help-context");
    expect(url.searchParams.get("command")).toBe("dev ensure");
    expect(url.searchParams.get("project")).toBe("cc");
    expect(url.searchParams.get("session")).toBe("s1");
    expect(url.searchParams.get("conversation")).toBe("c1");
    expect(req.init.method).toBe("GET");
    expect(req.init.headers["authorization"]).toBe("Bearer tok");
  });

  it("sends the 500 ms timeout so a slow server never stalls --help", async () => {
    const host = makeHost(async () => jsonResponse({ blocks: [] }));
    await fetchHelpContext(host, baseParams);
    expect(host.requests[0]?.init.timeoutMs).toBe(500);
  });

  it("forwards lane params when present and omits absent ones", async () => {
    const host = makeHost(async () => jsonResponse({ blocks: [] }));
    await fetchHelpContext(host, {
      ...baseParams,
      project: null,
      executionId: "exec-1",
      contextId: "ctx-1",
    });
    const url = new URL(host.requests[0]?.url ?? "");
    expect(url.searchParams.get("executionId")).toBe("exec-1");
    expect(url.searchParams.get("contextId")).toBe("ctx-1");
    expect(url.searchParams.has("project")).toBe(false);
  });

  it("fails open to [] on a non-2xx response", async () => {
    const host = makeHost(async () => jsonResponse({ error: "boom" }, 500));
    expect(await fetchHelpContext(host, baseParams)).toEqual([]);
  });

  it("fails open to [] when the fetch throws (connection / timeout)", async () => {
    const host = makeHost(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await fetchHelpContext(host, baseParams)).toEqual([]);
  });

  it("fails open to [] on an unparseable body", async () => {
    const host = makeHost(
      async () => new Response("<<<not json", { status: 200 }),
    );
    expect(await fetchHelpContext(host, baseParams)).toEqual([]);
  });

  it("fails open to [] on a schema-mismatched body", async () => {
    const host = makeHost(async () => jsonResponse({ not: "blocks" }));
    expect(await fetchHelpContext(host, baseParams)).toEqual([]);
  });
});
