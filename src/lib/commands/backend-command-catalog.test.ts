import { describe, expect, it } from "vitest";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { skillTriggerPrefixForBackend } from "@/lib/agent-backends/catalog";
import { commandCascadesForBackend } from "@/lib/agent-capabilities/metadata";
import { BUILT_IN_COMMANDS } from "./built-in-commands";
import {
  composeBackendCommandCatalog,
  isSkillTriggerActive,
} from "./backend-command-catalog";
import type { CommandItem } from "./schemas";

function command(name: string): CommandItem {
  return { name, description: name, type: "command", source: "project" };
}

function skill(name: string): CommandItem {
  return { name, description: name, type: "skill", source: "project" };
}

const builtInNames = BUILT_IN_COMMANDS.map((item) => item.name);

describe("commandCascadesForBackend", () => {
  it("resolves each backend's plugin and skill cascades from the registry", () => {
    expect(commandCascadesForBackend("claude")).toEqual({
      plugins: "claude-plugins",
      skills: "claude-skills",
    });
    expect(commandCascadesForBackend("codex")).toEqual({
      plugins: "codex-plugins",
      skills: "codex-skills",
    });
  });

  // Cursor attaches under `settingSources: []` and declares `capabilityKinds:
  // []`, so it owns no cascade at all. Naming one would query a cascade the
  // registry does not have (spec D4).
  it("resolves no cascade for a backend that registers none", () => {
    expect(commandCascadesForBackend("cursor")).toEqual({
      plugins: null,
      skills: null,
    });
  });

  it("never invents a cascade for a registered backend", () => {
    for (const backend of agentBackendSchema.options) {
      const { plugins, skills } = commandCascadesForBackend(backend);
      for (const kind of [plugins, skills]) {
        if (kind !== null) expect(kind.startsWith(`${backend}-`)).toBe(true);
      }
    }
  });
});

describe("isSkillTriggerActive", () => {
  it("is true only for a dedicated skill prefix opened under itself", () => {
    expect(isSkillTriggerActive("$", "$")).toBe(true);
    expect(isSkillTriggerActive("$", "/")).toBe(false);
    // A backend whose skills share the slash has no separate skills surface,
    // so the slash always means "commands" for it.
    expect(isSkillTriggerActive("/", "/")).toBe(false);
  });

  it("never treats the slash trigger as skill mode, whatever the backend", () => {
    for (const backend of agentBackendSchema.options) {
      const prefix = skillTriggerPrefixForBackend(backend);
      expect(isSkillTriggerActive(prefix, "/")).toBe(false);
      // Opening under the backend's OWN prefix is skill mode only where that
      // prefix is a surface of its own.
      expect(isSkillTriggerActive(prefix, prefix)).toBe(prefix !== "/");
    }
  });
});

describe("composeBackendCommandCatalog", () => {
  it("merges discovered slash commands with the built-ins for a slash-trigger backend", () => {
    const catalog = composeBackendCommandCatalog({
      discovered: [command("/deploy"), command("/commit"), skill("$audit")],
      skillTriggerPrefix: "/",
      triggerChar: "/",
    });

    expect(catalog.map((i) => i.name)).toContain("/deploy");
    // A discovered command shadows the built-in of the same name rather than
    // appearing twice beside it.
    const commit = catalog.filter((i) => i.name === "/commit");
    expect(commit).toHaveLength(1);
    expect(commit[0]?.source).toBe("project");
    // Items under another prefix are not slash commands.
    expect(catalog.map((i) => i.name)).not.toContain("$audit");
  });

  it("offers only the built-ins to a dedicated-skill-trigger backend under the slash trigger", () => {
    const catalog = composeBackendCommandCatalog({
      discovered: [command("/deploy"), skill("$audit")],
      skillTriggerPrefix: "$",
      triggerChar: "/",
    });

    expect(catalog.map((i) => i.name)).toEqual(builtInNames);
  });

  it("offers only the backend's own skills under its dedicated skill trigger", () => {
    const catalog = composeBackendCommandCatalog({
      discovered: [command("/deploy"), skill("$audit"), skill("$lint")],
      skillTriggerPrefix: "$",
      triggerChar: "$",
    });

    expect(catalog.map((i) => i.name)).toEqual(["$audit", "$lint"]);
  });

  // Cursor's command discovery returns a bounded empty result and its skill
  // prefix is the slash, so the composer offers Command Center's own commands
  // and nothing it would have to invent (spec D14).
  it("offers exactly the built-ins for a backend whose discovery returns nothing", () => {
    const catalog = composeBackendCommandCatalog({
      discovered: [],
      skillTriggerPrefix: skillTriggerPrefixForBackend("cursor"),
      triggerChar: "/",
    });

    expect(catalog.map((i) => i.name)).toEqual(builtInNames);
  });
});
