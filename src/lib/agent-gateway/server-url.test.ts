import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetServerBaseUrlForTesting,
  getServerBaseUrl,
  getServerBootNonce,
  recordServerBaseUrl,
  resolveServerBaseUrl,
  verifyRecordedServerBaseUrl,
} from "./server-url";

describe("resolveServerBaseUrl", () => {
  it("derives the loopback URL from PORT", () => {
    expect(resolveServerBaseUrl({ PORT: "3105" })).toBe(
      "http://127.0.0.1:3105",
    );
  });

  it("falls back to port 3000 when PORT is unset or empty", () => {
    expect(resolveServerBaseUrl({})).toBe("http://127.0.0.1:3000");
    expect(resolveServerBaseUrl({ PORT: "" })).toBe("http://127.0.0.1:3000");
  });

  it("honors CC_SERVER_URL over PORT", () => {
    expect(
      resolveServerBaseUrl({
        CC_SERVER_URL: "http://127.0.0.1:3071",
        PORT: "3000",
      }),
    ).toBe("http://127.0.0.1:3071");
  });

  it("trims trailing slashes from CC_SERVER_URL", () => {
    expect(
      resolveServerBaseUrl({ CC_SERVER_URL: "https://host.tail1234.ts.net/" }),
    ).toBe("https://host.tail1234.ts.net");
  });

  it("preserves a path prefix while trimming the trailing slash", () => {
    expect(resolveServerBaseUrl({ CC_SERVER_URL: "http://x:3000/cc/" })).toBe(
      "http://x:3000/cc",
    );
  });

  it("falls through to the PORT-derived URL for an unparseable CC_SERVER_URL", () => {
    expect(
      resolveServerBaseUrl({ CC_SERVER_URL: "not a url", PORT: "3105" }),
    ).toBe("http://127.0.0.1:3105");
  });

  it("falls through for a non-http(s) CC_SERVER_URL", () => {
    expect(
      resolveServerBaseUrl({ CC_SERVER_URL: "ftp://x:3000", PORT: "3105" }),
    ).toBe("http://127.0.0.1:3105");
  });

  it("falls through for a whitespace-only CC_SERVER_URL", () => {
    expect(resolveServerBaseUrl({ CC_SERVER_URL: "   " })).toBe(
      "http://127.0.0.1:3000",
    );
  });
});

describe("recordServerBaseUrl / getServerBaseUrl", () => {
  beforeEach(() => {
    _resetServerBaseUrlForTesting();
  });

  it("returns null before boot records the URL", () => {
    expect(getServerBaseUrl()).toBeNull();
  });

  it("returns the recorded URL after boot", () => {
    recordServerBaseUrl({ PORT: "3200" });
    expect(getServerBaseUrl()).toBe("http://127.0.0.1:3200");
  });

  it("makes the URL recorded at boot visible to a separately-loaded module instance", async () => {
    // Next.js bundles instrumentation (which records the URL) separately from
    // the route-handler runtime (which reads it to build spawned-session env).
    // A module-local variable is invisible across that split; the recorded URL
    // must live in process-global state. Simulate the second graph with a
    // module registry reset + re-import.
    recordServerBaseUrl({ PORT: "3200" });

    vi.resetModules();
    const freshInstance = await import("./server-url");

    expect(freshInstance.getServerBaseUrl()).toBe("http://127.0.0.1:3200");
  });

  it("stores a boot nonce visible to a separately-loaded module instance", async () => {
    recordServerBaseUrl({ PORT: "3200" });
    const nonce = getServerBootNonce();
    expect(nonce).toBeTypeOf("string");
    expect(nonce).not.toBe("");

    vi.resetModules();
    const freshInstance = await import("./server-url");

    expect(freshInstance.getServerBootNonce()).toBe(nonce);
  });

  it("returns null from getServerBootNonce before boot records the URL", () => {
    expect(getServerBootNonce()).toBeNull();
  });
});

describe("verifyRecordedServerBaseUrl", () => {
  beforeEach(() => {
    _resetServerBaseUrlForTesting();
  });

  function identityResponse(nonce: string | null, status = 200): Response {
    return new Response(
      JSON.stringify({ instanceNonce: nonce, serverBuild: "build-1" }),
      { status, headers: { "content-type": "application/json" } },
    );
  }

  const immediateDelay = {
    delay: () => Promise.resolve(),
  };

  it("keeps the recorded URL when the probe answers with the local nonce, and memoizes the probe", async () => {
    recordServerBaseUrl({ PORT: "3200" });
    const localNonce = getServerBootNonce();
    let fetchCount = 0;
    const deps = {
      ...immediateDelay,
      fetchImpl: async () => {
        fetchCount += 1;
        return identityResponse(localNonce);
      },
    };

    await verifyRecordedServerBaseUrl(deps);
    await verifyRecordedServerBaseUrl(deps);

    expect(getServerBaseUrl()).toBe("http://127.0.0.1:3200");
    expect(fetchCount).toBe(1);
  });

  it("refuses to expose the URL when a live server answers with a foreign nonce", async () => {
    // The 7b35d37a scenario: `next dev -p 3071` without PORT exported records
    // http://127.0.0.1:3000 — the prod instance — which answers the identity
    // probe with its own (different) boot nonce.
    recordServerBaseUrl({});
    expect(getServerBaseUrl()).toBe("http://127.0.0.1:3000");

    await verifyRecordedServerBaseUrl({
      ...immediateDelay,
      fetchImpl: async () => identityResponse("some-other-instance-nonce"),
    });

    expect(getServerBaseUrl()).toBeNull();
  });

  it("treats a 404 (foreign or older build) as a confirmed mismatch", async () => {
    recordServerBaseUrl({});

    await verifyRecordedServerBaseUrl({
      ...immediateDelay,
      fetchImpl: async () => new Response("not found", { status: 404 }),
    });

    expect(getServerBaseUrl()).toBeNull();
  });

  it("retries through connection failures and verifies once the server listens", async () => {
    recordServerBaseUrl({ PORT: "3200" });
    const localNonce = getServerBootNonce();
    let attempts = 0;
    const delays: number[] = [];

    await verifyRecordedServerBaseUrl({
      fetchImpl: async () => {
        attempts += 1;
        if (attempts <= 3) throw new Error("ECONNREFUSED");
        return identityResponse(localNonce);
      },
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    expect(attempts).toBe(4);
    expect(delays.length).toBe(3);
    expect(getServerBaseUrl()).toBe("http://127.0.0.1:3200");
  });

  it("stays fail-open (URL still injected) when every attempt is a network error", async () => {
    recordServerBaseUrl({ PORT: "3200" });
    let attempts = 0;

    await verifyRecordedServerBaseUrl({
      ...immediateDelay,
      fetchImpl: async () => {
        attempts += 1;
        throw new Error("ECONNREFUSED");
      },
    });

    expect(attempts).toBe(10);
    expect(getServerBaseUrl()).toBe("http://127.0.0.1:3200");
  });

  it("probes the identity endpoint of the recorded URL", async () => {
    recordServerBaseUrl({ PORT: "3200" });
    const localNonce = getServerBootNonce();
    const urls: string[] = [];

    await verifyRecordedServerBaseUrl({
      ...immediateDelay,
      fetchImpl: async (url) => {
        urls.push(url);
        return identityResponse(localNonce);
      },
    });

    expect(urls).toEqual(["http://127.0.0.1:3200/api/agent/identity"]);
  });
});
