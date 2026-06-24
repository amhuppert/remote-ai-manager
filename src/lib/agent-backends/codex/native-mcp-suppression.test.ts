import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  buildCodexMcpServersConfig,
  parseCodexMcpListJson,
  resolveCodexCliPath,
} from "./native-mcp-suppression";

describe("parseCodexMcpListJson", () => {
  it("reconstructs the transport config entry for each native server", () => {
    const servers = parseCodexMcpListJson(
      JSON.stringify([
        {
          name: "github",
          enabled: true,
          transport: {
            type: "streamable_http",
            url: "https://api.githubcopilot.com/mcp/",
            bearer_token_env_var: "GITHUB_PAT_TOKEN",
            http_headers: null,
          },
        },
        {
          name: "next-devtools",
          enabled: true,
          transport: {
            type: "stdio",
            command: "npx",
            args: ["-y", "next-devtools-mcp@latest"],
            env: null,
            cwd: null,
          },
        },
        { name: 42 },
        {},
        // A server whose transport we cannot reconstruct is skipped rather than
        // suppressed with an incomplete (transport-less) entry that Codex rejects.
        { name: "unknown-transport", transport: { type: "sse", url: "x" } },
      ]),
    );

    expect(servers).toEqual([
      {
        name: "github",
        configEntry: {
          url: "https://api.githubcopilot.com/mcp/",
          bearer_token_env_var: "GITHUB_PAT_TOKEN",
        },
      },
      {
        name: "next-devtools",
        configEntry: {
          command: "npx",
          args: ["-y", "next-devtools-mcp@latest"],
        },
      },
    ]);
  });
});

describe("buildCodexMcpServersConfig", () => {
  it("disables unmanaged native servers with a complete transport entry so Codex can load the config", () => {
    const config = buildCodexMcpServersConfig({
      managedMcpServers: {
        "cc-session-tools": { url: "http://localhost/mcp" },
      },
      nativeServers: [
        // Plugin-provided server (no [mcp_servers.github] table in config.toml):
        // a bare { enabled: false } override is rejected by Codex's config loader
        // ("invalid transport"), so the full transport must be re-emitted.
        {
          name: "github",
          configEntry: {
            url: "https://api.githubcopilot.com/mcp/",
            bearer_token_env_var: "GITHUB_PAT_TOKEN",
          },
        },
        {
          name: "cc-session-tools",
          configEntry: { url: "http://localhost/mcp" },
        },
        {
          name: "next-devtools",
          configEntry: {
            command: "npx",
            args: ["-y", "next-devtools-mcp@latest"],
          },
        },
      ],
    });

    expect(config).toEqual({
      "cc-session-tools": { url: "http://localhost/mcp" },
      github: {
        url: "https://api.githubcopilot.com/mcp/",
        bearer_token_env_var: "GITHUB_PAT_TOKEN",
        enabled: false,
      },
      "next-devtools": {
        command: "npx",
        args: ["-y", "next-devtools-mcp@latest"],
        enabled: false,
      },
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
