import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

declare global {
  // Used by auth.ts to hold the process-wide bearer token across HMR reloads.
  // Listed here so the test can clean it up between cases.
  // eslint-disable-next-line no-var
  var __ccMcpGatewayBearerToken: string | undefined;
}

describe("workflow-draft/auth", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    delete globalThis.__ccMcpGatewayBearerToken;
    vi.resetModules();
  });

  it("returns the same bearer token across calls in one process", async () => {
    const { getMcpGatewayBearerToken } = await import("./auth");

    expect(getMcpGatewayBearerToken()).toBe(getMcpGatewayBearerToken());
  });

  it("preserves the bearer token across module reloads", async () => {
    const first = await import("./auth");
    const tokenBeforeReload = first.getMcpGatewayBearerToken();

    vi.resetModules();
    const second = await import("./auth");
    const tokenAfterReload = second.getMcpGatewayBearerToken();

    expect(tokenAfterReload).toBe(tokenBeforeReload);

    const request = new Request("http://localhost/api/test", {
      headers: { Authorization: `Bearer ${tokenBeforeReload}` },
    });
    expect(() => second.assertGatewayAuthorization(request)).not.toThrow();
  });

  it("builds authorization headers with the bearer token", async () => {
    const { buildGatewayAuthHeaders, getMcpGatewayBearerToken } =
      await import("./auth");

    expect(buildGatewayAuthHeaders()).toEqual({
      Authorization: `Bearer ${getMcpGatewayBearerToken()}`,
    });
  });

  it("accepts requests with the correct bearer token", async () => {
    const { assertGatewayAuthorization, getMcpGatewayBearerToken } =
      await import("./auth");

    const request = new Request("http://localhost/api/test", {
      headers: {
        Authorization: `Bearer ${getMcpGatewayBearerToken()}`,
      },
    });

    expect(() => assertGatewayAuthorization(request)).not.toThrow();
  });

  it("rejects requests with no authorization header", async () => {
    const { assertGatewayAuthorization } = await import("./auth");

    const request = new Request("http://localhost/api/test");

    expect(() => assertGatewayAuthorization(request)).toThrow(
      "Unauthorized MCP gateway request",
    );
  });

  it("rejects requests with the wrong bearer token", async () => {
    const { assertGatewayAuthorization } = await import("./auth");

    const request = new Request("http://localhost/api/test", {
      headers: {
        Authorization: "Bearer wrong-token",
      },
    });

    expect(() => assertGatewayAuthorization(request)).toThrow(
      "Unauthorized MCP gateway request",
    );
  });
});
