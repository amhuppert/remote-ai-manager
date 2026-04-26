import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  buildCodexMcpServersConfig,
  parseCodexMcpListJson,
  resolveCodexCliPath,
} from "./native-mcp-suppression";

describe("parseCodexMcpListJson", () => {
  it("returns server names from codex mcp list JSON", () => {
    const names = parseCodexMcpListJson(
      JSON.stringify([
        { name: "playwright", enabled: true },
        { name: "next-devtools", enabled: true },
        { name: 42 },
        {},
      ]),
    );

    expect(names).toEqual(["playwright", "next-devtools"]);
  });
});

describe("buildCodexMcpServersConfig", () => {
  it("disables native Codex MCP servers that are not managed by Command Center", () => {
    const config = buildCodexMcpServersConfig({
      managedMcpServers: {
        "cc-session-tools": { url: "http://localhost/mcp" },
        "next-devtools-project": { command: "npx", args: ["next"] },
      },
      nativeServerNames: ["playwright", "cc-session-tools", "next-devtools"],
    });

    expect(config).toEqual({
      "cc-session-tools": { url: "http://localhost/mcp" },
      "next-devtools-project": { command: "npx", args: ["next"] },
      playwright: { enabled: false },
      "next-devtools": { enabled: false },
    });
  });
});

describe("resolveCodexCliPath", () => {
  it("resolves the Codex CLI from a fallback base when the worktree package is absent", () => {
    const cwd = "/repo";
    const fallbackBase = "/server-root";
    const codexPackageJson = path.join(
      fallbackBase,
      "node_modules",
      "@openai",
      "codex",
      "package.json",
    );

    const cliPath = resolveCodexCliPath({
      cwd,
      serverRoot: fallbackBase,
      fileExists(filePath) {
        return filePath === codexPackageJson;
      },
    });

    expect(cliPath).toBe(
      path.join(
        fallbackBase,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      ),
    );
  });
});
