import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { installPreset, getInstalledPresets } from "./dev-server-presets";

describe("PresetInstaller", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "csm-preset-test-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  describe("installPreset", () => {
    it("creates .csm/dev-servers/ directory when missing", async () => {
      await installPreset({ projectPath: projectDir, presetId: "nextjs" });
      expect(existsSync(path.join(projectDir, ".csm", "dev-servers"))).toBe(
        true,
      );
    });

    it("writes _helpers.sh with executable permissions", async () => {
      await installPreset({ projectPath: projectDir, presetId: "nextjs" });
      const helpersPath = path.join(
        projectDir,
        ".csm",
        "dev-servers",
        "_helpers.sh",
      );
      expect(existsSync(helpersPath)).toBe(true);
      const stat = statSync(helpersPath);
      // Check that owner has execute permission
      expect(stat.mode & 0o100).toBeTruthy();
    });

    it("writes preset-specific script with executable permissions", async () => {
      await installPreset({ projectPath: projectDir, presetId: "nextjs" });
      const scriptPath = path.join(
        projectDir,
        ".csm",
        "dev-servers",
        "nextjs.sh",
      );
      expect(existsSync(scriptPath)).toBe(true);
      const stat = statSync(scriptPath);
      expect(stat.mode & 0o100).toBeTruthy();
    });

    it("creates ClaudeSessionManager.json when missing", async () => {
      await installPreset({ projectPath: projectDir, presetId: "nextjs" });
      const configPath = path.join(projectDir, "ClaudeSessionManager.json");
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.devServers).toHaveLength(1);
      expect(config.devServers[0].name).toBe("nextjs");
      expect(config.devServers[0].command).toBe(".csm/dev-servers/nextjs.sh");
    });

    it("appends to existing devServers array without removing entries", async () => {
      // Create existing config with a custom entry
      const configPath = path.join(projectDir, "ClaudeSessionManager.json");
      await writeFile(
        configPath,
        JSON.stringify({
          initScriptPath: null,
          devServers: [{ name: "custom", command: "custom.sh" }],
        }),
      );

      await installPreset({ projectPath: projectDir, presetId: "nextjs" });

      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.devServers).toHaveLength(2);
      expect(config.devServers[0].name).toBe("custom");
      expect(config.devServers[1].name).toBe("nextjs");
    });

    it("preserves existing config fields", async () => {
      const configPath = path.join(projectDir, "ClaudeSessionManager.json");
      await writeFile(
        configPath,
        JSON.stringify({
          initScriptPath: "/some/script.sh",
          preMergeCommand: "validate.sh",
        }),
      );

      await installPreset({ projectPath: projectDir, presetId: "storybook" });

      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.initScriptPath).toBe("/some/script.sh");
      expect(config.preMergeCommand).toBe("validate.sh");
      expect(config.devServers).toHaveLength(1);
      expect(config.devServers[0].name).toBe("storybook");
    });

    it("rejects installation when server name already exists", async () => {
      const configPath = path.join(projectDir, "ClaudeSessionManager.json");
      await writeFile(
        configPath,
        JSON.stringify({
          initScriptPath: null,
          devServers: [{ name: "nextjs", command: "old-nextjs.sh" }],
        }),
      );

      await expect(
        installPreset({ projectPath: projectDir, presetId: "nextjs" }),
      ).rejects.toThrow("already installed");
    });

    it("throws for unknown preset ID", async () => {
      await expect(
        installPreset({ projectPath: projectDir, presetId: "unknown" }),
      ).rejects.toThrow("Unknown preset");
    });

    it("returns list of installed files and config updated flag", async () => {
      const result = await installPreset({
        projectPath: projectDir,
        presetId: "nextjs",
      });
      expect(result.installedFiles).toContain(".csm/dev-servers/_helpers.sh");
      expect(result.installedFiles).toContain(".csm/dev-servers/nextjs.sh");
      expect(result.installedFiles).toContain("ClaudeSessionManager.json");
      expect(result.configUpdated).toBe(true);
    });

    it("can install multiple presets sequentially", async () => {
      await installPreset({ projectPath: projectDir, presetId: "nextjs" });
      await installPreset({
        projectPath: projectDir,
        presetId: "storybook",
      });

      const configPath = path.join(projectDir, "ClaudeSessionManager.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.devServers).toHaveLength(2);

      const helpersExists = existsSync(
        path.join(projectDir, ".csm", "dev-servers", "_helpers.sh"),
      );
      const nextjsExists = existsSync(
        path.join(projectDir, ".csm", "dev-servers", "nextjs.sh"),
      );
      const storybookExists = existsSync(
        path.join(projectDir, ".csm", "dev-servers", "storybook.sh"),
      );
      expect(helpersExists).toBe(true);
      expect(nextjsExists).toBe(true);
      expect(storybookExists).toBe(true);
    });
  });

  describe("getInstalledPresets", () => {
    it("returns empty array when no config file exists", async () => {
      const installed = await getInstalledPresets(projectDir);
      expect(installed).toEqual([]);
    });

    it("returns empty array when config has no devServers", async () => {
      await writeFile(
        path.join(projectDir, "ClaudeSessionManager.json"),
        JSON.stringify({ initScriptPath: null }),
      );
      const installed = await getInstalledPresets(projectDir);
      expect(installed).toEqual([]);
    });

    it("detects installed nextjs preset", async () => {
      await writeFile(
        path.join(projectDir, "ClaudeSessionManager.json"),
        JSON.stringify({
          initScriptPath: null,
          devServers: [
            { name: "nextjs", command: ".csm/dev-servers/nextjs.sh" },
          ],
        }),
      );
      const installed = await getInstalledPresets(projectDir);
      expect(installed).toEqual(["nextjs"]);
    });

    it("detects multiple installed presets", async () => {
      await writeFile(
        path.join(projectDir, "ClaudeSessionManager.json"),
        JSON.stringify({
          initScriptPath: null,
          devServers: [
            { name: "nextjs", command: ".csm/dev-servers/nextjs.sh" },
            { name: "storybook", command: ".csm/dev-servers/storybook.sh" },
          ],
        }),
      );
      const installed = await getInstalledPresets(projectDir);
      expect(installed).toContain("nextjs");
      expect(installed).toContain("storybook");
    });

    it("ignores non-preset server names", async () => {
      await writeFile(
        path.join(projectDir, "ClaudeSessionManager.json"),
        JSON.stringify({
          initScriptPath: null,
          devServers: [{ name: "custom-server", command: "run.sh" }],
        }),
      );
      const installed = await getInstalledPresets(projectDir);
      expect(installed).toEqual([]);
    });
  });
});
