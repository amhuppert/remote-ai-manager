import { afterEach, expect, it } from "vitest";
import { startMcpRemoteFixture } from "@/lib/agent-backends/cursor/testing/mcp-remote-fixture";
import { createProductionMcpProbeClient } from "./tool-discovery-client";
import { createDirectToolProbe } from "./tool-discovery-probe";

const prior = process.env.CC_MCP_PROBE_BEARER;
afterEach(() => {
  if (prior === undefined) delete process.env.CC_MCP_PROBE_BEARER;
  else process.env.CC_MCP_PROBE_BEARER = prior;
});

it.each(["sse", "streamable-http"] as const)(
  "discovers authenticated %s with the configured bearer environment",
  async (transport) => {
    const fixture = await startMcpRemoteFixture(
      transport === "sse" ? "sse" : "http",
      { auth: true },
    );
    process.env.CC_MCP_PROBE_BEARER = "fixture-secret";
    try {
      const probe = createDirectToolProbe({
        createClient: createProductionMcpProbeClient,
      });
      const result = await probe({
        serverKey: "fixture",
        server: {
          transport,
          url: fixture.url,
          bearerTokenEnvVar: "CC_MCP_PROBE_BEARER",
        },
      });
      expect(result.state, JSON.stringify(result.diagnostics)).toBe("ready");
      expect(result.tools.map((tool) => tool.name)).toEqual([
        "allowed",
        "denied",
        "slow",
      ]);
    } finally {
      await fixture.close();
    }
  },
);
it("keeps an explicit lowercase authorization header authoritative", async () => {
  const fixture = await startMcpRemoteFixture("http", { auth: true });
  process.env.CC_MCP_PROBE_BEARER = "conflicting-token";
  try {
    const probe = createDirectToolProbe({
      createClient: createProductionMcpProbeClient,
    });
    const result = await probe({
      serverKey: "fixture",
      server: {
        transport: "streamable-http",
        url: fixture.url,
        headers: { authorization: "Bearer fixture-secret" },
        bearerTokenEnvVar: "CC_MCP_PROBE_BEARER",
      },
    });
    expect(result.state, JSON.stringify(result.diagnostics)).toBe("ready");
  } finally {
    await fixture.close();
  }
});

it("reports inventory authentication failures with an actionable credential-safe diagnostic", async () => {
  const fixture = await startMcpRemoteFixture("http", { auth: true });
  try {
    const probe = createDirectToolProbe({
      createClient: createProductionMcpProbeClient,
    });
    const result = await probe({
      serverKey: "fixture",
      server: { transport: "streamable-http", url: fixture.url },
    });
    expect(result.state).toBe("error");
    expect(result.diagnostics[0]?.message).toMatch(
      /authentication failed.*headers.*bearer/i,
    );
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  } finally {
    await fixture.close();
  }
});
