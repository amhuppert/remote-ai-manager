import { describe, expect, it } from "vitest";
import { resolveSandboxProxyUrl } from "./sandbox-proxy";

describe("resolveSandboxProxyUrl", () => {
  it("uses Claude's authenticated proxy inside the sandbox even when loopback is in NO_PROXY", () => {
    expect(
      resolveSandboxProxyUrl(
        {
          SANDBOX_RUNTIME: "1",
          HTTP_PROXY: "http://srt:secret@localhost:54321",
          NO_PROXY: "localhost,127.0.0.1,::1",
        },
        "http://localhost:3000/api/health",
      ),
    ).toBe("http://srt:secret@localhost:54321/");
  });

  it("selects the proxy for the request protocol", () => {
    const env = {
      SANDBOX_RUNTIME: "1",
      HTTP_PROXY: "http://http-proxy.example:8080",
      HTTPS_PROXY: "http://https-proxy.example:8443",
    };

    expect(resolveSandboxProxyUrl(env, "http://cc.internal/api")).toBe(
      "http://http-proxy.example:8080/",
    );
    expect(resolveSandboxProxyUrl(env, "https://cc.internal/api")).toBe(
      "http://https-proxy.example:8443/",
    );
    expect(
      resolveSandboxProxyUrl(
        {
          SANDBOX_RUNTIME: "1",
          HTTPS_PROXY: "http://https-proxy.example:8443",
        },
        "http://cc.internal/api",
      ),
    ).toBeNull();
  });

  it("falls back past empty, malformed, and unsupported preferred values", () => {
    expect(
      resolveSandboxProxyUrl(
        {
          SANDBOX_RUNTIME: "1",
          HTTPS_PROXY: "not a URL",
          https_proxy: "socks5://localhost:9999",
          HTTP_PROXY: "",
          http_proxy: "http://fallback.example:8080",
        },
        "https://cc.internal/api",
      ),
    ).toBe("http://fallback.example:8080/");
  });

  it("does not change ordinary cctl networking outside the sandbox", () => {
    expect(
      resolveSandboxProxyUrl(
        {
          HTTP_PROXY: "http://proxy.example:8080",
        },
        "http://localhost:3000/api/health",
      ),
    ).toBeNull();
  });

  it("refuses malformed request URLs and non-HTTP proxy values", () => {
    expect(
      resolveSandboxProxyUrl(
        {
          SANDBOX_RUNTIME: "1",
          HTTP_PROXY: "http://proxy.example:8080",
        },
        "not a URL",
      ),
    ).toBeNull();
    expect(
      resolveSandboxProxyUrl(
        {
          SANDBOX_RUNTIME: "1",
          HTTP_PROXY: "socks5://localhost:54321",
        },
        "http://localhost:3000/api/health",
      ),
    ).toBeNull();
  });
});
