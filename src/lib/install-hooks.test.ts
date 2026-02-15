import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir, rm, readFile, stat } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Test directory — each run gets a unique temp dir
// ---------------------------------------------------------------------------

const TEST_DIR = path.join("/tmp", "csm-install-hooks-test-" + Date.now());

// ---------------------------------------------------------------------------
// Mock os.homedir to use test directory
// ---------------------------------------------------------------------------

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual, homedir: () => TEST_DIR },
    homedir: () => TEST_DIR,
  };
});

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await mkdir(path.join(TEST_DIR, ".claude"), { recursive: true });
  vi.resetModules();
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ===========================================================================
// generateHookScript
// ===========================================================================

describe("generateHookScript", () => {
  it("returns a string starting with bash shebang", async () => {
    const { generateHookScript } = await import("./install-hooks");
    const script = generateHookScript();
    expect(script).toMatch(/^#!\/usr\/bin\/env bash/);
  });

  it("contains the csm marker comment", async () => {
    const { generateHookScript } = await import("./install-hooks");
    const script = generateHookScript();
    expect(script).toContain("# csm");
  });

  it("contains curl to localhost:3000/api/hooks", async () => {
    const { generateHookScript } = await import("./install-hooks");
    const script = generateHookScript();
    expect(script).toContain("http://localhost:3000/api/hooks");
  });

  it("backgrounds the curl command", async () => {
    const { generateHookScript } = await import("./install-hooks");
    const script = generateHookScript();
    expect(script).toContain("&");
  });
});

// ===========================================================================
// mergeHooksIntoSettings
// ===========================================================================

describe("mergeHooksIntoSettings", () => {
  it("creates hooks for both events from empty settings", async () => {
    const { mergeHooksIntoSettings } = await import("./install-hooks");
    const result = mergeHooksIntoSettings({}, "/path/to/csm-hook.sh");

    const hooks = result.hooks as Record<string, unknown[]>;
    expect(hooks.UserPromptSubmit).toHaveLength(1);
    expect(hooks.Stop).toHaveLength(1);
  });

  it("preserves non-CSM hooks in the same event", async () => {
    const { mergeHooksIntoSettings } = await import("./install-hooks");
    const existing = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "echo other-tool" }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "notify-other" }] }],
      },
    };

    const result = mergeHooksIntoSettings(existing, "/path/to/csm-hook.sh");
    const hooks = result.hooks as Record<string, unknown[]>;

    // Each event: 1 original non-CSM + 1 new CSM = 2
    expect(hooks.UserPromptSubmit).toHaveLength(2);
    expect(hooks.Stop).toHaveLength(2);
  });

  it("replaces existing CSM hooks (idempotent)", async () => {
    const { mergeHooksIntoSettings } = await import("./install-hooks");
    const existing = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "/old/path/csm-hook.sh" }] },
        ],
        Stop: [
          { hooks: [{ type: "command", command: "cat | curl ... # csm" }] },
        ],
      },
    };

    const result = mergeHooksIntoSettings(existing, "/new/csm-hook.sh");
    const hooks = result.hooks as Record<string, unknown[]>;

    // Old CSM entries replaced, only 1 per event
    expect(hooks.UserPromptSubmit).toHaveLength(1);
    expect(hooks.Stop).toHaveLength(1);

    const promptEntry = hooks.UserPromptSubmit![0] as {
      hooks: Array<{ command: string }>;
    };
    expect(promptEntry.hooks[0]!.command).toBe("/new/csm-hook.sh");
  });

  it("preserves other top-level settings keys", async () => {
    const { mergeHooksIntoSettings } = await import("./install-hooks");
    const existing = {
      permissions: { allow: ["Read"] },
      model: "claude-sonnet-4-5-20250929",
    };

    const result = mergeHooksIntoSettings(existing, "/csm-hook.sh");

    expect(result.permissions).toEqual({ allow: ["Read"] });
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.hooks).toBeDefined();
  });

  it("preserves hooks for events CSM does not use", async () => {
    const { mergeHooksIntoSettings } = await import("./install-hooks");
    const existing = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "lint.sh" }] },
        ],
      },
    };

    const result = mergeHooksIntoSettings(existing, "/csm-hook.sh");
    const hooks = result.hooks as Record<string, unknown[]>;

    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.UserPromptSubmit).toHaveLength(1);
    expect(hooks.Stop).toHaveLength(1);
  });

  it("running merge twice produces same result", async () => {
    const { mergeHooksIntoSettings } = await import("./install-hooks");
    const first = mergeHooksIntoSettings({}, "/csm-hook.sh");
    const second = mergeHooksIntoSettings(
      first as Record<string, unknown>,
      "/csm-hook.sh",
    );

    const hooks = second.hooks as Record<string, unknown[]>;
    expect(hooks.UserPromptSubmit).toHaveLength(1);
    expect(hooks.Stop).toHaveLength(1);
  });
});

// ===========================================================================
// installHooks (integration — uses real filesystem via mocked homedir)
// ===========================================================================

describe("installHooks", () => {
  it("creates hooks directory and script file", async () => {
    const { installHooks } = await import("./install-hooks");
    const result = await installHooks();

    const hookScript = await readFile(result.hookScriptPath, "utf-8");
    expect(hookScript).toContain("#!/usr/bin/env bash");
    expect(hookScript).toContain("csm");
  });

  it("script file is executable", async () => {
    const { installHooks } = await import("./install-hooks");
    const result = await installHooks();

    const fileStat = await stat(result.hookScriptPath);
    // Check owner execute bit
    const isExecutable = (fileStat.mode & 0o100) !== 0;
    expect(isExecutable).toBe(true);
  });

  it("creates settings.json when none exists", async () => {
    const { installHooks } = await import("./install-hooks");
    const result = await installHooks();

    const settings = JSON.parse(await readFile(result.settingsPath, "utf-8"));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("preserves existing non-CSM content in settings.json", async () => {
    const settingsPath = path.join(TEST_DIR, ".claude", "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "lint.sh" }] }],
        },
      }),
      "utf-8",
    );

    const { installHooks } = await import("./install-hooks");
    const result = await installHooks();

    const settings = JSON.parse(await readFile(result.settingsPath, "utf-8"));
    expect(settings.permissions).toEqual({ allow: ["Read"] });
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("is idempotent — re-running produces correct result", async () => {
    const { installHooks } = await import("./install-hooks");

    await installHooks();
    const result = await installHooks();

    const settings = JSON.parse(await readFile(result.settingsPath, "utf-8"));
    // Should still have exactly 1 CSM entry per event, not duplicated
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("handles malformed settings.json gracefully", async () => {
    const settingsPath = path.join(TEST_DIR, ".claude", "settings.json");
    await writeFile(settingsPath, "not valid json {{{", "utf-8");

    const { installHooks } = await import("./install-hooks");
    const result = await installHooks();

    expect(result.actions).toContain(
      "Could not parse existing settings, starting fresh",
    );

    const settings = JSON.parse(await readFile(result.settingsPath, "utf-8"));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("returns action log describing what was done", async () => {
    const { installHooks } = await import("./install-hooks");
    const result = await installHooks();

    expect(result.hookScriptCreated).toBe(true);
    expect(result.settingsUpdated).toBe(true);
    expect(result.actions.length).toBeGreaterThan(0);
  });

  it("hook command in settings.json is the absolute script path", async () => {
    const { installHooks } = await import("./install-hooks");
    const result = await installHooks();

    const settings = JSON.parse(await readFile(result.settingsPath, "utf-8"));
    const entry = settings.hooks.UserPromptSubmit[0];
    expect(entry.hooks[0].command).toBe(result.hookScriptPath);
    expect(entry.hooks[0].type).toBe("command");
  });
});
