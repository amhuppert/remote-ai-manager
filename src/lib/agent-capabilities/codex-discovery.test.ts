import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CODEX_SKILL_DISCOVERY_PATHS,
  discoverCodexPlugins,
  discoverCodexSkills,
} from "./codex-discovery";

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

async function writeConfigToml(
  homeDir: string,
  content: string,
): Promise<string> {
  const dir = path.join(homeDir, ".codex");
  await mkdir(dir, { recursive: true });
  const configPath = path.join(dir, "config.toml");
  await writeFile(configPath, content, "utf-8");
  return configPath;
}

async function writePluginManifest(
  homeDir: string,
  marketplaceName: string,
  pluginRelPath: string,
  manifest: Record<string, unknown>,
): Promise<{ manifestPath: string; pluginDir: string }> {
  const pluginDir = path.join(
    homeDir,
    ".codex",
    "marketplaces",
    marketplaceName,
    pluginRelPath,
  );
  await mkdir(path.join(pluginDir, ".codex-plugin"), { recursive: true });
  const manifestPath = path.join(pluginDir, ".codex-plugin", "plugin.json");
  await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
  return { manifestPath, pluginDir };
}

async function writeRawPluginManifest(
  homeDir: string,
  marketplaceName: string,
  pluginRelPath: string,
  rawJson: string,
): Promise<string> {
  const pluginDir = path.join(
    homeDir,
    ".codex",
    "marketplaces",
    marketplaceName,
    pluginRelPath,
  );
  await mkdir(path.join(pluginDir, ".codex-plugin"), { recursive: true });
  const manifestPath = path.join(pluginDir, ".codex-plugin", "plugin.json");
  await writeFile(manifestPath, rawJson, "utf-8");
  return manifestPath;
}

beforeEach(async () => {
  workTree = await mkdtemp(path.join(os.tmpdir(), "codex-disc-work-"));
  home = await mkdtemp(path.join(os.tmpdir(), "codex-disc-home-"));
});

afterEach(async () => {
  await rm(workTree, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("Codex skill discovery", () => {
  it("declares the design-authoritative source list", () => {
    // The design spec names these concrete locations; the discovery must not
    // silently swap them for a different layout without updating both.
    expect(CODEX_SKILL_DISCOVERY_PATHS).toEqual([
      { layer: "project", relative: ".agents/skills", source: "project" },
      { layer: "project", relative: ".codex/skills", source: "project" },
      { layer: "user", relative: ".agents/skills", source: "user" },
      { layer: "user", relative: ".codex/skills", source: "user" },
      { layer: "system", relative: ".codex/skills/.system", source: "system" },
    ]);
  });

  it("returns an empty inventory with no diagnostics when no skill sources exist", async () => {
    const result = await discoverCodexSkills({ worktreePath: workTree, home });
    expect(result.items).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.sourceSignature).toBeTypeOf("string");
  });

  it("discovers skills from every declared source layer", async () => {
    await writeSkill(path.join(workTree, ".agents/skills"), "p1", "project a");
    await writeSkill(path.join(workTree, ".codex/skills"), "p2", "project b");
    await writeSkill(path.join(home, ".agents/skills"), "u1", "user a");
    await writeSkill(path.join(home, ".codex/skills"), "u2", "user b");
    await writeSkill(
      path.join(home, ".codex/skills/.system"),
      "s1",
      "system a",
    );

    const result = await discoverCodexSkills({ worktreePath: workTree, home });

    const idsBySource = new Map<string, string[]>();
    for (const item of result.items) {
      const list = idsBySource.get(item.source) ?? [];
      list.push(item.itemId);
      idsBySource.set(item.source, list);
    }

    expect(idsBySource.get("project")?.sort()).toEqual(["p1", "p2"]);
    expect(idsBySource.get("user")?.sort()).toEqual(["u1", "u2"]);
    expect(idsBySource.get("system")).toEqual(["s1"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("does not double-count user-level discovery when scanning home .codex/skills (excludes the .system subdir)", async () => {
    await writeSkill(
      path.join(home, ".codex/skills/.system"),
      "sys-only",
      "system",
    );
    const result = await discoverCodexSkills({ worktreePath: workTree, home });
    const matches = result.items.filter((item) => item.itemId === "sys-only");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.source).toBe("system");
  });

  it("produces a stable source signature that changes when a new skill is added", async () => {
    await writeSkill(path.join(workTree, ".agents/skills"), "p1", "before");
    const first = await discoverCodexSkills({ worktreePath: workTree, home });

    await writeSkill(path.join(workTree, ".agents/skills"), "p2", "added");
    const second = await discoverCodexSkills({ worktreePath: workTree, home });

    expect(first.sourceSignature).not.toBe(second.sourceSignature);
  });

  it("changes the source signature when an existing skill's content changes (not just when items appear/disappear)", async () => {
    await writeSkill(path.join(workTree, ".agents/skills"), "p1", "before");
    const first = await discoverCodexSkills({ worktreePath: workTree, home });

    // Same itemId, different SKILL.md body → discovered description changes,
    // so the signature must change. This protects against cache staleness
    // after a user edits a skill in place.
    await writeSkill(path.join(workTree, ".agents/skills"), "p1", "after");
    const second = await discoverCodexSkills({ worktreePath: workTree, home });

    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(first.items[0]?.itemId).toBe("p1");
    expect(second.items[0]?.itemId).toBe("p1");
    expect(first.items[0]?.description).not.toBe(second.items[0]?.description);
    expect(first.sourceSignature).not.toBe(second.sourceSignature);
  });

  it("returns a diagnostic when a skill source path is unreadable", async () => {
    const unreadableSourceDir = path.join(workTree, ".agents/skills");
    await mkdir(unreadableSourceDir, { recursive: true });
    await writeFile(
      path.join(unreadableSourceDir, "broken-SKILL.md"),
      "not a directory",
      "utf-8",
    );

    // No real malformed-FS error to provoke without root; instead, verify that
    // discovery treats an unreadable subdir gracefully when injected via a
    // simulated readDir error through the dependency injection seam.
    const result = await discoverCodexSkills({
      worktreePath: workTree,
      home,
      readDir: async () => {
        throw new Error("EACCES: simulated permission denied");
      },
    });

    expect(result.items).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]?.message).toContain("EACCES");
  });
});

describe("Codex plugin discovery", () => {
  it("returns no items, no diagnostics, and discoverySupport=available when ~/.codex is absent", async () => {
    // The fresh `home` mkdtemp has no `.codex/` subdir at all — the
    // implementation MUST treat that as 'no plugins configured', NOT as a
    // failure to scan. Anything else would flood the UI with diagnostics for
    // brand-new installs that have never touched Codex plugins.
    const result = await discoverCodexPlugins({
      worktreePath: workTree,
      home,
    });
    expect(result.items).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.discoverySupport).toBe("available");
  });

  it("discovers a bare-name plugin from config.toml only, defaulting enabled=true", async () => {
    await writeConfigToml(
      home,
      `[plugins."oh-my-codex"]
`,
    );
    const result = await discoverCodexPlugins({
      worktreePath: workTree,
      home,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.discoverySupport).toBe("available");
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.itemId).toBe("oh-my-codex");
    expect(item?.enabled).toBe(true);
    expect(item?.sourcePath).toBeUndefined();
    expect(item?.pluginPath).toBeUndefined();
  });

  it("honors enabled=false set on an @scoped plugin id in config.toml", async () => {
    await writeConfigToml(
      home,
      `[plugins."oh-my-codex@oh-my-codex-local"]
enabled = false
`,
    );
    const result = await discoverCodexPlugins({
      worktreePath: workTree,
      home,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.itemId).toBe("oh-my-codex@oh-my-codex-local");
    expect(item?.enabled).toBe(false);
  });

  it("discovers a marketplace-sourced plugin with no config.toml entry, defaulting enabled=true", async () => {
    const { manifestPath, pluginDir } = await writePluginManifest(
      home,
      "oh-my-codex-local",
      "oh-my-codex",
      {
        name: "oh-my-codex",
        displayName: "Oh My Codex",
        description: "Sample plugin",
        version: "1.0.0",
      },
    );
    const result = await discoverCodexPlugins({
      worktreePath: workTree,
      home,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.itemId).toBe("oh-my-codex@oh-my-codex-local");
    expect(item?.displayName).toBe("Oh My Codex");
    expect(item?.description).toBe("Sample plugin");
    expect(item?.version).toBe("1.0.0");
    expect(item?.enabled).toBe(true);
    expect(item?.sourcePath).toBe(manifestPath);
    expect(item?.pluginPath).toBe(pluginDir);
    expect(item?.marketplaceName).toBe("oh-my-codex-local");
  });

  it("discovers an @scope/name plugin from a marketplace manifest, producing id @scope/name@marketplace", async () => {
    // Scoped plugin names (e.g. `@anthropic/oh-my-codex`) are a real Codex
    // ecosystem convention. The id-join logic must concatenate the manifest
    // `name` (already containing `@scope/`) with `@<marketplace>` — there is
    // no escaping/sanitization step that would mangle the leading `@`.
    const { manifestPath, pluginDir } = await writePluginManifest(
      home,
      "oh-my-codex-local",
      "scoped-plugin",
      {
        name: "@anthropic/oh-my-codex",
        displayName: "Scoped Codex Plugin",
      },
    );
    const result = await discoverCodexPlugins({
      worktreePath: workTree,
      home,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.itemId).toBe("@anthropic/oh-my-codex@oh-my-codex-local");
    expect(item?.displayName).toBe("Scoped Codex Plugin");
    expect(item?.enabled).toBe(true);
    expect(item?.sourcePath).toBe(manifestPath);
    expect(item?.pluginPath).toBe(pluginDir);
    expect(item?.marketplaceName).toBe("oh-my-codex-local");
  });

  it("honors config.toml enabled=false for an @scope/name plugin id from a marketplace manifest", async () => {
    // Verifies the merge path uses the same composed id (manifest name +
    // marketplace) when looking up the config override — so a scoped
    // marketplace plugin disabled via `[plugins."@scope/name@marketplace"]
    // enabled = false` actually takes effect.
    await writeConfigToml(
      home,
      `[plugins."@anthropic/oh-my-codex@oh-my-codex-local"]
enabled = false
`,
    );
    await writePluginManifest(home, "oh-my-codex-local", "scoped-plugin", {
      name: "@anthropic/oh-my-codex",
      displayName: "Scoped Codex Plugin",
    });

    const result = await discoverCodexPlugins({
      worktreePath: workTree,
      home,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.itemId).toBe("@anthropic/oh-my-codex@oh-my-codex-local");
    expect(item?.displayName).toBe("Scoped Codex Plugin");
    expect(item?.enabled).toBe(false);
  });

  it("merges config.toml + marketplace manifest: manifest metadata preserved, config enabled honored", async () => {
    await writeConfigToml(
      home,
      `[plugins."oh-my-codex@oh-my-codex-local"]
enabled = false
`,
    );
    const { manifestPath } = await writePluginManifest(
      home,
      "oh-my-codex-local",
      "oh-my-codex",
      {
        name: "oh-my-codex",
        displayName: "Oh My Codex Display",
        description: "Manifest description",
      },
    );
    const result = await discoverCodexPlugins({
      worktreePath: workTree,
      home,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.itemId).toBe("oh-my-codex@oh-my-codex-local");
    // Manifest metadata wins over the bare-id placeholder set from config.toml.
    expect(item?.displayName).toBe("Oh My Codex Display");
    expect(item?.description).toBe("Manifest description");
    // Config enabled=false overrides the schema default of true.
    expect(item?.enabled).toBe(false);
    expect(item?.sourcePath).toBe(manifestPath);
  });

  it("emits codex-plugin-manifest-invalid for a missing-name manifest while still discovering other plugins", async () => {
    const brokenManifestPath = await writeRawPluginManifest(
      home,
      "oh-my-codex-local",
      "broken-plugin",
      JSON.stringify({ displayName: "no name field" }),
    );
    await writePluginManifest(home, "oh-my-codex-local", "good-plugin", {
      name: "good",
      displayName: "Good Plugin",
    });

    const result = await discoverCodexPlugins({
      worktreePath: workTree,
      home,
    });

    const ids = result.items.map((p) => p.itemId).sort();
    expect(ids).toEqual(["good@oh-my-codex-local"]);

    const diag = result.diagnostics.find(
      (d) => d.code === "codex-plugin-manifest-invalid",
    );
    expect(diag).toBeDefined();
    expect(diag?.sourcePath).toBe(brokenManifestPath);
    expect(diag?.severity).toBe("warning");
  });

  it("emits codex-config-toml-invalid when config.toml is malformed, but still discovers marketplace plugins", async () => {
    const brokenConfigPath = await writeConfigToml(
      home,
      `[plugins."oh-my-codex"
enabled = true
`, // unclosed table header → parse error
    );
    await writePluginManifest(home, "oh-my-codex-local", "oh-my-codex", {
      name: "oh-my-codex",
    });

    const result = await discoverCodexPlugins({
      worktreePath: workTree,
      home,
    });

    expect(result.discoverySupport).toBe("available");
    const configDiag = result.diagnostics.find(
      (d) => d.code === "codex-config-toml-invalid",
    );
    expect(configDiag).toBeDefined();
    expect(configDiag?.sourcePath).toBe(brokenConfigPath);

    // The marketplace plugin is still discovered (with default enabled=true);
    // the config error only suppresses config-derived overrides.
    const ids = result.items.map((p) => p.itemId).sort();
    expect(ids).toEqual(["oh-my-codex@oh-my-codex-local"]);
    const item = result.items.find(
      (p) => p.itemId === "oh-my-codex@oh-my-codex-local",
    );
    expect(item?.enabled).toBe(true);
  });
});

describe("Codex plugin-bundled skill attribution", () => {
  it("attributes a SKILL.md under a marketplace plugin directory to its owning plugin id", async () => {
    const { pluginDir } = await writePluginManifest(
      home,
      "oh-my-codex-local",
      "oh-my-codex",
      { name: "oh-my-codex" },
    );
    await writeSkill(
      path.join(pluginDir, "skills"),
      "foo",
      "plugin skill body",
    );

    const result = await discoverCodexSkills({
      worktreePath: workTree,
      home,
    });

    const fooSkills = result.items.filter((s) => s.itemId === "foo");
    expect(fooSkills).toHaveLength(1);
    expect(fooSkills[0]?.owningPluginId).toBe("oh-my-codex@oh-my-codex-local");
    // Plugin-bundled skills appear with user-layer source (they live under
    // ~/.codex/marketplaces/...) but are attributed to their owning plugin so
    // the resolver inherits plugin-layer disable state.
    expect(fooSkills[0]?.source).toBe("user");
  });

  it("does not attribute project- or user-scoped skills to any plugin", async () => {
    await writeSkill(path.join(workTree, ".agents/skills"), "proj1", "p");
    await writeSkill(path.join(home, ".codex/skills"), "user1", "u");

    const result = await discoverCodexSkills({
      worktreePath: workTree,
      home,
    });

    for (const item of result.items) {
      expect(item.owningPluginId).toBeUndefined();
    }
    const ids = result.items.map((i) => i.itemId).sort();
    expect(ids).toEqual(["proj1", "user1"]);
  });

  it("skips plugin-bundled skill walking for disabled plugins", async () => {
    await writeConfigToml(
      home,
      `[plugins."oh-my-codex@oh-my-codex-local"]
enabled = false
`,
    );
    const { pluginDir } = await writePluginManifest(
      home,
      "oh-my-codex-local",
      "oh-my-codex",
      { name: "oh-my-codex" },
    );
    await writeSkill(
      path.join(pluginDir, "skills"),
      "foo",
      "should be skipped",
    );

    const result = await discoverCodexSkills({
      worktreePath: workTree,
      home,
    });

    const fooSkills = result.items.filter((s) => s.itemId === "foo");
    expect(fooSkills).toHaveLength(0);
  });
});
