import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { buildCodexConfigArgs } from "./app-server-config-args";

function assignments(config: Record<string, unknown>): string[] {
  const args = buildCodexConfigArgs(config);
  expect(args.filter((_, index) => index % 2 === 0)).toEqual(
    Array(args.length / 2).fill("-c"),
  );
  return args.filter((_, index) => index % 2 === 1);
}

describe("Codex app-server config arguments", () => {
  it("keeps nested keys inside TOML values for Codex's literal dotted-path parser", () => {
    const config = {
      memories: { use_memories: false },
      plugins: { "helper.v2@marketplace": { enabled: false } },
      skills: {
        config: [
          { name: "wait-what", enabled: true },
          { name: "project-only", enabled: false },
        ],
      },
    };
    const overrides = assignments(config);

    expect(overrides).toHaveLength(3);
    expect(
      overrides.map((entry) => entry.slice(0, entry.indexOf("="))),
    ).toEqual(["memories", "plugins", "skills"]);
    expect(parse(overrides.join("\n"))).toEqual(config);
  });

  it("preserves strings, quoted keys, and nested inline values as literal arguments", () => {
    const config = {
      mcp_servers: {
        'server."quoted"': {
          args: ["$(echo untouched)", 'a\\b\n\t"quoted"', "`literal`"],
          metadata: [{ "key.with.dot": { "with space": "value" }, count: 2.5 }],
        },
      },
      model: "gpt-5",
      ignored: undefined,
      empty: {},
    };
    expect(parse(assignments(config).join("\n"))).toEqual({
      mcp_servers: config.mcp_servers,
      model: config.model,
      empty: {},
    });
    expect(buildCodexConfigArgs()).toEqual([]);
  });

  it.each([null, Infinity, NaN, new Date(0), () => {}])(
    "rejects a value that cannot be represented as config: %s",
    (value) => {
      expect(() => buildCodexConfigArgs({ invalid: value })).toThrow(/invalid/);
    },
  );
});
