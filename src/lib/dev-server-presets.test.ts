import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  getPresets,
  getPreset,
  generateHelperScript,
  generatePresetScript,
  buildSimplifiedPresetEntry,
} from "./dev-server-presets";

function runHelperWithDriver(driver: string): {
  stdout: string;
  exitCode: number;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-helper-"));
  const helperPath = path.join(dir, "_helpers.sh");
  writeFileSync(helperPath, generateHelperScript(), { mode: 0o755 });
  const driverPath = path.join(dir, "drive.sh");
  writeFileSync(
    driverPath,
    `#!/bin/sh
. "${helperPath}"
${driver}
`,
    { mode: 0o755 },
  );
  try {
    const stdout = execFileSync("sh", [driverPath], { encoding: "utf-8" });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string };
    const out =
      typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? "");
    return { stdout: out, exitCode: e.status ?? 1 };
  }
}

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

    it("contains the find_owned_port function for two-pass scanning", () => {
      const script = generateHelperScript();
      expect(script).toContain("find_owned_port()");
    });

    it("find_owned_port scans the base port itself, then upward", () => {
      const driver = `
check_port() {
  case "$1" in
    3000) return 2 ;;
    3001) return 2 ;;
    3002) return 1 ;;
    *) return 0 ;;
  esac
}
find_owned_port 3000 /tmp
`;
      const result = runHelperWithDriver(driver);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("3002");
    });

    it("find_owned_port adopts the base port immediately when owned", () => {
      const driver = `
check_port() {
  case "$1" in
    3000) return 1 ;;
    *) return 0 ;;
  esac
}
find_owned_port 3000 /tmp
`;
      const result = runHelperWithDriver(driver);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("3000");
    });

    it("find_owned_port returns a non-zero exit code when no owned port is found", () => {
      const driver = `
check_port() {
  return 0
}
find_owned_port 3000 /tmp
`;
      const result = runHelperWithDriver(driver);
      expect(result.exitCode).not.toBe(0);
    });

    it("find_available_port returns only truly free ports (skips conflicts and unknowns)", () => {
      const driver = `
check_port() {
  case "$1" in
    3000) return 2 ;;
    3001) return 2 ;;
    3002) return 0 ;;
    *) return 0 ;;
  esac
}
find_available_port 3000 /tmp
`;
      const result = runHelperWithDriver(driver);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("3002");
    });

    it("find_available_port no longer reports owned ports — that is find_owned_port's job", () => {
      const driver = `
check_port() {
  case "$1" in
    3000) return 1 ;;
    3001) return 1 ;;
    3002) return 0 ;;
    *) return 0 ;;
  esac
}
find_available_port 3000 /tmp
`;
      const result = runHelperWithDriver(driver);
      // Should skip owned ports (return 1) and pick the next available one.
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("3002");
    });

    it("uses exit codes 0, 1, 2 for port status", () => {
      const script = generateHelperScript();
      // 0 = available, 1 = owned by this worktree, 2 = conflict
      expect(script).toContain("return 0");
      expect(script).toContain("return 1");
      expect(script).toContain("return 2");
    });

    it("detects platform with uname", () => {
      const script = generateHelperScript();
      expect(script).toContain('CC_OS="$(uname -s)"');
    });

    it("uses /proc for process cwd resolution on Linux", () => {
      const script = generateHelperScript();
      expect(script).toContain("/proc/");
    });

    it("uses lsof for process cwd resolution on macOS", () => {
      const script = generateHelperScript();
      expect(script).toContain("lsof -a -p");
      expect(script).toContain("-d cwd");
    });

    it("branches get_pid_on_port by platform", () => {
      const script = generateHelperScript();
      // Linux path uses ss
      expect(script).toContain("ss ");
      // macOS path uses lsof directly
      expect(script).toContain('if [ "$CC_OS" = "Darwin" ]');
    });
  });

  describe("generatePresetScript", () => {
    it("generates a Next.js startup script", () => {
      const script = generatePresetScript("nextjs");
      expect(script).toMatch(/^#!/);
      expect(script).toContain("CC_PORT=");
      expect(script).toContain("_helpers.sh");
      expect(script).toContain("3000");
      expect(script).toContain("next dev");
    });

    it("generates a Storybook startup script", () => {
      const script = generatePresetScript("storybook");
      expect(script).toMatch(/^#!/);
      expect(script).toContain("CC_PORT=");
      expect(script).toContain("_helpers.sh");
      expect(script).toContain("6006");
      expect(script).toContain("storybook dev");
    });

    it("emits CC_PORT before exec for immediate detection", () => {
      for (const id of ["nextjs", "storybook"]) {
        const script = generatePresetScript(id);
        const ccPortLine = script
          .split("\n")
          .findIndex((l) => l.includes('echo "CC_PORT=$PORT"'));
        const execLine = script
          .split("\n")
          .findIndex((l) => l.startsWith("exec "));
        expect(ccPortLine).toBeGreaterThan(-1);
        expect(execLine).toBeGreaterThan(-1);
        expect(ccPortLine).toBeLessThan(execLine);
      }
    });

    it("sources _helpers.sh relative to script directory", () => {
      const script = generatePresetScript("nextjs");
      expect(script).toContain('SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"');
      expect(script).toContain('. "$SCRIPT_DIR/_helpers.sh"');
    });

    it("scans for an owned port before falling back to an available port", () => {
      const script = generatePresetScript("nextjs");
      const ownedIdx = script.indexOf("find_owned_port");
      const availableIdx = script.indexOf("find_available_port");
      expect(ownedIdx).toBeGreaterThan(-1);
      expect(availableIdx).toBeGreaterThan(-1);
      expect(ownedIdx).toBeLessThan(availableIdx);
    });

    it("exits early with CC_PORT when an owned port is discovered anywhere in the range", () => {
      const script = generatePresetScript("nextjs");
      const lines = script.split("\n");
      const ownedCallIdx = lines.findIndex((l) =>
        l.includes("find_owned_port"),
      );
      expect(ownedCallIdx).toBeGreaterThan(-1);
      // After the owned scan succeeds, the script must echo CC_PORT and exit
      // before reaching the available-port scan.
      const tail = lines.slice(ownedCallIdx).join("\n");
      expect(tail).toMatch(
        /echo "CC_PORT=\$[A-Z_]+"[\s\S]*exit 0[\s\S]*find_available_port/,
      );
    });

    it("storybook preset also scans owned before available", () => {
      const script = generatePresetScript("storybook");
      const ownedIdx = script.indexOf("find_owned_port");
      const availableIdx = script.indexOf("find_available_port");
      expect(ownedIdx).toBeGreaterThan(-1);
      expect(availableIdx).toBeGreaterThan(-1);
      expect(ownedIdx).toBeLessThan(availableIdx);
    });

    describe("owned-first ordering in subdir mode", () => {
      it("uses APP_DIR for both owned and available scans", () => {
        const script = generatePresetScript("nextjs", "apps/web");
        expect(script).toContain('find_owned_port "$BASE_PORT" "$APP_DIR"');
        expect(script).toContain('find_available_port "$BASE_PORT" "$APP_DIR"');
      });
    });

    it("removes stale .next/dev/lock before starting Next.js", () => {
      const script = generatePresetScript("nextjs");
      const lines = script.split("\n");
      const lockCleanup = lines.findIndex(
        (l) => l.includes("rm -f") && l.includes(".next/dev/lock"),
      );
      const execLine = lines.findIndex((l) => l.startsWith("exec "));
      expect(lockCleanup).toBeGreaterThan(-1);
      expect(execLine).toBeGreaterThan(lockCleanup);
    });

    it("removes stale .next/dev/lock in subdir mode", () => {
      const script = generatePresetScript("nextjs", "dashboard-ui");
      const lines = script.split("\n");
      const lockCleanup = lines.findIndex(
        (l) => l.includes("rm -f") && l.includes(".next/dev/lock"),
      );
      expect(lockCleanup).toBeGreaterThan(-1);
    });

    it("does not remove .next/dev/lock for non-Next.js presets", () => {
      const script = generatePresetScript("storybook");
      expect(script).not.toContain(".next/dev/lock");
    });

    it("throws for unknown preset ID", () => {
      expect(() => generatePresetScript("unknown")).toThrow();
    });
  });

  describe("buildSimplifiedPresetEntry", () => {
    it("emits a cc-assigned Next.js entry with no shell script needed", () => {
      const entry = buildSimplifiedPresetEntry("nextjs");
      expect(entry.name).toBe("nextjs");
      expect(entry.command).toContain("next dev");
      expect(entry.command).toContain("$CC_ASSIGNED_PORT");
      expect(entry.command).not.toContain(".cc/dev-servers/");
      expect(entry.port?.strategy).toBe("cc-assigned");
      expect(entry.port?.base).toBe(3000);
      expect(entry.port?.range).toBeGreaterThan(0);
      expect(entry.readiness?.type).toBe("tcp");
    });

    it("emits a cc-assigned Storybook entry on its base port", () => {
      const entry = buildSimplifiedPresetEntry("storybook");
      expect(entry.name).toBe("storybook");
      expect(entry.command).toContain("storybook dev");
      expect(entry.port?.strategy).toBe("cc-assigned");
      expect(entry.port?.base).toBe(6006);
    });

    it("threads a subdir through as the cwd", () => {
      const entry = buildSimplifiedPresetEntry("nextjs", "apps/web");
      expect(entry.cwd).toBe("apps/web");
    });

    it("throws for unknown presets", () => {
      expect(() => buildSimplifiedPresetEntry("unknown")).toThrow();
    });

    describe("with subdir", () => {
      it("generates a script that cd's into the subdirectory", () => {
        const script = generatePresetScript("nextjs", "dashboard-ui");
        expect(script).toContain('APP_DIR="$WORKTREE_DIR/dashboard-ui"');
        expect(script).toContain('cd "$APP_DIR"');
        expect(script).toContain("next dev");
      });

      it("includes directory existence check", () => {
        const script = generatePresetScript("nextjs", "dashboard-ui");
        expect(script).toContain('if [ ! -d "$APP_DIR" ]');
        expect(script).toContain("dashboard-ui/ directory not found");
      });

      it("uses APP_DIR for port ownership checks", () => {
        const script = generatePresetScript("nextjs", "dashboard-ui");
        expect(script).toContain('find_owned_port "$BASE_PORT" "$APP_DIR"');
        expect(script).toContain('find_available_port "$BASE_PORT" "$APP_DIR"');
      });

      it("includes subdir in script comment", () => {
        const script = generatePresetScript("storybook", "packages/ui");
        expect(script).toContain("(subdir: packages/ui/)");
      });

      it("without subdir uses WORKTREE_DIR for port checks", () => {
        const script = generatePresetScript("nextjs");
        expect(script).toContain(
          'find_owned_port "$BASE_PORT" "$WORKTREE_DIR"',
        );
        expect(script).toContain(
          'find_available_port "$BASE_PORT" "$WORKTREE_DIR"',
        );
        expect(script).not.toContain("APP_DIR");
      });
    });
  });
});
