import { describe, it, expect } from "vitest";
import type {
  AgentCapabilityViewResponse,
  AgentCapabilityViewRow,
} from "@/lib/agent-capabilities/schemas";
import type { CommandItem } from "@/lib/commands/schemas";
import { filterDisabledCommandItems } from "./capability-filter";

function pluginItem(
  overrides: Partial<CommandItem> & { name: string; source: string },
): CommandItem {
  return {
    description: "",
    type: "command",
    ...overrides,
  };
}

function skillItem(
  overrides: Partial<CommandItem> & { name: string; source: string },
): CommandItem {
  return {
    description: "",
    type: "skill",
    ...overrides,
  };
}

function pluginRow(args: {
  pluginId: string;
  enabled: boolean;
}): AgentCapabilityViewRow {
  return {
    itemId: args.pluginId,
    displayName: args.pluginId,
    backend: "claude",
    capabilityKind: "plugin",
    cascadeKind: "claude-plugins",
    source: { kind: "plugin", pluginId: args.pluginId },
    nativeDefault: { enabled: true },
    ownEffectiveState: {
      enabled: args.enabled,
      originLayer: "global",
    },
    effectiveState: {
      enabled: args.enabled,
      originLayer: args.enabled ? "native" : "global",
    },
    originLayer: args.enabled ? "native" : "global",
    runtimeVisibility: "runtime-visible",
    runtimeEmittable: true,
    stale: false,
    applyStatus: "none",
    diagnostics: [],
  } as AgentCapabilityViewRow;
}

function skillRow(args: {
  itemId: string;
  pluginId?: string;
  scope?: "user-file" | "project-file";
  enabled: boolean;
}): AgentCapabilityViewRow {
  const source =
    args.pluginId !== undefined
      ? { kind: "plugin" as const, pluginId: args.pluginId }
      : {
          kind: (args.scope ?? "user-file") as "user-file" | "project-file",
          path: `/tmp/${args.itemId}/SKILL.md`,
        };
  return {
    itemId: args.itemId,
    displayName: args.itemId,
    backend: "claude",
    capabilityKind: "skill",
    cascadeKind: "claude-skills",
    source,
    nativeDefault: { enabled: true },
    ownEffectiveState: {
      enabled: args.enabled,
      originLayer: "native",
    },
    effectiveState: {
      enabled: args.enabled,
      originLayer: args.enabled ? "native" : "global",
    },
    originLayer: args.enabled ? "native" : "global",
    ...(args.pluginId !== undefined ? { owningPluginId: args.pluginId } : {}),
    runtimeVisibility: "runtime-visible",
    runtimeEmittable: true,
    stale: false,
    applyStatus: "none",
    diagnostics: [],
  } as AgentCapabilityViewRow;
}

function viewFor(
  cascadeKind: AgentCapabilityViewResponse["cascadeKind"],
  items: AgentCapabilityViewRow[],
): AgentCapabilityViewResponse {
  return {
    level: "conversation",
    projectName: "p",
    sessionName: "s",
    conversationId: "c",
    cascadeKind,
    backend: "claude",
    items,
    diagnostics: [],
    effectiveHash: "hash",
  } as AgentCapabilityViewResponse;
}

describe("filterDisabledCommandItems", () => {
  it("trusts native applied commands over a pending filesystem capability view", () => {
    const item = skillItem({
      name: "$review",
      source: "user",
      skillPath: "/skills/review/SKILL.md",
    });
    const view = viewFor("codex-skills", [
      skillRow({ itemId: "review", enabled: false }),
    ]);
    expect(filterDisabledCommandItems([item], undefined, view)).toEqual([item]);
  });
  it("uses the delivered skill catalog across managed bundle changes", () => {
    const current = skillItem({
      name: "/command-center:current",
      source: "managed",
    });
    const retired = skillItem({
      name: "/command-center:retired",
      source: "managed",
    });
    const view = {
      ...viewFor("cursor-skills", []),
      appliedCommands: [retired],
    };
    expect(filterDisabledCommandItems([current], undefined, view)).toEqual([
      retired,
    ]);
  });
  it("keeps the applied Cursor selection while next-conversation changes are pending", () => {
    const enabled = {
      ...skillRow({ itemId: "old", enabled: false }),
      appliedEnabled: true,
    };
    const disabled = {
      ...skillRow({ itemId: "future", enabled: true }),
      appliedEnabled: false,
    };
    const items = [
      skillItem({ name: "/old", source: "user" }),
      skillItem({ name: "/future", source: "user" }),
    ];
    expect(
      filterDisabledCommandItems(
        items,
        undefined,
        viewFor("cursor-skills", [enabled, disabled]),
      ),
    ).toEqual([items[0]]);
  });
  it("keeps managed commands despite a stale user override with the same name", () => {
    const item = skillItem({
      name: "/command-center:cc-cli",
      source: "managed",
    });
    expect(
      filterDisabledCommandItems(
        [item],
        undefined,
        viewFor("cursor-skills", [
          skillRow({ itemId: "command-center:cc-cli", enabled: false }),
        ]),
      ),
    ).toEqual([item]);
  });
  it("returns items unchanged when both views are undefined", () => {
    const items: CommandItem[] = [
      pluginItem({ name: "/foo", source: "ai-resources" }),
      skillItem({ name: "/ai-resources:approve", source: "ai-resources" }),
    ];
    const result = filterDisabledCommandItems(items, undefined, undefined);
    expect(result).toEqual(items);
  });

  it("returns items unchanged when everything in views is enabled", () => {
    const items: CommandItem[] = [
      pluginItem({ name: "/ai-resources:cmd", source: "ai-resources" }),
      skillItem({ name: "/ai-resources:approve", source: "ai-resources" }),
    ];
    const plugins = viewFor("claude-plugins", [
      pluginRow({ pluginId: "ai-resources@ai-resources", enabled: true }),
    ]);
    const skills = viewFor("claude-skills", [
      skillRow({
        itemId: "approve",
        pluginId: "ai-resources@ai-resources",
        enabled: true,
      }),
    ]);
    expect(filterDisabledCommandItems(items, plugins, skills)).toEqual(items);
  });

  it("removes plugin commands whose owning plugin is disabled", () => {
    const items: CommandItem[] = [
      pluginItem({ name: "/ai-resources:cmd", source: "ai-resources" }),
      pluginItem({ name: "/other:thing", source: "other" }),
    ];
    const plugins = viewFor("claude-plugins", [
      pluginRow({ pluginId: "ai-resources@ai-resources", enabled: false }),
      pluginRow({ pluginId: "other@market", enabled: true }),
    ]);
    const result = filterDisabledCommandItems(items, plugins, undefined);
    expect(result.map((i) => i.name)).toEqual(["/other:thing"]);
  });

  it("keeps user and project commands when no plugin view is provided", () => {
    const items: CommandItem[] = [
      pluginItem({ name: "/my-cmd", source: "user" }),
      pluginItem({ name: "/proj-cmd", source: "project" }),
    ];
    const result = filterDisabledCommandItems(items, undefined, undefined);
    expect(result).toEqual(items);
  });

  it("removes plugin skills when their cascade entry is disabled", () => {
    const items: CommandItem[] = [
      skillItem({ name: "/ai-resources:approve", source: "ai-resources" }),
      skillItem({ name: "/ai-resources:keep", source: "ai-resources" }),
    ];
    const skills = viewFor("claude-skills", [
      skillRow({
        itemId: "approve",
        pluginId: "ai-resources@ai-resources",
        enabled: false,
      }),
      skillRow({
        itemId: "keep",
        pluginId: "ai-resources@ai-resources",
        enabled: true,
      }),
    ]);
    const result = filterDisabledCommandItems(items, undefined, skills);
    expect(result.map((i) => i.name)).toEqual(["/ai-resources:keep"]);
  });

  it("removes user/project skills when disabled in the view", () => {
    const items: CommandItem[] = [
      skillItem({ name: "/my-skill", source: "user" }),
      skillItem({ name: "/keep-me", source: "user" }),
    ];
    const skills = viewFor("claude-skills", [
      skillRow({ itemId: "my-skill", scope: "user-file", enabled: false }),
      skillRow({ itemId: "keep-me", scope: "user-file", enabled: true }),
    ]);
    const result = filterDisabledCommandItems(items, undefined, skills);
    expect(result.map((i) => i.name)).toEqual(["/keep-me"]);
  });

  it("removes codex skills with $ prefix when disabled", () => {
    const items: CommandItem[] = [
      skillItem({ name: "$kiro", source: "user" }),
      skillItem({ name: "$keep", source: "user" }),
    ];
    const skills = viewFor("codex-skills", [
      skillRow({ itemId: "kiro", scope: "user-file", enabled: false }),
      skillRow({ itemId: "keep", scope: "user-file", enabled: true }),
    ]);
    const result = filterDisabledCommandItems(items, undefined, skills);
    expect(result.map((i) => i.name)).toEqual(["$keep"]);
  });

  it("removes plugin skill when owning plugin is disabled (skill cascade reflects inheritance)", () => {
    const items: CommandItem[] = [
      skillItem({ name: "/ai-resources:approve", source: "ai-resources" }),
    ];
    const plugins = viewFor("claude-plugins", [
      pluginRow({ pluginId: "ai-resources@ai-resources", enabled: false }),
    ]);
    const skills = viewFor("claude-skills", [
      skillRow({
        itemId: "approve",
        pluginId: "ai-resources@ai-resources",
        enabled: false,
      }),
    ]);
    const result = filterDisabledCommandItems(items, plugins, skills);
    expect(result).toEqual([]);
  });

  it("does not match a user skill against a plugin-cascade entry with same itemId", () => {
    const items: CommandItem[] = [
      skillItem({ name: "/approve", source: "user" }),
    ];
    const skills = viewFor("claude-skills", [
      skillRow({
        itemId: "approve",
        pluginId: "ai-resources@ai-resources",
        enabled: false,
      }),
    ]);
    const result = filterDisabledCommandItems(items, undefined, skills);
    expect(result.map((i) => i.name)).toEqual(["/approve"]);
  });
});
