import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverAllSources } from "./discovery";

describe("mcp/discovery", () => {
  let tmp: string;
  let worktreePath: string;
  let homePath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "mcp-discover-all-"));
    worktreePath = path.join(tmp, "worktree");
    homePath = path.join(tmp, "home");
    await mkdir(worktreePath, { recursive: true });
    await mkdir(homePath, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeClaudeProjectMcpJson(
    map: Record<string, unknown>,
  ): Promise<void> {
    await writeFile(
      path.join(worktreePath, ".mcp.json"),
      JSON.stringify({ mcpServers: map }),
    );
  }

  async function writeCodexUserToml(body: string): Promise<void> {
    await mkdir(path.join(homePath, ".codex"), { recursive: true });
    await writeFile(path.join(homePath, ".codex", "config.toml"), body);
  }

  it("returns combined servers tagged per backend and scope", async () => {
    await writeClaudeProjectMcpJson({
      "claude-only": { command: "claude-cmd" },
    });
    await writeCodexUserToml(`
[mcp_servers.codex-only]
command = "codex-cmd"
`);

    const result = await discoverAllSources({ worktreePath, homePath });

    const keys = result.servers.map((s) => s.serverKey).sort();
    expect(keys).toEqual(["claude-only", "codex-only"]);

    const claude = result.servers.find((s) => s.serverKey === "claude-only");
    const codex = result.servers.find((s) => s.serverKey === "codex-only");
    expect(claude?.backend).toBe("claude");
    expect(codex?.backend).toBe("codex");

    // sourceFiles covers both backends
    const backendsSeen = new Set(result.sourceFiles.map((f) => f.backend));
    expect(backendsSeen).toEqual(new Set(["claude", "codex"]));
  });

  it("coalesces equivalent Claude + Codex definitions into a single shared row", async () => {
    await writeClaudeProjectMcpJson({
      shared: {
        command: "my-shared-mcp",
        args: ["--flag", "value"],
      },
    });
    await writeCodexUserToml(`
[mcp_servers.shared]
command = "my-shared-mcp"
args = ["--flag", "value"]
`);

    const result = await discoverAllSources({ worktreePath, homePath });

    const shared = result.servers.filter((s) => s.serverKey === "shared");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.backend).toBe("shared");
    const refBackends = new Set(shared[0]?.sourceRefs.map((r) => r.backend));
    expect(refBackends).toEqual(new Set(["claude", "codex"]));
  });

  it("keeps distinct rows when non-secret canonical config diverges across backends", async () => {
    await writeClaudeProjectMcpJson({
      both: {
        command: "cmd-v1",
        args: ["--flag"],
      },
    });
    await writeCodexUserToml(`
[mcp_servers.both]
command = "cmd-v2"
args = ["--different"]
`);

    const result = await discoverAllSources({ worktreePath, homePath });

    const rows = result.servers.filter((s) => s.serverKey === "both");
    expect(rows).toHaveLength(2);
    const backends = new Set(rows.map((s) => s.backend));
    expect(backends).toEqual(new Set(["claude", "codex"]));
  });

  it("preserves native filter fields when coalescing only if non-secret config matches", async () => {
    await writeClaudeProjectMcpJson({
      shared: { command: "my-cmd", args: ["--x"] },
    });
    await writeCodexUserToml(`
[mcp_servers.shared]
command = "my-cmd"
args = ["--x"]
enabled = false
`);

    const result = await discoverAllSources({ worktreePath, homePath });
    const shared = result.servers.find((s) => s.serverKey === "shared");
    expect(shared?.backend).toBe("shared");
    // Codex-only native fields propagate onto the coalesced row so the
    // composer can still emit them for Codex.
    expect(shared?.native?.enabled).toBe(false);
  });

  it("merges diagnostics and sourceFiles from both backends", async () => {
    // Malformed Claude file
    await writeFile(path.join(worktreePath, ".mcp.json"), "{ bad");
    // Malformed Codex file
    await mkdir(path.join(worktreePath, ".codex"), { recursive: true });
    await writeFile(
      path.join(worktreePath, ".codex", "config.toml"),
      "[not-toml",
    );

    const result = await discoverAllSources({ worktreePath, homePath });

    const parseErrors = result.diagnostics.filter(
      (d) => d.code === "mcp.source.parse-error",
    );
    expect(parseErrors).toHaveLength(2);

    const malformedCount = result.sourceFiles.filter(
      (f) => f.status === "malformed",
    ).length;
    expect(malformedCount).toBe(2);
  });

  it("does not write to any discovered source file", async () => {
    await writeClaudeProjectMcpJson({ a: { command: "x" } });
    await writeCodexUserToml(`
[mcp_servers.b]
command = "y"
`);

    const mcpJsonPath = path.join(worktreePath, ".mcp.json");
    const codexPath = path.join(homePath, ".codex", "config.toml");
    const { readFile: readMcp, stat } = await import("node:fs/promises");
    const mcpBefore = await readMcp(mcpJsonPath, "utf-8");
    const codexBefore = await readMcp(codexPath, "utf-8");
    const mcpStatBefore = await stat(mcpJsonPath);
    const codexStatBefore = await stat(codexPath);

    await discoverAllSources({ worktreePath, homePath });

    const mcpAfter = await readMcp(mcpJsonPath, "utf-8");
    const codexAfter = await readMcp(codexPath, "utf-8");
    const mcpStatAfter = await stat(mcpJsonPath);
    const codexStatAfter = await stat(codexPath);

    expect(mcpAfter).toBe(mcpBefore);
    expect(codexAfter).toBe(codexBefore);
    expect(mcpStatAfter.mtimeMs).toBe(mcpStatBefore.mtimeMs);
    expect(codexStatAfter.mtimeMs).toBe(codexStatBefore.mtimeMs);
  });

  it("filters by backend when `backends` is provided", async () => {
    await writeClaudeProjectMcpJson({ "only-claude": { command: "c" } });
    await writeCodexUserToml(`
[mcp_servers.only-codex]
command = "c"
`);

    const claudeOnly = await discoverAllSources({
      worktreePath,
      homePath,
      backends: ["claude"],
    });
    expect(claudeOnly.servers.map((s) => s.serverKey)).toEqual(["only-claude"]);
    expect(claudeOnly.sourceFiles.every((f) => f.backend === "claude")).toBe(
      true,
    );

    const codexOnly = await discoverAllSources({
      worktreePath,
      homePath,
      backends: ["codex"],
    });
    expect(codexOnly.servers.map((s) => s.serverKey)).toEqual(["only-codex"]);
    expect(codexOnly.sourceFiles.every((f) => f.backend === "codex")).toBe(
      true,
    );
  });
});
