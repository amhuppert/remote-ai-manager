import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  buildCodexMcpServersConfig,
  parseCodexMcpListJson,
  resolveCodexCliPath,
  resolveNativeMcpSuppression,
} from "./native-mcp-suppression";

const githubEntry = {
  name: "github",
  enabled: true,
  transport: {
    type: "streamable_http",
    url: "https://api.githubcopilot.com/mcp/",
    bearer_token_env_var: "GITHUB_PAT_TOKEN",
    http_headers: null,
  },
};
const githubServer = {
  name: "github",
  configEntry: {
    url: "https://api.githubcopilot.com/mcp/",
    bearer_token_env_var: "GITHUB_PAT_TOKEN",
  },
};

describe("parseCodexMcpListJson", () => {
  it("reconstructs the transport config entry for each native server", () => {
    const discovery = parseCodexMcpListJson(
      JSON.stringify([
        githubEntry,
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
      ]),
    );

    expect(discovery).toEqual({
      kind: "complete",
      servers: [
        githubServer,
        {
          name: "next-devtools",
          configEntry: {
            command: "npx",
            args: ["-y", "next-devtools-mcp@latest"],
          },
        },
      ],
    });
  });

  it("reports a genuinely empty list as complete", () => {
    expect(parseCodexMcpListJson("[]")).toEqual({
      kind: "complete",
      servers: [],
    });
  });

  it("reports an entry it cannot reconstruct as incomplete, keeping the others", () => {
    const discovery = parseCodexMcpListJson(
      JSON.stringify([
        githubEntry,
        { name: "unknown-transport", transport: { type: "sse", url: "x" } },
      ]),
    );

    expect(discovery).toMatchObject({
      kind: "incomplete",
      reconstructed: [githubServer],
    });
    expect(discovery.kind === "incomplete" && discovery.reason).toContain(
      "unknown-transport",
    );
  });

  it("reports a non-array or unparseable listing as incomplete", () => {
    expect(parseCodexMcpListJson("{}")).toMatchObject({
      kind: "incomplete",
      reconstructed: [],
    });
    expect(parseCodexMcpListJson("not json")).toMatchObject({
      kind: "incomplete",
      reconstructed: [],
    });
  });
});

describe("resolveNativeMcpSuppression", () => {
  const incomplete = {
    kind: "incomplete" as const,
    reason: "codex mcp list failed: spawn ENOENT",
    reconstructed: [githubServer],
  };

  it("suppresses every discovered server when discovery is complete", () => {
    expect(
      resolveNativeMcpSuppression(
        { kind: "complete", servers: [githubServer] },
        "required",
      ),
    ).toEqual({ kind: "suppress", servers: [githubServer] });
  });

  it("refuses a required suppression when discovery is incomplete", () => {
    expect(resolveNativeMcpSuppression(incomplete, "required")).toEqual({
      kind: "refused",
      reason: "codex mcp list failed: spawn ENOENT",
    });
  });

  it("suppresses what it could reconstruct when suppression is best effort", () => {
    expect(resolveNativeMcpSuppression(incomplete, "best_effort")).toEqual({
      kind: "suppress",
      servers: [githubServer],
    });
  });
});

describe("buildCodexMcpServersConfig", () => {
  it("disables unmanaged native servers with a complete transport entry so Codex can load the config", () => {
    const config = buildCodexMcpServersConfig({
      managedMcpServers: {
        "external-tools": { url: "http://localhost/mcp" },
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
          name: "external-tools",
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
      "external-tools": { url: "http://localhost/mcp" },
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
