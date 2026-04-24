import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverAllSources } from "./discovery";

describe("mcp/discovery (thin wrapper)", () => {
  let tmp: string;
  let configDir: string;
  let worktreePath: string;
  let globalConfigPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "mcp-discover-wrapper-"));
    configDir = path.join(tmp, "cc-config");
    worktreePath = path.join(tmp, "worktree");
    await mkdir(configDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    globalConfigPath = path.join(configDir, ".mcp.json");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("delegates to the unified discoverer and does not coalesce per-backend rows", async () => {
    await writeFile(
      globalConfigPath,
      JSON.stringify({
        mcpServers: { "global-one": { command: "g" } },
      }),
    );
    await writeFile(
      path.join(worktreePath, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "project-one": { command: "p" } },
      }),
    );

    const result = await discoverAllSources({
      globalConfigPath,
      worktreePath,
    });

    const keys = result.servers.map((s) => s.serverKey).sort();
    expect(keys).toEqual(["global-one", "project-one"]);

    const globalRow = result.servers.find((s) => s.serverKey === "global-one");
    const projectRow = result.servers.find(
      (s) => s.serverKey === "project-one",
    );
    expect(globalRow?.sourceRefs).toEqual([
      { scope: "global", filePath: globalConfigPath },
    ]);
    expect(projectRow?.sourceRefs).toEqual([
      { scope: "project", filePath: path.join(worktreePath, ".mcp.json") },
    ]);
  });

  it("does not read any legacy Claude or Codex source paths under the worktree or home", async () => {
    // Legacy Claude paths
    await mkdir(path.join(worktreePath, ".claude"), { recursive: true });
    await writeFile(
      path.join(worktreePath, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: { "claude-settings-server": { command: "x" } },
      }),
    );
    await writeFile(
      path.join(worktreePath, ".claude", "settings.local.json"),
      JSON.stringify({
        mcpServers: { "claude-local-server": { command: "x" } },
      }),
    );
    // Legacy Codex paths
    await mkdir(path.join(worktreePath, ".codex"), { recursive: true });
    await writeFile(
      path.join(worktreePath, ".codex", "config.toml"),
      `[mcp_servers.codex-project]
command = "x"
`,
    );

    await writeFile(globalConfigPath, JSON.stringify({ mcpServers: {} }));

    const result = await discoverAllSources({
      globalConfigPath,
      worktreePath,
    });

    const keys = result.servers.map((s) => s.serverKey);
    expect(keys).not.toContain("claude-settings-server");
    expect(keys).not.toContain("claude-local-server");
    expect(keys).not.toContain("codex-project");

    const filePaths = new Set(result.sourceFiles.map((f) => f.filePath));
    expect(
      filePaths.has(path.join(worktreePath, ".claude", "settings.json")),
    ).toBe(false);
    expect(
      filePaths.has(path.join(worktreePath, ".claude", "settings.local.json")),
    ).toBe(false);
    expect(
      filePaths.has(path.join(worktreePath, ".codex", "config.toml")),
    ).toBe(false);
  });

  it("accepts only globalConfigPath and optional worktreePath (no backends parameter)", async () => {
    await writeFile(
      globalConfigPath,
      JSON.stringify({ mcpServers: { "only-global": { command: "g" } } }),
    );

    // Call without worktreePath: should still return the global server, and
    // not attempt to read any project file.
    const result = await discoverAllSources({ globalConfigPath });

    expect(result.servers.map((s) => s.serverKey)).toEqual(["only-global"]);
    const hasProjectFile = result.sourceFiles.some(
      (f) =>
        f.filePath.endsWith(`${path.sep}.mcp.json`) &&
        !f.filePath.startsWith(configDir),
    );
    expect(hasProjectFile).toBe(false);
  });

  it("project definition replaces same-key global definition (no backend coalescing)", async () => {
    await writeFile(
      globalConfigPath,
      JSON.stringify({
        mcpServers: { shared: { command: "global-cmd" } },
      }),
    );
    await writeFile(
      path.join(worktreePath, ".mcp.json"),
      JSON.stringify({
        mcpServers: { shared: { command: "project-cmd" } },
      }),
    );

    const result = await discoverAllSources({
      globalConfigPath,
      worktreePath,
    });

    const rows = result.servers.filter((s) => s.serverKey === "shared");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.config).toEqual({
      transport: "stdio",
      command: "project-cmd",
    });
    expect(rows[0]?.sourceRefs).toEqual([
      { scope: "project", filePath: path.join(worktreePath, ".mcp.json") },
    ]);
  });
});
