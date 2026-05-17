import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { installPreset, getInstalledPresets } from "./dev-server-presets";

describe("PresetInstaller", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "cc-preset-test-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  describe("installPreset (default cc-assigned)", () => {
    it("does NOT create .cc/dev-servers/ directory by default", async () => {
      await installPreset({ projectPath: projectDir, presetId: "nextjs" });
      expect(existsSync(path.join(projectDir, ".cc", "dev-servers"))).toBe(
        false,
      );
    });

    it("does NOT write _helpers.sh by default", async () => {
      await installPreset({ projectPath: projectDir, presetId: "nextjs" });
      expect(
        existsSync(path.join(projectDir, ".cc", "dev-servers", "_helpers.sh")),
      ).toBe(false);
    });

    it("does NOT write preset-specific shell scripts by default", async () => {
      await installPreset({ projectPath: projectDir, presetId: "nextjs" });
      expect(
        existsSync(path.join(projectDir, ".cc", "dev-servers", "nextjs.sh")),
      ).toBe(false);
    });

    it("creates CommandCenter.json with a cc-assigned entry when missing", async () => {
      await installPreset({ projectPath: projectDir, presetId: "nextjs" });
      const configPath = path.join(projectDir, "CommandCenter.json");
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.devServers).toHaveLength(1);
      const entry = config.devServers[0];
      expect(entry.name).toBe("nextjs");
      expect(entry.command).toContain("next dev");
      expect(entry.command).toContain("$CC_ASSIGNED_PORT");
      expect(entry.command).not.toContain(".cc/dev-servers/");
      expect(entry.port.strategy).toBe("cc-assigned");
      expect(entry.port.base).toBe(3000);
      expect(entry.port.range).toBeGreaterThan(0);
      expect(entry.readiness.type).toBe("tcp");
    });

    it("writes subdir as the cwd field on the cc-assigned entry", async () => {
      await installPreset({
        projectPath: projectDir,
        presetId: "nextjs",
        subdir: "apps/web",
      });
      const configPath = path.join(projectDir, "CommandCenter.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const entry = config.devServers[0];
      expect(entry.cwd).toBe("apps/web");
      expect(
        existsSync(path.join(projectDir, ".cc", "dev-servers", "nextjs.sh")),
      ).toBe(false);
    });

    it("appends to existing devServers array without removing entries", async () => {
      const configPath = path.join(projectDir, "CommandCenter.json");
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
      expect(config.devServers[1].port.strategy).toBe("cc-assigned");
    });

    it("preserves existing config fields", async () => {
      const configPath = path.join(projectDir, "CommandCenter.json");
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
      expect(config.devServers[0].port.strategy).toBe("cc-assigned");
    });

    it("rejects installation when server name already exists", async () => {
      const configPath = path.join(projectDir, "CommandCenter.json");
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

    it("returns only CommandCenter.json in installedFiles by default", async () => {
      const result = await installPreset({
        projectPath: projectDir,
        presetId: "nextjs",
      });
      expect(result.installedFiles).toContain("CommandCenter.json");
      expect(result.installedFiles).not.toContain(
        ".cc/dev-servers/_helpers.sh",
      );
      expect(result.installedFiles).not.toContain(".cc/dev-servers/nextjs.sh");
      expect(result.configUpdated).toBe(true);
    });

    it("can install multiple presets sequentially without creating any scripts", async () => {
      await installPreset({ projectPath: projectDir, presetId: "nextjs" });
      await installPreset({
        projectPath: projectDir,
        presetId: "storybook",
      });

      const configPath = path.join(projectDir, "CommandCenter.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.devServers).toHaveLength(2);
      expect(config.devServers[0].port.strategy).toBe("cc-assigned");
      expect(config.devServers[1].port.strategy).toBe("cc-assigned");
      expect(existsSync(path.join(projectDir, ".cc", "dev-servers"))).toBe(
        false,
      );
    });
  });

  describe("installPreset (legacy opt-in)", () => {
    it("writes _helpers.sh and preset script when legacy: true is passed", async () => {
      await installPreset({
        projectPath: projectDir,
        presetId: "nextjs",
        legacy: true,
      });
      const helpersPath = path.join(
        projectDir,
        ".cc",
        "dev-servers",
        "_helpers.sh",
      );
      const scriptPath = path.join(
        projectDir,
        ".cc",
        "dev-servers",
        "nextjs.sh",
      );
      expect(existsSync(helpersPath)).toBe(true);
      expect(existsSync(scriptPath)).toBe(true);
      const helperStat = statSync(helpersPath);
      const scriptStat = statSync(scriptPath);
      expect(helperStat.mode & 0o100).toBeTruthy();
      expect(scriptStat.mode & 0o100).toBeTruthy();
    });

    it("legacy install writes a script-based CommandCenter.json entry", async () => {
      await installPreset({
        projectPath: projectDir,
        presetId: "nextjs",
        legacy: true,
      });
      const configPath = path.join(projectDir, "CommandCenter.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(config.devServers).toHaveLength(1);
      expect(config.devServers[0].name).toBe("nextjs");
      expect(config.devServers[0].command).toBe(".cc/dev-servers/nextjs.sh");
    });

    it("legacy install with subdir generates a subdir-aware script", async () => {
      await installPreset({
        projectPath: projectDir,
        presetId: "nextjs",
        subdir: "dashboard-ui",
        legacy: true,
      });
      const scriptPath = path.join(
        projectDir,
        ".cc",
        "dev-servers",
        "nextjs.sh",
      );
      const script = readFileSync(scriptPath, "utf-8");
      expect(script).toContain('APP_DIR="$WORKTREE_DIR/dashboard-ui"');
      expect(script).toContain('cd "$APP_DIR"');
    });

    it("legacy install without subdir generates a standard script", async () => {
      await installPreset({
        projectPath: projectDir,
        presetId: "nextjs",
        legacy: true,
      });
      const scriptPath = path.join(
        projectDir,
        ".cc",
        "dev-servers",
        "nextjs.sh",
      );
      const script = readFileSync(scriptPath, "utf-8");
      expect(script).not.toContain("APP_DIR");
      expect(script).toContain('find_owned_port "$BASE_PORT" "$WORKTREE_DIR"');
      expect(script).toContain(
        'find_available_port "$BASE_PORT" "$WORKTREE_DIR"',
      );
    });

    it("legacy install returns helper scripts in installedFiles", async () => {
      const result = await installPreset({
        projectPath: projectDir,
        presetId: "nextjs",
        legacy: true,
      });
      expect(result.installedFiles).toContain(".cc/dev-servers/_helpers.sh");
      expect(result.installedFiles).toContain(".cc/dev-servers/nextjs.sh");
      expect(result.installedFiles).toContain("CommandCenter.json");
    });
  });

  describe("getInstalledPresets", () => {
    it("returns empty array when no config file exists", async () => {
      const installed = await getInstalledPresets(projectDir);
      expect(installed).toEqual([]);
    });

    it("returns empty array when config has no devServers", async () => {
      await writeFile(
        path.join(projectDir, "CommandCenter.json"),
        JSON.stringify({ initScriptPath: null }),
      );
      const installed = await getInstalledPresets(projectDir);
      expect(installed).toEqual([]);
    });

    it("detects an installed cc-assigned nextjs preset", async () => {
      await writeFile(
        path.join(projectDir, "CommandCenter.json"),
        JSON.stringify({
          initScriptPath: null,
          devServers: [
            {
              name: "nextjs",
              command: "npx next dev --port $CC_ASSIGNED_PORT",
              port: { strategy: "cc-assigned", base: 3000, range: 100 },
            },
          ],
        }),
      );
      const installed = await getInstalledPresets(projectDir);
      expect(installed).toEqual(["nextjs"]);
    });

    it("detects a legacy script-based nextjs preset", async () => {
      await writeFile(
        path.join(projectDir, "CommandCenter.json"),
        JSON.stringify({
          initScriptPath: null,
          devServers: [
            { name: "nextjs", command: ".cc/dev-servers/nextjs.sh" },
          ],
        }),
      );
      const installed = await getInstalledPresets(projectDir);
      expect(installed).toEqual(["nextjs"]);
    });

    it("detects multiple installed presets", async () => {
      await writeFile(
        path.join(projectDir, "CommandCenter.json"),
        JSON.stringify({
          initScriptPath: null,
          devServers: [
            { name: "nextjs", command: ".cc/dev-servers/nextjs.sh" },
            { name: "storybook", command: ".cc/dev-servers/storybook.sh" },
          ],
        }),
      );
      const installed = await getInstalledPresets(projectDir);
      expect(installed).toContain("nextjs");
      expect(installed).toContain("storybook");
    });

    it("ignores non-preset server names", async () => {
      await writeFile(
        path.join(projectDir, "CommandCenter.json"),
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
