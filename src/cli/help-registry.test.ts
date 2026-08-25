import { describe, expect, it } from "vitest";
import {
  booleanFlagArgsFrom,
  booleanFlagNames,
  booleanFlagNamesFrom,
  buildHelpRegistry,
  childHelpEntries,
  flagNamesFrom,
  resolveHelpEntry,
} from "./help-registry";
import type { CommandHelpEntry, FlagSpec } from "./help-types";

function entry(
  partial: Partial<CommandHelpEntry> & { path: string[] },
): CommandHelpEntry {
  return {
    summary: "summary",
    description: "description",
    usage: ["usage"],
    flags: [],
    examples: [{ invocation: "cctl x", explanation: "does x" }],
    related: [],
    ...partial,
  };
}

const valueFlag = (name: string): FlagSpec => ({
  name,
  kind: "value",
  description: `the ${name}`,
});
const proseFlag = (name: string): FlagSpec => ({
  name,
  kind: "value",
  fileSource: true,
  description: `the ${name}`,
});
const booleanFlag = (name: string): FlagSpec => ({
  name,
  kind: "boolean",
  description: `the ${name}`,
});

describe("buildHelpRegistry aggregation validation", () => {
  it("throws when two entries share a path key", () => {
    const entries = [entry({ path: ["docs"] }), entry({ path: ["docs"] })];
    expect(() => buildHelpRegistry(entries)).toThrowError(/duplicate/i);
  });

  it("names the duplicate path in the error", () => {
    const entries = [
      entry({ path: ["docs", "list"] }),
      entry({ path: ["docs"] }),
      entry({ path: ["docs", "list"] }),
    ];
    expect(() => buildHelpRegistry(entries)).toThrowError(/docs list/);
  });

  it("throws when a leaf entry's parent group node is missing", () => {
    const entries = [entry({ path: ["docs", "list"] })];
    expect(() => buildHelpRegistry(entries)).toThrowError(/docs list/);
  });

  it("names the missing parent in the orphan error", () => {
    const entries = [
      entry({ path: ["conversation"] }),
      entry({ path: ["conversation", "compaction", "get"] }),
    ];
    // parent "conversation compaction" is absent even though "conversation" exists
    expect(() => buildHelpRegistry(entries)).toThrowError(
      /conversation compaction/,
    );
  });

  it("accepts a well-formed group + leaves + nested group", () => {
    const entries = [
      entry({ path: ["conversation"] }),
      entry({ path: ["conversation", "read"] }),
      entry({ path: ["conversation", "compaction"] }),
      entry({ path: ["conversation", "compaction", "get"] }),
    ];
    expect(() => buildHelpRegistry(entries)).not.toThrow();
  });
});

describe("resolveHelpEntry longest-prefix resolution", () => {
  const registry = buildHelpRegistry([
    entry({ path: ["docs"] }),
    entry({ path: ["docs", "list"] }),
    entry({ path: ["conversation"] }),
    entry({ path: ["conversation", "compaction"] }),
    entry({ path: ["conversation", "compaction", "get"] }),
  ]);

  it("resolves an exact leaf path", () => {
    expect(resolveHelpEntry(registry, ["docs", "list"])?.path).toEqual([
      "docs",
      "list",
    ]);
  });

  it("resolves a 3-level exact path", () => {
    expect(
      resolveHelpEntry(registry, ["conversation", "compaction", "get"])?.path,
    ).toEqual(["conversation", "compaction", "get"]);
  });

  it("falls back to the longest matching prefix for trailing garbage", () => {
    expect(resolveHelpEntry(registry, ["docs", "list", "extra"])?.path).toEqual(
      ["docs", "list"],
    );
  });

  it("stops at the deepest known node under a partial 3-level path", () => {
    expect(
      resolveHelpEntry(registry, ["conversation", "compaction", "bogus"])?.path,
    ).toEqual(["conversation", "compaction"]);
  });

  it("resolves the group node when only the group is given", () => {
    expect(resolveHelpEntry(registry, ["conversation"])?.path).toEqual([
      "conversation",
    ]);
  });

  it("returns undefined for an entirely unknown root", () => {
    expect(resolveHelpEntry(registry, ["frobnicate"])).toBeUndefined();
  });
});

describe("childHelpEntries", () => {
  const registry = buildHelpRegistry([
    entry({ path: ["conversation"] }),
    entry({ path: ["conversation", "read"] }),
    entry({ path: ["conversation", "compaction"] }),
    entry({ path: ["conversation", "compaction", "get"] }),
  ]);

  it("returns only direct children, not grandchildren", () => {
    const children = childHelpEntries(registry, ["conversation"]).map(
      (c) => c.path,
    );
    expect(children).toEqual([
      ["conversation", "read"],
      ["conversation", "compaction"],
    ]);
  });

  it("returns [] for a leaf node", () => {
    expect(childHelpEntries(registry, ["conversation", "read"])).toEqual([]);
  });
});

describe("flagNamesFrom", () => {
  const registry = buildHelpRegistry([
    entry({ path: ["docs"] }),
    entry({
      path: ["docs", "register"],
      flags: [valueFlag("description")],
    }),
  ]);

  it("returns the entry's flag names", () => {
    expect(flagNamesFrom(registry, "docs register")).toEqual(["description"]);
  });

  it("returns [] for an entry with no command-specific flags", () => {
    expect(flagNamesFrom(registry, "docs")).toEqual([]);
  });

  it("throws for an unknown path key", () => {
    expect(() => flagNamesFrom(registry, "docs bogus")).toThrowError(
      /docs bogus/,
    );
  });
});

describe("file-source derivation from the single flag bit (doc 09 §7)", () => {
  const registry = buildHelpRegistry([
    entry({ path: ["lane"] }),
    entry({
      path: ["lane", "complete"],
      flags: [proseFlag("summary"), valueFlag("slug")],
    }),
  ]);

  it("allowlists the paired --<name>-file alongside the declared flag", () => {
    expect(flagNamesFrom(registry, "lane complete")).toEqual([
      "summary",
      "summary-file",
      "slug",
    ]);
  });

  it("derives nothing for a value flag that does not declare fileSource", () => {
    expect(flagNamesFrom(registry, "lane complete")).not.toContain("slug-file");
  });

  it("keeps the derived flag out of the boolean set (it takes a path)", () => {
    expect(booleanFlagNamesFrom(registry)).toEqual([]);
  });

  it("throws when a derived file flag collides with a declared flag name", () => {
    const entries = [
      entry({ path: ["lane"] }),
      entry({
        path: ["lane", "complete"],
        flags: [proseFlag("summary"), valueFlag("summary-file")],
      }),
    ];
    expect(() => buildHelpRegistry(entries)).toThrowError(/summary-file/);
  });
});

describe("booleanFlagNamesFrom", () => {
  it("returns the union of boolean flag names across entries", () => {
    const registry = buildHelpRegistry([
      entry({ path: ["a"], flags: [booleanFlag("wait"), valueFlag("file")] }),
      entry({
        path: ["b"],
        flags: [booleanFlag("force"), booleanFlag("wait")],
      }),
    ]);
    expect(booleanFlagNamesFrom(registry).sort()).toEqual(["force", "wait"]);
  });

  it("returns [] when no entry declares a boolean flag", () => {
    const registry = buildHelpRegistry([
      entry({ path: ["a"], flags: [valueFlag("file")] }),
    ]);
    expect(booleanFlagNamesFrom(registry)).toEqual([]);
  });
});

describe("booleanFlagArgsFrom", () => {
  const registry = buildHelpRegistry([
    entry({
      path: ["a"],
      flags: [booleanFlag("wait"), booleanFlag("config")],
    }),
    entry({ path: ["b"], flags: [valueFlag("config")] }),
  ]);

  it("keeps undeclared known booleans valueless for allowlist rejection", () => {
    expect(booleanFlagArgsFrom(registry, ["b"])).toContain("--wait");
  });

  it("lets a command-local value flag override a boolean declared elsewhere", () => {
    expect(booleanFlagArgsFrom(registry, ["b"])).not.toContain("--config");
  });
});

describe("booleanFlagNames() over the real registry", () => {
  // The parse-time boolean set (shared.ts `BOOLEAN_FLAG_ARGS`) is derived from
  // this, so it must equal the full set of boolean flags the CLI accepts. A
  // dropped name here would make `parseArgv` consume the next token as that
  // flag's value; a stray one would swallow a real positional. `--help` is
  // parser-intrinsic (not a registry flag), so it is deliberately absent.
  it("is exactly the union of every boolean flag across all commands", () => {
    expect(booleanFlagNames().sort()).toEqual([
      "all",
      "attachments",
      "charter",
      "config",
      "dry-run",
      "force",
      "full",
      "halt",
      "include-self",
      "include-thinking",
      "multi-select",
      "open",
      "outline",
      "outputs",
      "params",
      "park",
      "queue-if-busy",
      "quiet",
      "rendered",
      "require-match",
      "skip-warm",
      "stdout",
      "summary",
      "wait",
    ]);
  });
});
