import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agentCapabilityDiscoveredItemSchema } from "@/lib/agent-capabilities/schemas";

import {
  discoverCodexPluginsCanonical,
  discoverCodexSkillsCanonical,
} from "@/lib/agent-backends/codex/capability-discovery";

let workTree: string;
let home: string;

beforeEach(async () => {
  workTree = await mkdtemp(path.join(os.tmpdir(), "codex-canon-work-"));
  home = await mkdtemp(path.join(os.tmpdir(), "codex-canon-home-"));
});

afterEach(async () => {
  await rm(workTree, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("discoverCodexSkillsCanonical", () => {
  const skill = (skillPath: string, enabled = true) => ({
    name: "native-name",
    description: "native",
    path: skillPath,
    scope: "repo" as const,
    enabled,
    pluginId: null,
  });
  it("uses complete native inventory and stable source identities for duplicate names", async () => {
    const entries = [
      skill(path.join(workTree, ".agents/skills/linked/SKILL.md"), false),
      {
        ...skill(path.join(home, ".codex/skills/review/SKILL.md")),
        scope: "user" as const,
      },
    ];
    const result = await discoverCodexSkillsCanonical({
      worktreePath: workTree,
      home,
      listSkills: async () => entries,
    });
    expect(result.items).toHaveLength(2);
    expect(new Set(result.items.map((item) => item.itemId)).size).toBe(2);
    expect(result.items.map((item) => item.nativeDefault.enabled)).toEqual([
      false,
      true,
    ]);
    expect(result.items.map((item) => item.displayName)).toEqual([
      "native-name",
      "native-name",
    ]);
    for (const item of result.items)
      agentCapabilityDiscoveredItemSchema.parse(item);
    const equivalent = await discoverCodexSkillsCanonical({
      worktreePath: "/different-worktree",
      home,
      listSkills: async () => [
        skill("/different-worktree/.agents/skills/linked/SKILL.md", false),
        {
          ...skill(path.join(home, ".codex/skills/review/SKILL.md")),
          scope: "user" as const,
        },
      ],
    });
    expect(equivalent.items.map((item) => item.itemId)).toEqual(
      result.items.map((item) => item.itemId),
    );
  });
  it("retains native plugin ownership and reports native discovery failure", async () => {
    const result = await discoverCodexSkillsCanonical({
      worktreePath: workTree,
      home,
      listSkills: async () => [
        { ...skill("/plugins/review/SKILL.md"), pluginId: "review@market" },
      ],
    });
    expect(result.items[0]?.owningPluginId).toBe("review@market");
    await expect(
      discoverCodexSkillsCanonical({
        worktreePath: workTree,
        home,
        listSkills: async () => {
          throw new Error("native discovery failed");
        },
      }),
    ).rejects.toThrow("native discovery failed");
  });
});

describe("discoverCodexPluginsCanonical", () => {
  it("returns no items, no diagnostics, and discoverySupport=available when no codex plugin sources exist", async () => {
    const result = await discoverCodexPluginsCanonical({
      worktreePath: workTree,
      home,
    });
    expect(result.cascadeKind).toBe("codex-plugins");
    expect(result.items).toEqual([]);
    expect(result.discoverySupport).toBe("available");
    expect(result.diagnostics).toEqual([]);
  });

  it("maps a cached plugin into canonical AgentCapabilityDiscoveredItem shape", async () => {
    const pluginRoot = path.join(
      home,
      ".codex",
      "plugins",
      "cache",
      "oh-my-codex-local",
      "oh-my-codex",
      "1.0.0",
    );
    const manifestDir = path.join(pluginRoot, ".codex-plugin");
    await mkdir(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        name: "oh-my-codex",
        displayName: "Oh My Codex",
      }),
      "utf-8",
    );

    const result = await discoverCodexPluginsCanonical({
      worktreePath: workTree,
      home,
    });

    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    // Boundary parse: ensures the canonical schema accepts the item.
    agentCapabilityDiscoveredItemSchema.parse(item);
    expect(item.capabilityKind).toBe("plugin");
    expect(item.itemId).toBe("oh-my-codex@oh-my-codex-local");
    expect(item.displayName).toBe("Oh My Codex");
    expect(item.nativeDefault).toEqual({ enabled: true });
    expect(item.source).toEqual({ kind: "user-file", path: manifestPath });
  });

  it("populates refreshedAt and a stable signature so cache layers can key on it", async () => {
    const first = await discoverCodexPluginsCanonical({
      worktreePath: workTree,
      home,
    });
    const second = await discoverCodexPluginsCanonical({
      worktreePath: workTree,
      home,
    });
    expect(first.sourceSignature).toBe(second.sourceSignature);
    expect(typeof first.refreshedAt).toBe("string");
  });
});
