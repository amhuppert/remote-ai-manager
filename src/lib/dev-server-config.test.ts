import { describe, it, expect } from "vitest";
import {
  normalizeDevServerConfig,
  type NormalizedDevServerConfig,
} from "./dev-server-config";
import { devServerConfigSchema, perRepoConfigSchema } from "./schemas";

describe("devServerConfigSchema (legacy compatibility)", () => {
  it("parses the legacy { name, command } shape", () => {
    const parsed = devServerConfigSchema.parse({
      name: "nextjs",
      command: ".cc/dev-servers/nextjs.sh",
    });
    expect(parsed.name).toBe("nextjs");
    expect(parsed.command).toBe(".cc/dev-servers/nextjs.sh");
  });

  it("parses inside perRepoConfigSchema unchanged", () => {
    const parsed = perRepoConfigSchema.parse({
      devServers: [{ name: "nextjs", command: ".cc/dev-servers/nextjs.sh" }],
    });
    expect(parsed.devServers).toHaveLength(1);
    expect(parsed.devServers?.[0]?.name).toBe("nextjs");
  });
});

describe("devServerConfigSchema (cc-assigned port config)", () => {
  it("parses a full cc-assigned config", () => {
    const parsed = devServerConfigSchema.parse({
      name: "web",
      command: "bun run dev -- --port $CC_ASSIGNED_PORT",
      cwd: ".",
      port: {
        strategy: "cc-assigned",
        base: 3000,
        range: 100,
        env: "CC_ASSIGNED_PORT",
      },
      readiness: {
        type: "tcp",
        timeoutMs: 60000,
      },
    });
    expect(parsed.cwd).toBe(".");
    expect(parsed.port?.strategy).toBe("cc-assigned");
    expect(parsed.port?.base).toBe(3000);
    expect(parsed.port?.range).toBe(100);
    expect(parsed.port?.env).toBe("CC_ASSIGNED_PORT");
    expect(parsed.readiness?.type).toBe("tcp");
    expect(parsed.readiness?.timeoutMs).toBe(60000);
  });

  it("parses an explicit stdout-cc-port strategy with port hint", () => {
    const parsed = devServerConfigSchema.parse({
      name: "custom",
      command: ".cc/dev-servers/custom.sh",
      port: { strategy: "stdout-cc-port", base: 8080, range: 50 },
    });
    expect(parsed.port?.strategy).toBe("stdout-cc-port");
    expect(parsed.port?.base).toBe(8080);
    expect(parsed.port?.range).toBe(50);
  });

  it("rejects port.base below 1", () => {
    expect(() =>
      devServerConfigSchema.parse({
        name: "web",
        command: "x",
        port: { strategy: "cc-assigned", base: 0, range: 100 },
      }),
    ).toThrow();
  });

  it("rejects port.base above 65535", () => {
    expect(() =>
      devServerConfigSchema.parse({
        name: "web",
        command: "x",
        port: { strategy: "cc-assigned", base: 70000, range: 100 },
      }),
    ).toThrow();
  });

  it("rejects non-positive port.range", () => {
    expect(() =>
      devServerConfigSchema.parse({
        name: "web",
        command: "x",
        port: { strategy: "cc-assigned", base: 3000, range: 0 },
      }),
    ).toThrow();
  });

  it("rejects cc-assigned without a base port", () => {
    expect(() =>
      devServerConfigSchema.parse({
        name: "web",
        command: "x",
        port: { strategy: "cc-assigned" },
      }),
    ).toThrow();
  });

  it("rejects port range that would exceed the 16-bit ceiling", () => {
    expect(() =>
      devServerConfigSchema.parse({
        name: "web",
        command: "x",
        port: { strategy: "cc-assigned", base: 65500, range: 200 },
      }),
    ).toThrow();
  });
});

describe("normalizeDevServerConfig", () => {
  it("normalizes legacy { name, command } to stdout-cc-port with no port hint", () => {
    const result: NormalizedDevServerConfig = normalizeDevServerConfig({
      name: "nextjs",
      command: ".cc/dev-servers/nextjs.sh",
    });
    expect(result.name).toBe("nextjs");
    expect(result.command).toBe(".cc/dev-servers/nextjs.sh");
    expect(result.cwd).toBeNull();
    expect(result.port.strategy).toBe("stdout-cc-port");
    expect(result.port.base).toBeNull();
    expect(result.port.envAlias).toBeNull();
    expect(result.readiness.type).toBe("stdout-cc-port");
  });

  it("normalizes a cc-assigned config and applies range default of 100", () => {
    const result = normalizeDevServerConfig({
      name: "web",
      command: "bun run dev -- --port $CC_ASSIGNED_PORT",
      port: { strategy: "cc-assigned", base: 3000, env: "MY_PORT" },
    });
    expect(result.port.strategy).toBe("cc-assigned");
    expect(result.port.base).toBe(3000);
    expect(result.port.range).toBe(100);
    expect(result.port.envAlias).toBe("MY_PORT");
    expect(result.readiness.type).toBe("tcp");
    expect(result.readiness.timeoutMs).toBeGreaterThan(0);
  });

  it("preserves an explicit readiness override on a cc-assigned config", () => {
    const result = normalizeDevServerConfig({
      name: "web",
      command: "bun run dev",
      port: { strategy: "cc-assigned", base: 3000, range: 50 },
      readiness: { type: "tcp", timeoutMs: 10000 },
    });
    expect(result.readiness.timeoutMs).toBe(10000);
  });

  it("keeps stdout-cc-port readiness when an explicit stdout strategy supplies port hints", () => {
    const result = normalizeDevServerConfig({
      name: "custom",
      command: ".cc/dev-servers/custom.sh",
      port: { strategy: "stdout-cc-port", base: 4000, range: 25 },
    });
    expect(result.port.strategy).toBe("stdout-cc-port");
    expect(result.port.base).toBe(4000);
    expect(result.port.range).toBe(25);
    expect(result.readiness.type).toBe("stdout-cc-port");
  });

  it("returns the provided cwd verbatim", () => {
    const result = normalizeDevServerConfig({
      name: "web",
      command: "bun run dev",
      cwd: "apps/web",
      port: { strategy: "cc-assigned", base: 3000 },
    });
    expect(result.cwd).toBe("apps/web");
  });
});
