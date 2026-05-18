import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  discoverClaudeAgents,
  discoverClaudePlugins,
  discoverClaudeSkills,
} from "./claude-discovery";

let workTree: string;
let home: string;

async function writeSkill(
  dir: string,
  skillId: string,
  body: string,
): Promise<void> {
  await mkdir(path.join(dir, skillId), { recursive: true });
  await writeFile(
    path.join(dir, skillId, "SKILL.md"),
    `---\nname: ${skillId}\ndescription: ${body}\n---\n${body}\n`,
    "utf-8",
  );
}

async function writeAgent(
  dir: string,
  agentId: string,
  body: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${agentId}.md`),
    `---\nname: ${agentId}\ndescription: ${body}\n---\n${body}\n`,
    "utf-8",
  );
}

async function writeSettings(
  homeDir: string,
  enabledPlugins:
    | Record<string, boolean | string[] | { [k: string]: unknown }>
    | undefined,
  skillOverrides?: Record<
    string,
    "on" | "name-only" | "user-invocable-only" | "off"
  >,
): Promise<void> {
  const dir = path.join(homeDir, ".claude");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify(
      {
        enabledPlugins: enabledPlugins ?? {},
        ...(skillOverrides ? { skillOverrides } : {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function writeInstalledPlugins(
  homeDir: string,
  records: Record<string, Array<{ installPath?: string; cachePath?: string }>>,
): Promise<void> {
  const dir = path.join(homeDir, ".claude", "plugins");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "installed_plugins.json"),
    JSON.stringify({ version: 1, plugins: records }, null, 2),
    "utf-8",
  );
}

beforeEach(async () => {
  workTree = await mkdtemp(path.join(os.tmpdir(), "claude-disc-work-"));
  home = await mkdtemp(path.join(os.tmpdir(), "claude-disc-home-"));
});

afterEach(async () => {
  await rm(workTree, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("Claude skill discovery", () => {
  it("returns an empty inventory and stable signature when no sources exist", async () => {
    const result = await discoverClaudeSkills({ worktreePath: workTree, home });
    expect(result.items).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.sourceSignature).toBeTypeOf("string");
  });

  it("does not write native Claude settings while discovering defaults", async () => {
    await writeSettings(home, {
      "test-plugin@market": {
        token: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
      },
    });
    const settingsPath = path.join(home, ".claude", "settings.json");
    const before = await readFile(settingsPath, "utf-8");

    await discoverClaudeSkills({ worktreePath: workTree, home });
    await discoverClaudePlugins({ worktreePath: workTree, home });
    await discoverClaudeAgents({ worktreePath: workTree, home });

    await expect(readFile(settingsPath, "utf-8")).resolves.toBe(before);
  });

  it("redacts sensitive runtime probe failures before returning diagnostics", async () => {
    await writeSkill(path.join(workTree, ".claude/skills"), "p1", "project a");

    const result = await discoverClaudeSkills({
      worktreePath: workTree,
      home,
      runtimeProbe: {
        async supportedCommands() {
          throw new Error(
            "probe failed with OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz and token abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN in /home/alex/.claude/settings.json",
          );
        },
      },
    });

    const message = result.diagnostics[0]?.message ?? "";
    expect(message).toContain("<redacted>");
    expect(message).toContain("~/.claude/settings.json");
    expect(message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(message).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN");
    expect(message).not.toContain("/home/alex");
  });

  it("discovers skills from project and user .claude/skills", async () => {
    await writeSkill(path.join(workTree, ".claude/skills"), "p1", "project a");
    await writeSkill(path.join(home, ".claude/skills"), "u1", "user a");

    const result = await discoverClaudeSkills({ worktreePath: workTree, home });
    const ids = result.items.map((i) => i.itemId).sort();
    expect(ids).toEqual(["p1", "u1"]);
    for (const item of result.items) {
      expect(item.capabilityKind).toBe("skill");
      expect(item.nativeDefault.enabled).toBe(true);
      expect(item.runtimeVisibility).toBe("source-only");
    }
  });

  it("links plugin-contributed skills via owningPluginId", async () => {
    const pluginPath = path.join(home, "plugins", "test-plugin");
    await writeSkill(path.join(pluginPath, "skills"), "p-skill", "plugin a");

    await writeSettings(home, { "test-plugin@market": true });
    await writeInstalledPlugins(home, {
      "test-plugin@market": [{ installPath: pluginPath }],
    });

    const result = await discoverClaudeSkills({ worktreePath: workTree, home });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.itemId).toBe("p-skill");
    expect(result.items[0]?.owningPluginId).toBe("test-plugin@market");
    expect(result.items[0]?.source.kind).toBe("plugin");
  });

  it("computes native skill defaults from Claude skillOverrides", async () => {
    await writeSkill(path.join(workTree, ".claude/skills"), "alpha", "a");
    await writeSkill(path.join(workTree, ".claude/skills"), "beta", "b");
    await writeSkill(path.join(workTree, ".claude/skills"), "gamma", "g");
    await writeSettings(home, undefined, {
      alpha: "off",
      beta: "name-only",
      gamma: "user-invocable-only",
    });

    const result = await discoverClaudeSkills({ worktreePath: workTree, home });
    const byId = new Map(result.items.map((item) => [item.itemId, item]));

    expect(byId.get("alpha")?.nativeDefault).toEqual({
      enabled: false,
      mode: "off",
    });
    expect(byId.get("beta")?.nativeDefault).toEqual({
      enabled: true,
      mode: "name-only",
    });
    expect(byId.get("gamma")?.nativeDefault).toEqual({
      enabled: true,
      mode: "user-invocable-only",
    });
  });

  it("changes the source signature when an existing skill's content changes", async () => {
    await writeSkill(path.join(workTree, ".claude/skills"), "p1", "before");
    const first = await discoverClaudeSkills({
      worktreePath: workTree,
      home,
    });
    await writeSkill(path.join(workTree, ".claude/skills"), "p1", "after");
    const second = await discoverClaudeSkills({
      worktreePath: workTree,
      home,
    });
    expect(first.sourceSignature).not.toBe(second.sourceSignature);
  });

  it("changes the source signature when native skillOverrides change", async () => {
    await writeSkill(path.join(workTree, ".claude/skills"), "alpha", "a");
    await writeSettings(home, undefined, { alpha: "off" });
    const first = await discoverClaudeSkills({ worktreePath: workTree, home });

    await writeSettings(home, undefined, { alpha: "name-only" });
    const second = await discoverClaudeSkills({ worktreePath: workTree, home });

    expect(first.sourceSignature).not.toBe(second.sourceSignature);
  });

  it("changes the source signature when only the frontmatter `name` (displayName) is edited", async () => {
    // Convergence gate: discovered fields the API returns (here, displayName)
    // must all be part of the signature, otherwise the cache will keep
    // serving stale rows until a manual refresh.
    const dir = path.join(workTree, ".claude/skills/alpha");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: Alpha One\ndescription: same\n---\nbody\n`,
      "utf-8",
    );
    const first = await discoverClaudeSkills({
      worktreePath: workTree,
      home,
    });
    await writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: Alpha Two\ndescription: same\n---\nbody\n`,
      "utf-8",
    );
    const second = await discoverClaudeSkills({
      worktreePath: workTree,
      home,
    });
    expect(first.items[0]?.displayName).toBe("Alpha One");
    expect(second.items[0]?.displayName).toBe("Alpha Two");
    expect(first.sourceSignature).not.toBe(second.sourceSignature);
  });

  it("treats source-read failures as diagnostics, not throws", async () => {
    await mkdir(path.join(workTree, ".claude/skills"), { recursive: true });
    const result = await discoverClaudeSkills({
      worktreePath: workTree,
      home,
      readDir: async () => {
        throw new Error("EACCES: simulated permission denied");
      },
    });
    expect(result.items).toEqual([]);
    expect(
      result.diagnostics.some(
        (d) =>
          d.code === "agent-capability-source-unreadable" &&
          d.message.includes("EACCES"),
      ),
    ).toBe(true);
  });
});

describe("Claude plugin discovery", () => {
  it("returns no plugins and no diagnostics when settings.json is absent", async () => {
    const result = await discoverClaudePlugins({
      worktreePath: workTree,
      home,
    });
    expect(result.items).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.nativeRecords).toEqual([]);
  });

  it("discovers natively-enabled plugins and preserves the raw boolean value privately", async () => {
    const pluginPath = path.join(home, "plugins", "p1");
    await mkdir(pluginPath, { recursive: true });
    await writeSettings(home, { "p1@market": true });
    await writeInstalledPlugins(home, {
      "p1@market": [{ installPath: pluginPath }],
    });

    const result = await discoverClaudePlugins({
      worktreePath: workTree,
      home,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.itemId).toBe("p1@market");
    expect(result.items[0]?.nativeDefault.enabled).toBe(true);
    expect(result.items[0]?.capabilityKind).toBe("plugin");
    // Adapter-private raw value is on `nativeRecords`, not on `items`.
    expect(result.nativeRecords).toHaveLength(1);
    expect(result.nativeRecords[0]?.pluginId).toBe("p1@market");
    expect(result.nativeRecords[0]?.nativeRawValue).toBe(true);
  });

  it("preserves extended object values in nativeRawValue but never returns them in items", async () => {
    const pluginPath = path.join(home, "plugins", "p2");
    await mkdir(pluginPath, { recursive: true });
    await writeSettings(home, {
      "p2@market": { version: "1.2.0", trust: "verified" },
    });
    await writeInstalledPlugins(home, {
      "p2@market": [{ installPath: pluginPath }],
    });

    const result = await discoverClaudePlugins({
      worktreePath: workTree,
      home,
    });
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item).toBeDefined();
    // The public item only carries enabled state; no raw object leaks here.
    expect(Object.keys(item ?? {})).not.toContain("nativeRawValue");
    expect(item?.nativeDefault.enabled).toBe(true);
    expect(result.nativeRecords[0]?.nativeRawValue).toEqual({
      version: "1.2.0",
      trust: "verified",
    });
  });

  it("records natively-disabled plugins as disabled but still discoverable", async () => {
    const pluginPath = path.join(home, "plugins", "p3");
    await mkdir(pluginPath, { recursive: true });
    await writeSettings(home, { "p3@market": false });
    await writeInstalledPlugins(home, {
      "p3@market": [{ installPath: pluginPath }],
    });

    const result = await discoverClaudePlugins({
      worktreePath: workTree,
      home,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.nativeDefault.enabled).toBe(false);
    expect(result.nativeRecords[0]?.nativeRawValue).toBe(false);
  });

  it("emits a diagnostic when settings.json is malformed", async () => {
    const dir = path.join(home, ".claude");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "settings.json"), "{not-json", "utf-8");

    const result = await discoverClaudePlugins({
      worktreePath: workTree,
      home,
    });
    expect(result.items).toEqual([]);
    expect(
      result.diagnostics.some(
        (d) => d.code === "agent-capability-source-unreadable",
      ),
    ).toBe(true);
  });

  it("source signature reflects settings + installed-plugins state", async () => {
    const pluginPath = path.join(home, "plugins", "p1");
    await mkdir(pluginPath, { recursive: true });
    await writeSettings(home, { "p1@market": true });
    await writeInstalledPlugins(home, {
      "p1@market": [{ installPath: pluginPath }],
    });
    const first = await discoverClaudePlugins({
      worktreePath: workTree,
      home,
    });

    await writeSettings(home, { "p1@market": false });
    const second = await discoverClaudePlugins({
      worktreePath: workTree,
      home,
    });

    expect(first.sourceSignature).not.toBe(second.sourceSignature);
  });
});

describe("Claude agent discovery", () => {
  it("returns an empty inventory when no agent dirs exist", async () => {
    const result = await discoverClaudeAgents({
      worktreePath: workTree,
      home,
    });
    expect(result.items).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("discovers agents from project and user .claude/agents", async () => {
    await writeAgent(path.join(workTree, ".claude/agents"), "explore", "scout");
    await writeAgent(path.join(home, ".claude/agents"), "general", "g");
    const result = await discoverClaudeAgents({
      worktreePath: workTree,
      home,
    });
    const ids = result.items.map((i) => i.itemId).sort();
    expect(ids).toEqual(["explore", "general"]);
    for (const item of result.items) {
      expect(item.capabilityKind).toBe("agent");
      expect(item.nativeDefault.enabled).toBe(true);
    }
  });

  it("links plugin-contributed agents via owningPluginId", async () => {
    const pluginPath = path.join(home, "plugins", "ace");
    await writeAgent(path.join(pluginPath, "agents"), "reviewer", "review");

    await writeSettings(home, { "ace@market": true });
    await writeInstalledPlugins(home, {
      "ace@market": [{ installPath: pluginPath }],
    });

    const result = await discoverClaudeAgents({
      worktreePath: workTree,
      home,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.itemId).toBe("reviewer");
    expect(result.items[0]?.owningPluginId).toBe("ace@market");
  });
});

describe("SDK runtime probes", () => {
  it("marks items as runtime-visible when the probe returns matching names", async () => {
    await writeSkill(path.join(workTree, ".claude/skills"), "alpha", "x");
    const skills = await discoverClaudeSkills({
      worktreePath: workTree,
      home,
      runtimeProbe: {
        async supportedCommands() {
          return [{ name: "alpha", description: "live", argumentHint: "" }];
        },
      },
    });
    expect(skills.items[0]?.runtimeVisibility).toBe("runtime-visible");
  });

  it("adds runtime-visible skills that are reported by the SDK but absent from source files", async () => {
    const skills = await discoverClaudeSkills({
      worktreePath: workTree,
      home,
      runtimeProbe: {
        async supportedCommands() {
          return [{ name: "runtime-only" }];
        },
      },
    });

    expect(skills.items).toEqual([
      expect.objectContaining({
        itemId: "runtime-only",
        displayName: "runtime-only",
        capabilityKind: "skill",
        source: { kind: "sdk-runtime" },
        nativeDefault: { enabled: true },
        runtimeVisibility: "runtime-visible",
      }),
    ]);
  });

  it("adds runtime-visible agents from the SDK supportedAgents method", async () => {
    const agents = await discoverClaudeAgents({
      worktreePath: workTree,
      home,
      runtimeProbe: {
        async supportedAgents() {
          return [{ name: "runtime-reviewer" }];
        },
      },
    });

    expect(agents.items).toEqual([
      expect.objectContaining({
        itemId: "runtime-reviewer",
        displayName: "runtime-reviewer",
        capabilityKind: "agent",
        source: { kind: "sdk-runtime" },
        nativeDefault: { enabled: true },
        runtimeVisibility: "runtime-visible",
      }),
    ]);
  });

  it("falls back to source-only and emits a diagnostic when probe rejects", async () => {
    await writeSkill(path.join(workTree, ".claude/skills"), "alpha", "x");
    const skills = await discoverClaudeSkills({
      worktreePath: workTree,
      home,
      runtimeProbe: {
        async supportedCommands() {
          throw new Error("session not ready");
        },
      },
    });
    expect(skills.items[0]?.runtimeVisibility).toBe("source-only");
    expect(
      skills.diagnostics.some(
        (d) => d.code === "agent-capability-source-unreadable",
      ),
    ).toBe(true);
  });
});
