import { randomUUID } from "node:crypto";

const bearerToken = randomUUID();

export function getMcpGatewayBearerToken(): string {
  return bearerToken;
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
