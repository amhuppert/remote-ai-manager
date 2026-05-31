import { describe, it, expect } from "vitest";
import {
  normalizeDevServerConfig,
  type NormalizedDevServerConfig,
} from "./config";
import { devServerConfigSchema } from "./schemas";
import { perRepoConfigSchema } from "../config/schemas";

describe("devServerConfigSchema", () => {
  it("requires the port block", () => {
    expect(() =>
      devServerConfigSchema.parse({
        name: "nextjs",
        command: "bun run dev",
      }),
    ).toThrow();
  });

  it("requires port.base", () => {
    expect(() =>
      devServerConfigSchema.parse({
        name: "nextjs",
        command: "bun run dev",
        port: { range: 100 },
      }),
    ).toThrow();
  });

  it("parses a full config", () => {
    const parsed = devServerConfigSchema.parse({
      name: "web",
      command: "bun run dev -- --port $CC_ASSIGNED_PORT",
      cwd: ".",
      port: { base: 3000, range: 100, env: "CC_ASSIGNED_PORT" },
    });
    expect(parsed.cwd).toBe(".");
    expect(parsed.port.base).toBe(3000);
    expect(parsed.port.range).toBe(100);
    expect(parsed.port.env).toBe("CC_ASSIGNED_PORT");
  });

  it("defaults port.range to 100 when omitted", () => {
    const parsed = devServerConfigSchema.parse({
      name: "web",
      command: "x",
      port: { base: 3000 },
    });
    expect(parsed.port.range).toBe(100);
  });

  it("parses inside perRepoConfigSchema", () => {
    const parsed = perRepoConfigSchema.parse({
      devServers: [
        { name: "nextjs", command: "bun run dev", port: { base: 3000 } },
      ],
    });
    expect(parsed.devServers).toHaveLength(1);
    expect(parsed.devServers?.[0]?.name).toBe("nextjs");
    expect(parsed.devServers?.[0]?.port.base).toBe(3000);
  });

  it("rejects port.base below 1", () => {
    expect(() =>
      devServerConfigSchema.parse({
        name: "web",
        command: "x",
        port: { base: 0 },
      }),
    ).toThrow();
  });

  it("rejects port.base above 65535", () => {
    expect(() =>
      devServerConfigSchema.parse({
        name: "web",
        command: "x",
        port: { base: 70000 },
      }),
    ).toThrow();
  });

  it("rejects non-positive port.range", () => {
    expect(() =>
      devServerConfigSchema.parse({
        name: "web",
        command: "x",
        port: { base: 3000, range: 0 },
      }),
    ).toThrow();
  });

  it("rejects port range that would exceed the 16-bit ceiling", () => {
    expect(() =>
      devServerConfigSchema.parse({
        name: "web",
        command: "x",
        port: { base: 65500, range: 200 },
      }),
    ).toThrow();
  });
});

describe("normalizeDevServerConfig", () => {
  it("normalizes a full config", () => {
    const result: NormalizedDevServerConfig = normalizeDevServerConfig({
      name: "web",
      command: "bun run dev -- --port $CC_ASSIGNED_PORT",
      port: { base: 3000, env: "MY_PORT" },
    });
    expect(result.name).toBe("web");
    expect(result.cwd).toBeNull();
    expect(result.port.base).toBe(3000);
    expect(result.port.range).toBe(100);
    expect(result.port.envAlias).toBe("MY_PORT");
    expect(result.readinessTimeoutMs).toBe(60_000);
  });

  it("returns the provided cwd verbatim", () => {
    const result = normalizeDevServerConfig({
      name: "web",
      command: "bun run dev",
      cwd: "apps/web",
      port: { base: 3000 },
    });
    expect(result.cwd).toBe("apps/web");
  });

  it("leaves envAlias null when env is omitted", () => {
    const result = normalizeDevServerConfig({
      name: "web",
      command: "bun run dev",
      port: { base: 3000 },
    });
    expect(result.port.envAlias).toBeNull();
  });
});
