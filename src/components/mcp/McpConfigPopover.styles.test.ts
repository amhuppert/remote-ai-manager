import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT_STYLES_DIR = resolve(__dirname, "../../features/_root/styles");
const ROOT_PARTIALS = [
  "tokens.css",
  "reset.css",
  "typography.css",
  "shell.css",
  "topbar.css",
  "sidebar-nav.css",
  "keyboard-shortcuts-modal.css",
];
const css = [
  ...ROOT_PARTIALS.map((p) =>
    readFileSync(resolve(ROOT_STYLES_DIR, p), "utf8"),
  ),
  readFileSync(resolve(__dirname, "../../app/globals.css"), "utf8"),
].join("\n");

function extractDefinedRootVars(source: string): Set<string> {
  const defined = new Set<string>();
  const rootRegex = /:root\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rootRegex.exec(source)) !== null) {
    const body = match[1] ?? "";
    const varRegex = /(--[a-zA-Z0-9-_]+)\s*:/g;
    let v: RegExpExecArray | null;
    while ((v = varRegex.exec(body)) !== null) {
      if (v[1]) defined.add(v[1]);
    }
  }
  return defined;
}

function extractRuleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`);
  const match = re.exec(source);
  return match?.[1] ?? "";
}

describe("mcp-config-popover styles", () => {
  it("uses a background CSS variable that is actually defined in :root (so it is not transparent)", () => {
    const body = extractRuleBody(css, ".mcp-config-popover");
    expect(body).not.toBe("");

    const bgMatch =
      /background\s*:\s*var\((--[a-zA-Z0-9-_]+)(?:\s*,[^)]*)?\)/.exec(body);
    expect(bgMatch, "expected background to use a var(--token)").not.toBeNull();

    const token = bgMatch![1]!;
    const defined = extractDefinedRootVars(css);
    expect(
      defined.has(token),
      `CSS variable ${token} used by .mcp-config-popover must be defined in :root`,
    ).toBe(true);
  });
});
