import { describe, it, expect } from "vitest";
import {
  getPresets,
  getPreset,
  generateHelperScript,
  generatePresetScript,
} from "./dev-server-presets";

describe("PresetRegistry", () => {
  describe("getPresets", () => {
    it("returns all available presets", () => {
      const presets = getPresets();
      expect(presets).toHaveLength(2);
      const ids = presets.map((p) => p.id);
      expect(ids).toContain("nextjs");
      expect(ids).toContain("storybook");
    });

    it("each preset has required metadata fields", () => {
      for (const preset of getPresets()) {
        expect(preset.id).toBeTruthy();
        expect(preset.name).toBeTruthy();
        expect(preset.description).toBeTruthy();
        expect(preset.badge).toHaveLength(1);
        expect(preset.basePort).toBeGreaterThan(0);
        expect(preset.serverName).toBeTruthy();
        expect(preset.command).toBeTruthy();
        expect(preset.scriptFileName).toMatch(/\.sh$/);
      }
    });
  });

  describe("getPreset", () => {
    it("returns the Next.js preset by ID", () => {
      const preset = getPreset("nextjs");
      expect(preset).toBeDefined();
      expect(preset!.name).toBe("Next.js");
      expect(preset!.basePort).toBe(3000);
      expect(preset!.serverName).toBe("nextjs");
    });

    it("returns the Storybook preset by ID", () => {
      const preset = getPreset("storybook");
      expect(preset).toBeDefined();
      expect(preset!.name).toBe("Storybook");
      expect(preset!.basePort).toBe(6006);
      expect(preset!.serverName).toBe("storybook");
    });

    it("returns undefined for unknown preset ID", () => {
      expect(getPreset("unknown")).toBeUndefined();
    });
  });

  describe("generateHelperScript", () => {
    it("generates a valid shell script starting with shebang", () => {
      const script = generateHelperScript();
      expect(script).toMatch(/^#!/);
    });

    it("contains the check_port function", () => {
      const script = generateHelperScript();
      expect(script).toContain("check_port()");
    });

    it("contains the get_pid_on_port function", () => {
      const script = generateHelperScript();
      expect(script).toContain("get_pid_on_port()");
    });

    it("contains the get_process_cwd function", () => {
      const script = generateHelperScript();
      expect(script).toContain("get_process_cwd()");
    });

    it("contains the find_available_port function", () => {
      const script = generateHelperScript();
      expect(script).toContain("find_available_port()");
    });

    it("uses exit codes 0, 1, 2 for port status", () => {
      const script = generateHelperScript();
      // 0 = available, 1 = owned by this worktree, 2 = conflict
      expect(script).toContain("return 0");
      expect(script).toContain("return 1");
      expect(script).toContain("return 2");
    });

    it("uses /proc for process cwd resolution", () => {
      const script = generateHelperScript();
      expect(script).toContain("/proc/");
    });

    it("uses ss for port checking", () => {
      const script = generateHelperScript();
      expect(script).toContain("ss ");
    });
  });

  describe("generatePresetScript", () => {
    it("generates a Next.js startup script", () => {
      const script = generatePresetScript("nextjs");
      expect(script).toMatch(/^#!/);
      expect(script).toContain("CSM_PORT=");
      expect(script).toContain("_helpers.sh");
      expect(script).toContain("3000");
      expect(script).toContain("next dev");
    });

    it("generates a Storybook startup script", () => {
      const script = generatePresetScript("storybook");
      expect(script).toMatch(/^#!/);
      expect(script).toContain("CSM_PORT=");
      expect(script).toContain("_helpers.sh");
      expect(script).toContain("6006");
      expect(script).toContain("storybook dev");
    });

    it("emits CSM_PORT before exec for immediate detection", () => {
      for (const id of ["nextjs", "storybook"]) {
        const script = generatePresetScript(id);
        const csmPortLine = script
          .split("\n")
          .findIndex((l) => l.includes('echo "CSM_PORT=$PORT"'));
        const execLine = script
          .split("\n")
          .findIndex((l) => l.startsWith("exec "));
        expect(csmPortLine).toBeGreaterThan(-1);
        expect(execLine).toBeGreaterThan(-1);
        expect(csmPortLine).toBeLessThan(execLine);
      }
    });

    it("sources _helpers.sh relative to script directory", () => {
      const script = generatePresetScript("nextjs");
      expect(script).toContain('SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"');
      expect(script).toContain('. "$SCRIPT_DIR/_helpers.sh"');
    });

    it("handles the 3 port check cases: available, owned, conflict", () => {
      const script = generatePresetScript("nextjs");
      // Available: exit code 0
      expect(script).toContain("0)");
      // Owned: exit code 1 — reuse
      expect(script).toContain("1)");
      // Conflict: exit code 2 — find_available_port
      expect(script).toContain("2)");
    });

    it("throws for unknown preset ID", () => {
      expect(() => generatePresetScript("unknown")).toThrow();
    });
  });
});
