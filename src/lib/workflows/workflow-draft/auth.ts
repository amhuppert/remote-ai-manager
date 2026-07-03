import { randomUUID } from "node:crypto";

declare global {
  // Stored on globalThis so the token survives Next.js dev-mode HMR reloads
  // of this module. Without this, the route handler and the portable-MCP
  // header builder can end up with different tokens, causing every gateway
  // request to 401.
  // eslint-disable-next-line no-var
  var __ccMcpGatewayBearerToken: string | undefined;
}

function resolveBearerToken(): string {
  const existing = globalThis.__ccMcpGatewayBearerToken;
  if (existing) return existing;
  const fresh = randomUUID();
  globalThis.__ccMcpGatewayBearerToken = fresh;
  return fresh;
}

export function getMcpGatewayBearerToken(): string {
  return resolveBearerToken();
}

export function buildGatewayAuthHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getMcpGatewayBearerToken()}`,
  };
}

export function assertGatewayAuthorization(request: Request): void {
  const expected = buildGatewayAuthHeaders().Authorization;
  const actual = request.headers.get("Authorization");

  if (actual !== expected) {
    throw new Error("Unauthorized MCP gateway request");
  }
}
