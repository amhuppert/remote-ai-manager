import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverCodexPlugins } from "@/lib/agent-backends/codex/capability-discovery";

let workTree: string;
let home: string;

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
    "plugins",
    "cache",
    marketplaceName,
    pluginRelPath,
    typeof manifest["version"] === "string" ? manifest["version"] : "1.0.0",
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
    "plugins",
    "cache",
    marketplaceName,
    pluginRelPath,
    "1.0.0",
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

  it("discovers a cached plugin with no config.toml entry, defaulting enabled=true", async () => {
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

  it("discovers an @scope/name plugin from its cached manifest, producing id @scope/name@marketplace", async () => {
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

  it("honors config.toml enabled=false for an @scope/name plugin id from a cached manifest", async () => {
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

  it("merges config.toml with cached manifest metadata and enablement", async () => {
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

  it("emits codex-config-toml-invalid when config.toml is malformed, but still discovers cached plugins", async () => {
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
