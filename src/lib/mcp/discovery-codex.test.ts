import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverCodexSources } from "./discovery-codex";

describe("mcp/discovery-codex", () => {
  let tmp: string;
  let worktreePath: string;
  let homePath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "mcp-discover-codex-"));
    worktreePath = path.join(tmp, "worktree");
    homePath = path.join(tmp, "home");
    await mkdir(worktreePath, { recursive: true });
    await mkdir(homePath, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("parses user-scope ~/.codex/config.toml into stdio canonical definitions", async () => {
    await mkdir(path.join(homePath, ".codex"), { recursive: true });
    await writeFile(
      path.join(homePath, ".codex", "config.toml"),
      `
model = "gpt-5"

[mcp_servers.cursor-shortcuts]
command = "cursor-shortcuts-mcp"
args = []

[mcp_servers.playwright]
command = "bunx"
args = ["@playwright/mcp@latest", "--headless"]
enabled = false
disabled_tools = ["browser_close"]
startup_timeout_sec = 10
tool_timeout_sec = 30
`,
    );

    const result = await discoverCodexSources({ worktreePath, homePath });

    const errorDiagnostics = result.diagnostics.filter(
      (d) => d.severity === "error",
    );
    expect(errorDiagnostics).toEqual([]);
    const keys = result.servers.map((s) => s.serverKey).sort();
    expect(keys).toEqual(["cursor-shortcuts", "playwright"]);

    const playwright = result.servers.find((s) => s.serverKey === "playwright");
    expect(playwright?.backend).toBe("codex");
    expect(playwright?.config).toEqual({
      transport: "stdio",
      command: "bunx",
      args: ["@playwright/mcp@latest", "--headless"],
      startupTimeoutSec: 10,
      toolTimeoutSec: 30,
    });
    expect(playwright?.native).toEqual({
      enabled: false,
      disabledTools: ["browser_close"],
    });
    expect(playwright?.sourceRefs[0]).toMatchObject({
      backend: "codex",
      scope: "user",
      filePath: path.join(homePath, ".codex", "config.toml"),
    });
    expect(playwright?.configSignature).toMatch(/^[0-9a-f]{8,}$/);
  });

  it("parses project-scope worktree .codex/config.toml as project scope", async () => {
    await mkdir(path.join(worktreePath, ".codex"), { recursive: true });
    await writeFile(
      path.join(worktreePath, ".codex", "config.toml"),
      `
[mcp_servers.project-server]
command = "npm"
args = ["start"]
`,
    );

    const result = await discoverCodexSources({ worktreePath, homePath });

    expect(result.servers.map((s) => s.serverKey)).toEqual(["project-server"]);
    expect(result.servers[0]?.sourceRefs[0]?.scope).toBe("project");
  });

  it("parses streamable http servers with bearer token env var", async () => {
    await mkdir(path.join(homePath, ".codex"), { recursive: true });
    await writeFile(
      path.join(homePath, ".codex", "config.toml"),
      `
[mcp_servers.remote]
url = "https://example.test/mcp"
bearer_token_env_var = "REMOTE_TOKEN"
enabled_tools = ["ping"]

[mcp_servers.remote.http_headers]
"X-Custom" = "value"
`,
    );

    const result = await discoverCodexSources({ worktreePath, homePath });

    const errorDiagnostics = result.diagnostics.filter(
      (d) => d.severity === "error",
    );
    expect(errorDiagnostics).toEqual([]);
    const remote = result.servers.find((s) => s.serverKey === "remote");
    expect(remote?.config).toEqual({
      transport: "streamable-http",
      url: "https://example.test/mcp",
      bearerTokenEnvVar: "REMOTE_TOKEN",
      headers: { "X-Custom": "value" },
    });
    expect(remote?.native).toEqual({ enabledTools: ["ping"] });
  });

  it("surfaces a diagnostic for malformed TOML and keeps other sources", async () => {
    await mkdir(path.join(worktreePath, ".codex"), { recursive: true });
    await writeFile(
      path.join(worktreePath, ".codex", "config.toml"),
      "[not toml",
    );
    await mkdir(path.join(homePath, ".codex"), { recursive: true });
    await writeFile(
      path.join(homePath, ".codex", "config.toml"),
      `
[mcp_servers.good]
command = "ok"
`,
    );

    const result = await discoverCodexSources({ worktreePath, homePath });

    expect(result.servers.map((s) => s.serverKey)).toEqual(["good"]);
    const diag = result.diagnostics.find(
      (d) => d.code === "mcp.source.parse-error",
    );
    expect(diag?.severity).toBe("error");
    expect(diag?.sourceRef?.filePath).toBe(
      path.join(worktreePath, ".codex", "config.toml"),
    );
    const status = result.sourceFiles.find(
      (f) => f.filePath === path.join(worktreePath, ".codex", "config.toml"),
    );
    expect(status?.status).toBe("malformed");
  });

  it("reports info-severity diagnostics for each missing Codex config", async () => {
    const result = await discoverCodexSources({ worktreePath, homePath });

    expect(result.servers).toEqual([]);
    const missing = result.diagnostics.filter(
      (d) => d.code === "mcp.source.missing",
    );
    expect(missing).toHaveLength(2);
    expect(missing.every((d) => d.severity === "info")).toBe(true);
    expect(missing.every((d) => d.sourceRef?.backend === "codex")).toBe(true);
  });

  it("skips a server with an invalid shape but keeps sibling servers", async () => {
    await mkdir(path.join(homePath, ".codex"), { recursive: true });
    await writeFile(
      path.join(homePath, ".codex", "config.toml"),
      `
[mcp_servers.bad]
# neither command nor url

[mcp_servers.good]
command = "ok"
`,
    );

    const result = await discoverCodexSources({ worktreePath, homePath });

    expect(result.servers.map((s) => s.serverKey)).toEqual(["good"]);
    const diag = result.diagnostics.find((d) => d.serverKey === "bad");
    expect(diag?.code).toBe("mcp.source.invalid-entry");
  });

  it("does not leak env values or headers through diagnostics/sourceFiles", async () => {
    await mkdir(path.join(homePath, ".codex"), { recursive: true });
    await writeFile(
      path.join(homePath, ".codex", "config.toml"),
      `
[mcp_servers.with-env]
command = "cmd"

[mcp_servers.with-env.env]
SECRET = "do-not-leak"
`,
    );

    const result = await discoverCodexSources({ worktreePath, homePath });
    const serialized = JSON.stringify({
      diagnostics: result.diagnostics,
      sourceFiles: result.sourceFiles,
    });
    expect(serialized).not.toContain("do-not-leak");
  });

  it("sanitizes malformed-TOML diagnostics so parser source excerpts with secrets do not leak", async () => {
    // smol-toml parse errors include a source excerpt ("codeblock") that
    // literally quotes offending input lines. If the malformed file has a
    // secret on the offending line, a naive `message = error.message` leaks it.
    await mkdir(path.join(homePath, ".codex"), { recursive: true });
    await writeFile(
      path.join(homePath, ".codex", "config.toml"),
      `[mcp_servers.bad.env]
SECRET = "top-secret-value-leak
`,
    );

    const result = await discoverCodexSources({ worktreePath, homePath });
    const diag = result.diagnostics.find(
      (d) => d.code === "mcp.source.parse-error",
    );
    expect(diag).toBeDefined();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("top-secret-value-leak");
  });

  it("sanitizes malformed-TOML diagnostics for bearer tokens in headers", async () => {
    await mkdir(path.join(homePath, ".codex"), { recursive: true });
    await writeFile(
      path.join(homePath, ".codex", "config.toml"),
      `[mcp_servers.remote]
http_headers = { Authorization = "Bearer super-secret-xyz"
`,
    );

    const result = await discoverCodexSources({ worktreePath, homePath });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("super-secret-xyz");
    expect(serialized).not.toContain("Bearer");
  });
});
