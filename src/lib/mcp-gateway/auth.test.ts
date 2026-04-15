import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("mcp-gateway/auth", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns the same bearer token across calls in one process", async () => {
    const { getMcpGatewayBearerToken } = await import("./auth");

    expect(getMcpGatewayBearerToken()).toBe(getMcpGatewayBearerToken());
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
