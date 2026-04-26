import { describe, expect, it } from "vitest";

import {
  buildCodexMcpServersConfig,
  parseCodexMcpListJson,
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
