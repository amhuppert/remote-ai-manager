import { describe, expect, it } from "vitest";

import {
  parseNativePluginEntries,
  readClaudePluginNativeRecords,
} from "./plugin-native-records";

describe("parseNativePluginEntries", () => {
  it("parses the array form as enabled entries", () => {
    expect(parseNativePluginEntries(["a@mkt", "b@mkt", 42])).toEqual([
      { pluginId: "a@mkt", nativeEnabled: true, nativeRawValue: true },
      { pluginId: "b@mkt", nativeEnabled: true, nativeRawValue: true },
    ]);
  });

  it("parses the record form preserving raw values", () => {
    expect(
      parseNativePluginEntries({
        "on@mkt": true,
        "off@mkt": false,
        "ext@mkt": { version: "1.2.0" },
        "list@mkt": ["x"],
        "junk@mkt": 7,
      }),
    ).toEqual([
      { pluginId: "on@mkt", nativeEnabled: true, nativeRawValue: true },
      { pluginId: "off@mkt", nativeEnabled: false, nativeRawValue: false },
      {
        pluginId: "ext@mkt",
        nativeEnabled: true,
        nativeRawValue: { version: "1.2.0" },
      },
      { pluginId: "list@mkt", nativeEnabled: true, nativeRawValue: ["x"] },
    ]);
  });

  it("returns [] for absent or malformed enabledPlugins", () => {
    expect(parseNativePluginEntries(undefined)).toEqual([]);
    expect(parseNativePluginEntries("nope")).toEqual([]);
  });
});

describe("readClaudePluginNativeRecords", () => {
  it("reads and parses ~/.claude/settings.json", async () => {
    const reads: string[] = [];
    const records = await readClaudePluginNativeRecords({
      homeDir: () => "/home/test",
      readFile: async (filePath) => {
        reads.push(filePath);
        return JSON.stringify({ enabledPlugins: { "p@mkt": false } });
      },
    });
    expect(reads).toEqual(["/home/test/.claude/settings.json"]);
    expect(records).toEqual([
      { pluginId: "p@mkt", nativeEnabled: false, nativeRawValue: false },
    ]);
  });

  it("returns [] when the settings file does not exist", async () => {
    const enoent = Object.assign(new Error("not found"), { code: "ENOENT" });
    const records = await readClaudePluginNativeRecords({
      homeDir: () => "/home/test",
      readFile: async () => {
        throw enoent;
      },
    });
    expect(records).toEqual([]);
  });

  it("throws when the settings file exists but is unreadable", async () => {
    await expect(
      readClaudePluginNativeRecords({
        homeDir: () => "/home/test",
        readFile: async () => {
          throw new Error("EACCES");
        },
      }),
    ).rejects.toThrow("EACCES");
  });

  it("throws when the settings file is not valid JSON", async () => {
    await expect(
      readClaudePluginNativeRecords({
        homeDir: () => "/home/test",
        readFile: async () => "{not json",
      }),
    ).rejects.toThrow();
  });
});
