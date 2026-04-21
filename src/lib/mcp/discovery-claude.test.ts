import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverClaudeSources } from "./discovery-claude";

describe("mcp/discovery-claude", () => {
  let tmp: string;
  let worktreePath: string;
  let homePath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "mcp-discover-claude-"));
    worktreePath = path.join(tmp, "worktree");
    homePath = path.join(tmp, "home");
    await mkdir(worktreePath, { recursive: true });
    await mkdir(homePath, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("parses project-scope .mcp.json as stdio and http servers", async () => {
    await writeFile(
      path.join(worktreePath, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "next-devtools": {
            command: "npx",
            args: ["-y", "next-devtools-mcp@latest"],
          },
          "remote-http": {
            type: "http",
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer s3cret" },
          },
        },
      }),
    );

    const result = await discoverClaudeSources({ worktreePath, homePath });

    const errorDiagnostics = result.diagnostics.filter(
      (d) => d.severity === "error",
    );
    expect(errorDiagnostics).toEqual([]);
    const keys = result.servers.map((s) => s.serverKey).sort();
    expect(keys).toEqual(["next-devtools", "remote-http"]);

    const stdio = result.servers.find((s) => s.serverKey === "next-devtools");
    expect(stdio?.config).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "next-devtools-mcp@latest"],
    });
    expect(stdio?.sourceRefs).toEqual([
      {
        backend: "claude",
        scope: "project",
        filePath: path.join(worktreePath, ".mcp.json"),
      },
    ]);
    expect(stdio?.backend).toBe("claude");
    expect(stdio?.reserved).toBe(false);
    expect(stdio?.configSignature).toMatch(/^[0-9a-f]{8,}$/);

    const http = result.servers.find((s) => s.serverKey === "remote-http");
    expect(http?.config).toEqual({
      transport: "streamable-http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer s3cret" },
    });
  });

  it("tags project-scope .claude/settings.json entries and local settings", async () => {
    await mkdir(path.join(worktreePath, ".claude"), { recursive: true });
    await writeFile(
      path.join(worktreePath, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          "from-settings": { command: "my-cmd" },
        },
      }),
    );
    await writeFile(
      path.join(worktreePath, ".claude", "settings.local.json"),
      JSON.stringify({
        mcpServers: {
          "from-local": { command: "local-cmd" },
        },
      }),
    );

    const result = await discoverClaudeSources({ worktreePath, homePath });

    const byKey = new Map(result.servers.map((s) => [s.serverKey, s]));
    expect(byKey.get("from-settings")?.sourceRefs[0]).toMatchObject({
      scope: "project",
      filePath: path.join(worktreePath, ".claude", "settings.json"),
    });
    expect(byKey.get("from-local")?.sourceRefs[0]).toMatchObject({
      scope: "local",
      filePath: path.join(worktreePath, ".claude", "settings.local.json"),
    });
  });

  it("tags user-scope ~/.claude/settings.json entries", async () => {
    await mkdir(path.join(homePath, ".claude"), { recursive: true });
    await writeFile(
      path.join(homePath, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          "user-server": { command: "global-cmd" },
        },
      }),
    );

    const result = await discoverClaudeSources({ worktreePath, homePath });

    const server = result.servers.find((s) => s.serverKey === "user-server");
    expect(server?.sourceRefs[0]).toMatchObject({
      scope: "user",
      filePath: path.join(homePath, ".claude", "settings.json"),
    });
  });

  it("reports info-severity diagnostics for each missing source file", async () => {
    const result = await discoverClaudeSources({ worktreePath, homePath });

    expect(result.servers).toEqual([]);

    const missingDiagnostics = result.diagnostics.filter(
      (d) => d.code === "mcp.source.missing",
    );
    expect(missingDiagnostics).toHaveLength(result.sourceFiles.length);
    expect(missingDiagnostics.every((d) => d.severity === "info")).toBe(true);
    expect(
      missingDiagnostics.every((d) => d.sourceRef?.backend === "claude"),
    ).toBe(true);

    const pathsByStatus = result.sourceFiles
      .filter((f) => f.status === "missing")
      .map((f) => path.basename(f.filePath))
      .sort();
    expect(pathsByStatus).toEqual(
      [
        "settings.json",
        "settings.json",
        "settings.local.json",
        ".mcp.json",
      ].sort(),
    );
  });

  it("surfaces a diagnostic for a malformed JSON file and keeps valid files", async () => {
    await writeFile(path.join(worktreePath, ".mcp.json"), "{ not valid json");
    await mkdir(path.join(worktreePath, ".claude"), { recursive: true });
    await writeFile(
      path.join(worktreePath, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { good: { command: "ok" } } }),
    );

    const result = await discoverClaudeSources({ worktreePath, homePath });

    expect(result.servers.map((s) => s.serverKey)).toEqual(["good"]);

    const mcpStatus = result.sourceFiles.find(
      (f) => f.filePath === path.join(worktreePath, ".mcp.json"),
    );
    expect(mcpStatus?.status).toBe("malformed");

    const diag = result.diagnostics.find(
      (d) => d.sourceRef?.filePath === path.join(worktreePath, ".mcp.json"),
    );
    expect(diag?.severity).toBe("error");
    expect(diag?.code).toBe("mcp.source.parse-error");
  });

  it("ignores files that have no mcpServers section", async () => {
    await mkdir(path.join(worktreePath, ".claude"), { recursive: true });
    await writeFile(
      path.join(worktreePath, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Read"] } }),
    );

    const result = await discoverClaudeSources({ worktreePath, homePath });

    expect(result.servers).toEqual([]);
    const status = result.sourceFiles.find(
      (f) => f.filePath === path.join(worktreePath, ".claude", "settings.json"),
    );
    expect(status?.status).toBe("empty");
    expect(status?.serverCount).toBe(0);
  });

  it("produces stable configSignatures across runs", async () => {
    const contents = {
      mcpServers: {
        one: {
          command: "cmd",
          args: ["--flag", "value"],
          env: { TOKEN: "abc" },
        },
      },
    };
    await writeFile(
      path.join(worktreePath, ".mcp.json"),
      JSON.stringify(contents),
    );

    const first = await discoverClaudeSources({ worktreePath, homePath });
    const second = await discoverClaudeSources({ worktreePath, homePath });

    expect(first.servers[0]?.configSignature).toBe(
      second.servers[0]?.configSignature,
    );
  });

  it("adds per-server diagnostics and skips servers with unknown transport", async () => {
    await writeFile(
      path.join(worktreePath, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "bad-type": { type: "banana", command: "x" },
          "good-stdio": { command: "ok" },
        },
      }),
    );

    const result = await discoverClaudeSources({ worktreePath, homePath });

    expect(result.servers.map((s) => s.serverKey)).toEqual(["good-stdio"]);
    expect(
      result.diagnostics.find((d) => d.code === "mcp.source.unknown-transport")
        ?.serverKey,
    ).toBe("bad-type");
  });

  it("does not expose env/header values through public sourceFiles or diagnostics", async () => {
    await writeFile(
      path.join(worktreePath, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "with-secrets": {
            command: "cmd",
            env: { SECRET: "top-secret-value" },
          },
        },
      }),
    );

    const result = await discoverClaudeSources({ worktreePath, homePath });
    const serialized = JSON.stringify({
      diagnostics: result.diagnostics,
      sourceFiles: result.sourceFiles,
    });
    expect(serialized).not.toContain("top-secret-value");
  });

  it("sanitizes malformed-JSON diagnostics so source excerpts with secrets do not leak", async () => {
    // A malformed JSON where the raw source (which a naive parser error might
    // quote) contains a secret-looking header value.
    await writeFile(
      path.join(worktreePath, ".mcp.json"),
      `{
  "mcpServers": {
    "remote": {
      "type": "http",
      "url": "https://example.test/mcp",
      "headers": { "Authorization": "Bearer shh-do-not-leak-me"
    }
  }
`,
    );

    const result = await discoverClaudeSources({ worktreePath, homePath });
    const diag = result.diagnostics.find(
      (d) => d.code === "mcp.source.parse-error",
    );
    expect(diag).toBeDefined();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("shh-do-not-leak-me");
    expect(serialized).not.toContain("Bearer");
  });
});
