import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetLoggerForTesting } from "@/lib/logging/logger";

import { discoverCommandCenterSources } from "./discovery-command-center";

describe("mcp/discovery-command-center", () => {
  let tmp: string;
  let configDir: string;
  let worktreePath: string;
  let globalConfigPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "mcp-discover-cc-"));
    configDir = path.join(tmp, "cc-config");
    worktreePath = path.join(tmp, "worktree");
    await mkdir(configDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    globalConfigPath = path.join(configDir, ".mcp.json");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeGlobal(map: Record<string, unknown>): Promise<void> {
    await writeFile(globalConfigPath, JSON.stringify({ mcpServers: map }));
  }

  async function writeProject(map: Record<string, unknown>): Promise<void> {
    await writeFile(
      path.join(worktreePath, ".mcp.json"),
      JSON.stringify({ mcpServers: map }),
    );
  }

  it("(a) reads <configDir>/.mcp.json as servers with sourceRefs scope 'global'", async () => {
    await writeGlobal({
      "global-server": {
        command: "global-cmd",
        args: ["--flag"],
      },
    });

    const result = await discoverCommandCenterSources({ globalConfigPath });

    expect(result.servers.map((s) => s.serverKey)).toEqual(["global-server"]);
    const server = result.servers[0];
    expect(server?.sourceRefs).toEqual([
      { scope: "global", filePath: globalConfigPath },
    ]);
    expect(server?.config).toEqual({
      transport: "stdio",
      command: "global-cmd",
      args: ["--flag"],
    });
  });

  it("(b) reads <worktreePath>/.mcp.json as servers with sourceRefs scope 'project'", async () => {
    await writeProject({
      "project-server": {
        command: "project-cmd",
      },
    });

    const result = await discoverCommandCenterSources({
      globalConfigPath,
      worktreePath,
    });

    const server = result.servers.find((s) => s.serverKey === "project-server");
    expect(server).toBeDefined();
    expect(server?.sourceRefs).toEqual([
      {
        scope: "project",
        filePath: path.join(worktreePath, ".mcp.json"),
      },
    ]);
  });

  it("(c) project definition wins for same-key conflict; winning sourceRefs contain only the project file", async () => {
    await writeGlobal({
      shared: { command: "global-cmd", args: ["--global"] },
    });
    await writeProject({
      shared: { command: "project-cmd", args: ["--project"] },
    });

    const result = await discoverCommandCenterSources({
      globalConfigPath,
      worktreePath,
    });

    const winners = result.servers.filter((s) => s.serverKey === "shared");
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    expect(winner?.config).toEqual({
      transport: "stdio",
      command: "project-cmd",
      args: ["--project"],
    });
    expect(winner?.sourceRefs).toEqual([
      {
        scope: "project",
        filePath: path.join(worktreePath, ".mcp.json"),
      },
    ]);
  });

  it("(d) missing global file produces info diagnostic 'mcp.source.missing' but project file still contributes servers", async () => {
    // No global file written.
    await writeProject({
      "project-only": { command: "p" },
    });

    const result = await discoverCommandCenterSources({
      globalConfigPath,
      worktreePath,
    });

    expect(result.servers.map((s) => s.serverKey)).toEqual(["project-only"]);
    const missingDiag = result.diagnostics.find(
      (d) => d.code === "mcp.source.missing",
    );
    expect(missingDiag?.severity).toBe("info");
    expect(missingDiag?.sourceRef?.filePath).toBe(globalConfigPath);
    expect(missingDiag?.sourceRef?.scope).toBe("global");

    const globalStatus = result.sourceFiles.find(
      (f) => f.filePath === globalConfigPath,
    );
    expect(globalStatus?.status).toBe("missing");
    expect(globalStatus?.serverCount).toBe(0);
  });

  it("(e) malformed global JSON produces 'mcp.source.parse-error' error and does not block project parsing", async () => {
    await writeFile(globalConfigPath, "{ this is not: valid json");
    await writeProject({
      good: { command: "good-cmd" },
    });

    const result = await discoverCommandCenterSources({
      globalConfigPath,
      worktreePath,
    });

    expect(result.servers.map((s) => s.serverKey)).toEqual(["good"]);
    const parseError = result.diagnostics.find(
      (d) => d.code === "mcp.source.parse-error",
    );
    expect(parseError?.severity).toBe("error");
    expect(parseError?.sourceRef?.filePath).toBe(globalConfigPath);

    const globalStatus = result.sourceFiles.find(
      (f) => f.filePath === globalConfigPath,
    );
    expect(globalStatus?.status).toBe("malformed");
  });

  it("(f) invalid single server entry produces 'mcp.source.invalid-entry' and skips only that server", async () => {
    await writeProject({
      ok: { command: "ok-cmd" },
      broken: { type: "stdio" }, // stdio missing command
    });

    const result = await discoverCommandCenterSources({
      globalConfigPath,
      worktreePath,
    });

    expect(result.servers.map((s) => s.serverKey)).toEqual(["ok"]);
    const invalidDiag = result.diagnostics.find(
      (d) => d.code === "mcp.source.invalid-entry",
    );
    expect(invalidDiag?.severity).toBe("error");
    expect(invalidDiag?.serverKey).toBe("broken");
  });

  it("(g) diagnostics do not leak env values, header values, credentialed URLs, parse excerpts, or full entries", async () => {
    // Set up a global file with a secret env, a project file that's malformed
    // and contains a bearer token and a credentialed URL.
    await writeGlobal({
      "with-env": {
        command: "cmd",
        env: { SECRET_TOKEN: "top-secret-env-value" },
      },
    });
    await writeFile(
      path.join(worktreePath, ".mcp.json"),
      `{
  "mcpServers": {
    "remote": {
      "type": "http",
      "url": "https://user:super-secret-password@example.test/mcp",
      "headers": { "Authorization": "Bearer do-not-leak-me-bearer"
    }
  }
`,
    );

    const result = await discoverCommandCenterSources({
      globalConfigPath,
      worktreePath,
    });

    const serialized = JSON.stringify({
      diagnostics: result.diagnostics,
      sourceFiles: result.sourceFiles,
    });

    expect(serialized).not.toContain("top-secret-env-value");
    expect(serialized).not.toContain("super-secret-password");
    expect(serialized).not.toContain("do-not-leak-me-bearer");
    expect(serialized).not.toContain("Bearer");
    // The raw parse excerpt (including keys like "Authorization" from the bad
    // JSON source) must not be echoed into diagnostics.
    expect(serialized).not.toContain("Authorization");
  });

  it("parses streamable-http (type: 'http') and sse entries with headers", async () => {
    await writeProject({
      "http-server": {
        type: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer abc" },
      },
      "sse-server": {
        type: "sse",
        url: "https://example.test/sse",
      },
    });

    const result = await discoverCommandCenterSources({
      globalConfigPath,
      worktreePath,
    });

    const http = result.servers.find((s) => s.serverKey === "http-server");
    expect(http?.transport).toBe("streamable-http");
    expect(http?.config).toEqual({
      transport: "streamable-http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer abc" },
    });

    const sse = result.servers.find((s) => s.serverKey === "sse-server");
    expect(sse?.transport).toBe("sse");
    expect(sse?.config).toEqual({
      transport: "sse",
      url: "https://example.test/sse",
    });
  });

  it("emits 'mcp.source.unknown-transport' for an entry with an unknown type", async () => {
    await writeProject({
      weird: { type: "banana", url: "https://x" },
      good: { command: "ok" },
    });

    const result = await discoverCommandCenterSources({
      globalConfigPath,
      worktreePath,
    });

    expect(result.servers.map((s) => s.serverKey)).toEqual(["good"]);
    const diag = result.diagnostics.find(
      (d) => d.code === "mcp.source.unknown-transport",
    );
    expect(diag?.serverKey).toBe("weird");
    expect(diag?.severity).toBe("error");
  });

  it("does not read the project file when worktreePath is not provided", async () => {
    await writeGlobal({
      "global-only": { command: "g" },
    });
    await writeProject({
      "project-only": { command: "p" },
    });

    const result = await discoverCommandCenterSources({ globalConfigPath });

    expect(result.servers.map((s) => s.serverKey)).toEqual(["global-only"]);
    const filePaths = new Set(result.sourceFiles.map((f) => f.filePath));
    expect(filePaths.has(path.join(worktreePath, ".mcp.json"))).toBe(false);
  });

  it("produces stable configSignatures across runs", async () => {
    await writeProject({
      one: {
        command: "cmd",
        args: ["--flag", "value"],
        env: { TOKEN: "abc" },
      },
    });

    const first = await discoverCommandCenterSources({
      globalConfigPath,
      worktreePath,
    });
    const second = await discoverCommandCenterSources({
      globalConfigPath,
      worktreePath,
    });

    expect(first.servers[0]?.configSignature).toBe(
      second.servers[0]?.configSignature,
    );
    expect(first.servers[0]?.configSignature).toMatch(/^[0-9a-f]{8,}$/);
  });

  it("reports an empty source file (no diagnostic) when the file has no mcpServers key", async () => {
    await writeFile(
      globalConfigPath,
      JSON.stringify({ other: { stuff: true } }),
    );

    const result = await discoverCommandCenterSources({ globalConfigPath });

    expect(result.servers).toEqual([]);
    const status = result.sourceFiles.find(
      (f) => f.filePath === globalConfigPath,
    );
    expect(status?.status).toBe("empty");
    expect(status?.serverCount).toBe(0);
    const missingOrError = result.diagnostics.find(
      (d) =>
        d.code === "mcp.source.missing" || d.code === "mcp.source.parse-error",
    );
    expect(missingOrError).toBeUndefined();
  });

  describe("(g) per-diagnostic sanitization — invalid-entry and unknown-transport", () => {
    it("invalid-entry diagnostic does not leak env values, header values, or credentialed URLs from the offending entry", async () => {
      // Entry is invalid because the stdio `command` is not a string; it also
      // carries a secret-looking env map, a header with a bearer token, and a
      // credentialed URL. None of those values may appear in the diagnostic.
      await writeProject({
        "invalid-stdio": {
          command: 42,
          env: { SUPER_SECRET: "shh-env-value" },
          headers: { Authorization: "Bearer do-not-leak-bearer" },
          url: "https://user:leak-password@example.test/mcp",
        },
      });

      const result = await discoverCommandCenterSources({
        globalConfigPath,
        worktreePath,
      });

      const diag = result.diagnostics.find(
        (d) => d.code === "mcp.source.invalid-entry",
      );
      expect(diag).toBeDefined();
      expect(diag?.serverKey).toBe("invalid-stdio");

      const serialized = JSON.stringify(diag);
      expect(serialized).not.toContain("shh-env-value");
      expect(serialized).not.toContain("do-not-leak-bearer");
      expect(serialized).not.toContain("leak-password");
      // Full entry shape must not be echoed either.
      expect(serialized).not.toContain("SUPER_SECRET");
      expect(serialized).not.toContain("Authorization");
      expect(serialized).not.toContain("Bearer");
    });

    it("unknown-transport diagnostic does not echo the raw `type` value when it contains secret-like content", async () => {
      // Abusive config: `type` is set to a credential-bearing URL. A naive
      // `Unknown transport "${type}"` message would leak the URL.
      await writeProject({
        weird: {
          type: "https://user:leak-password@evil.test/steal",
          url: "https://x",
        },
      });

      const result = await discoverCommandCenterSources({
        globalConfigPath,
        worktreePath,
      });

      const diag = result.diagnostics.find(
        (d) => d.code === "mcp.source.unknown-transport",
      );
      expect(diag).toBeDefined();
      expect(diag?.serverKey).toBe("weird");

      const serialized = JSON.stringify(diag);
      expect(serialized).not.toContain("leak-password");
      expect(serialized).not.toContain("evil.test");
      expect(serialized).not.toContain("https://");
    });
  });

  describe("(g) structured log sanitization — cc.discovery.complete and cc.source.* never contain secret-like values", () => {
    const originalLogFile = process.env["CC_LOG_FILE"];
    const originalLogLevel = process.env["CC_LOG_LEVEL"];
    const originalLogSilent = process.env["CC_LOG_SILENT"];
    let logFilePath: string;

    beforeEach(() => {
      logFilePath = path.join(tmp, "cc-discovery-test.log");
      process.env["CC_LOG_FILE"] = logFilePath;
      process.env["CC_LOG_LEVEL"] = "debug";
      delete process.env["CC_LOG_SILENT"];
      _resetLoggerForTesting();
    });

    afterEach(() => {
      _resetLoggerForTesting();
      if (originalLogFile !== undefined) {
        process.env["CC_LOG_FILE"] = originalLogFile;
      } else {
        delete process.env["CC_LOG_FILE"];
      }
      if (originalLogLevel !== undefined) {
        process.env["CC_LOG_LEVEL"] = originalLogLevel;
      } else {
        delete process.env["CC_LOG_LEVEL"];
      }
      if (originalLogSilent !== undefined) {
        process.env["CC_LOG_SILENT"] = originalLogSilent;
      } else {
        delete process.env["CC_LOG_SILENT"];
      }
    });

    function readLogContent(): string {
      if (!existsSync(logFilePath)) return "";
      return readFileSync(logFilePath, "utf-8");
    }

    it("structured logs emitted across malformed, invalid-entry, and unknown-transport paths contain no env/header values or credentialed URLs", async () => {
      // Malformed global file carrying a bearer token and credentialed URL.
      await writeFile(
        globalConfigPath,
        `{
  "mcpServers": {
    "remote": {
      "type": "http",
      "url": "https://user:log-leak-password@example.test/mcp",
      "headers": { "Authorization": "Bearer log-leak-bearer"
    }
  }
`,
      );
      // Project file carrying an invalid entry with an env secret + an
      // unknown-transport entry whose `type` is a credentialed URL.
      await writeProject({
        "invalid-stdio": {
          command: 99,
          env: { SECRET_ENV: "log-leak-env-value" },
        },
        weird: {
          type: "https://user:log-leak-type-password@evil.test/steal",
          url: "https://x",
        },
      });

      await discoverCommandCenterSources({
        globalConfigPath,
        worktreePath,
      });

      const logContent = readLogContent();

      // Sanity check: the logger actually wrote something for this run.
      expect(logContent).toContain("mcp.source-discovery");

      // None of the raw secrets from any source should appear in the log.
      expect(logContent).not.toContain("log-leak-password");
      expect(logContent).not.toContain("log-leak-bearer");
      expect(logContent).not.toContain("log-leak-env-value");
      expect(logContent).not.toContain("log-leak-type-password");
      expect(logContent).not.toContain("Authorization");
      expect(logContent).not.toContain("Bearer");
      expect(logContent).not.toContain("SECRET_ENV");
      // Raw JSON parse excerpts must not leak into structured log fields.
      expect(logContent).not.toContain("example.test");
      expect(logContent).not.toContain("evil.test");
    });
  });
});
