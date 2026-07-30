import { describe, it, expect } from "vitest";

import type { ManagedSkillBundle } from "@/lib/managed-skills/schemas";

import { resolveClaudeManagedSkillsAttachment } from "./managed-skills";
import type { ClaudePluginNativeRecord } from "./runtime-config/plugin-translator";

const bundle: ManagedSkillBundle = {
  id: "command-center",
  version: "2.22.0",
  digest: "0123456789abcdef",
  root: "/config/agent-bundles/command-center/0123456789abcdef",
  skillsRoot: "/config/agent-bundles/command-center/0123456789abcdef/skills",
  skillNames: ["agent-context", "cc-cli"],
};

function deps(options: {
  records?: readonly ClaudePluginNativeRecord[] | Error;
  versionsById?: Record<string, string | null>;
}) {
  return {
    readNativeRecords: async () => {
      if (options.records instanceof Error) throw options.records;
      return options.records ?? [];
    },
    readInstalledPluginVersion: async (pluginId: string) =>
      options.versionsById?.[pluginId] ?? null,
  };
}

describe("resolveClaudeManagedSkillsAttachment", () => {
  it("attaches nothing when no bundle is published", async () => {
    const result = await resolveClaudeManagedSkillsAttachment(null, deps({}));

    expect(result.plugins).toEqual([]);
    expect(result.enabledPluginsOverride).toEqual({});
  });

  it("attaches the bundle as a local plugin when no user copy is installed", async () => {
    const result = await resolveClaudeManagedSkillsAttachment(
      bundle,
      deps({ records: [] }),
    );

    expect(result.plugins).toEqual([
      { type: "local", path: bundle.root, skipMcpDiscovery: true },
    ]);
    expect(result.enabledPluginsOverride).toEqual({});
  });

  it("skips the duplicate attachment when the installed copy is version-equivalent", async () => {
    const result = await resolveClaudeManagedSkillsAttachment(
      bundle,
      deps({
        records: [
          {
            pluginId: "command-center@command-center",
            nativeEnabled: true,
            nativeRawValue: true,
          },
        ],
        versionsById: { "command-center@command-center": "2.22.0" },
      }),
    );

    expect(result.plugins).toEqual([]);
    expect(result.enabledPluginsOverride).toEqual({});
  });

  it("suppresses a stale installed copy and attaches the bundle authoritatively", async () => {
    const result = await resolveClaudeManagedSkillsAttachment(
      bundle,
      deps({
        records: [
          {
            pluginId: "command-center@command-center",
            nativeEnabled: true,
            nativeRawValue: true,
          },
        ],
        versionsById: { "command-center@command-center": "2.20.0" },
      }),
    );

    expect(result.plugins).toEqual([
      { type: "local", path: bundle.root, skipMcpDiscovery: true },
    ]);
    expect(result.enabledPluginsOverride).toEqual({
      "command-center@command-center": false,
    });
  });

  it("suppresses an installed copy whose version cannot be determined", async () => {
    const result = await resolveClaudeManagedSkillsAttachment(
      bundle,
      deps({
        records: [
          {
            pluginId: "command-center@command-center",
            nativeEnabled: true,
            nativeRawValue: true,
          },
        ],
        versionsById: { "command-center@command-center": null },
      }),
    );

    expect(result.plugins).toHaveLength(1);
    expect(result.enabledPluginsOverride).toEqual({
      "command-center@command-center": false,
    });
  });

  it("ignores a natively disabled copy — it loads nothing, so just attach", async () => {
    const result = await resolveClaudeManagedSkillsAttachment(
      bundle,
      deps({
        records: [
          {
            pluginId: "command-center@command-center",
            nativeEnabled: false,
            nativeRawValue: false,
          },
        ],
      }),
    );

    expect(result.plugins).toHaveLength(1);
    expect(result.enabledPluginsOverride).toEqual({});
  });

  it("suppresses every enabled copy when any of them is non-equivalent", async () => {
    const result = await resolveClaudeManagedSkillsAttachment(
      bundle,
      deps({
        records: [
          {
            pluginId: "command-center@command-center",
            nativeEnabled: true,
            nativeRawValue: true,
          },
          {
            pluginId: "command-center@other-marketplace",
            nativeEnabled: true,
            nativeRawValue: true,
          },
        ],
        versionsById: {
          "command-center@command-center": "2.22.0",
          "command-center@other-marketplace": "1.0.0",
        },
      }),
    );

    expect(result.plugins).toHaveLength(1);
    expect(result.enabledPluginsOverride).toEqual({
      "command-center@command-center": false,
      "command-center@other-marketplace": false,
    });
  });

  it("ignores unrelated plugins entirely", async () => {
    const result = await resolveClaudeManagedSkillsAttachment(
      bundle,
      deps({
        records: [
          {
            pluginId: "ai-resources@my-ai-resources",
            nativeEnabled: true,
            nativeRawValue: true,
          },
        ],
      }),
    );

    expect(result.plugins).toHaveLength(1);
    expect(result.enabledPluginsOverride).toEqual({});
  });

  it("attaches without suppression when native state is unreadable", async () => {
    const result = await resolveClaudeManagedSkillsAttachment(
      bundle,
      deps({ records: new Error("settings.json unreadable") }),
    );

    expect(result.plugins).toHaveLength(1);
    expect(result.enabledPluginsOverride).toEqual({});
  });
});
