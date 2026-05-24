import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tracedFetch } from "./traced-fetch";

interface CapturedFetch {
  url: string;
  init?: RequestInit;
}

function setupFetchStub(makeResponse: () => Response): {
  calls: CapturedFetch[];
} {
  const calls: CapturedFetch[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({
      url: typeof url === "string" ? url : url.toString(),
      init,
    });
    return Promise.resolve(makeResponse());
  }) as typeof fetch;
  return { calls };
}

describe("tracedFetch", () => {
  let originalFetch: typeof fetch;
  let originalLocation: unknown;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocation = (globalThis as Record<string, unknown>)["location"];
    (globalThis as Record<string, unknown>)["location"] = {
      origin: "http://localhost",
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as Record<string, unknown>)["location"] = originalLocation;
    vi.restoreAllMocks();
  });

  it("attaches x-trace-id and x-action headers", async () => {
    const { calls } = setupFetchStub(() => new Response("ok"));

    await tracedFetch("/api/test", "create-session");

    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-action")).toBe("create-session");
    expect(headers.get("x-trace-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("logs api.fetch with totalMs, serverMs, networkMs parsed from Server-Timing", async () => {
    setupFetchStub(
      () =>
        new Response("ok", {
          status: 200,
          headers: { "Server-Timing": "total;dur=42" },
        }),
    );
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    await tracedFetch("/api/test", "do-thing");

    const logCall = debugSpy.mock.calls.find((c) => c[0] === "api.fetch");
    expect(logCall).toBeDefined();
    const payload = logCall?.[1] as Record<string, unknown>;
    expect(payload["action"]).toBe("do-thing");
    expect(payload["url"]).toBe("/api/test");
    expect(payload["status"]).toBe(200);
    expect(payload["serverMs"]).toBe(42);
    expect(typeof payload["totalMs"]).toBe("number");
    expect(payload["networkMs"]).toBe((payload["totalMs"] as number) - 42);
  });

  it("sets serverMs and networkMs to null when Server-Timing is missing", async () => {
    setupFetchStub(() => new Response("ok"));
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    await tracedFetch("/api/test", "do-thing");

    const logCall = debugSpy.mock.calls.find((c) => c[0] === "api.fetch");
    const payload = logCall?.[1] as Record<string, unknown>;
    expect(payload["serverMs"]).toBeNull();
    expect(payload["networkMs"]).toBeNull();
    expect(typeof payload["totalMs"]).toBe("number");
  });

  it("ignores non-total entries and parses only the total metric", async () => {
    setupFetchStub(
      () =>
        new Response("ok", {
          headers: { "Server-Timing": "db;dur=10, total;dur=37, cache;dur=2" },
        }),
    );
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    await tracedFetch("/api/test", "do-thing");

    const logCall = debugSpy.mock.calls.find((c) => c[0] === "api.fetch");
    const payload = logCall?.[1] as Record<string, unknown>;
    expect(payload["serverMs"]).toBe(37);
  });

  it("logs api.fetch.error and re-throws when fetch rejects", async () => {
    const failure = new Error("network down");
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
      Promise.reject(failure)) as typeof fetch;
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    await expect(tracedFetch("/api/test", "do-thing")).rejects.toThrow(
      "network down",
    );

    const errCall = debugSpy.mock.calls.find((c) => c[0] === "api.fetch.error");
    expect(errCall).toBeDefined();
    const payload = errCall?.[1] as Record<string, unknown>;
    expect(payload["action"]).toBe("do-thing");
    expect(payload["error"]).toBe("network down");
    expect(typeof payload["totalMs"]).toBe("number");
  });

  it("uses the request method from init.method, defaulting to GET", async () => {
    setupFetchStub(() => new Response("ok"));
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    await tracedFetch("/api/test", "default");
    await tracedFetch("/api/test", "post", { method: "POST" });

    const get = debugSpy.mock.calls.find(
      (c) =>
        c[0] === "api.fetch" &&
        (c[1] as Record<string, unknown>)["action"] === "default",
    );
    const post = debugSpy.mock.calls.find(
      (c) =>
        c[0] === "api.fetch" &&
        (c[1] as Record<string, unknown>)["action"] === "post",
    );
    expect((get?.[1] as Record<string, unknown>)["method"]).toBe("GET");
    expect((post?.[1] as Record<string, unknown>)["method"]).toBe("POST");
  });
});
