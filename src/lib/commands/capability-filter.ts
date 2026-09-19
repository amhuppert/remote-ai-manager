import type { AgentCapabilityViewResponse } from "@/lib/agent-capabilities/schemas";
import type { CommandItem } from "@/lib/commands/schemas";
/**
 * Filter a flat catalog of slash/skill items down to those that the active
 * agent backend will actually accept, given Command Center's effective
 * capability configuration.
 *
 * The popup catalog comes from a filesystem scan and includes everything the
 * user has installed — even plugins/skills that CC has disabled at the
 * global/project/session/conversation layer. The SDK only loads items whose
 * resolved selection enables them. A conversation snapshot takes precedence
 * over pending configuration changes when the backend applies at creation.
 */
export function filterDisabledCommandItems(
  items: CommandItem[],
  pluginsView: AgentCapabilityViewResponse | undefined,
  skillsView: AgentCapabilityViewResponse | undefined,
): CommandItem[] {
  if (skillsView?.appliedCommands) return skillsView.appliedCommands;
  const disabledPluginShorts = collectDisabledPluginShorts(pluginsView);
  const disabledSkillKeys = collectDisabledSkillKeys(skillsView);

  return items.filter((item) => {
    // Native catalog entries already reflect the runtime's applied config;
    // pending UI capability edits must not override that authoritative list.
    if (item.skillPath) return true;
    if (item.source === "managed") return true;
    if (item.type === "command") {
      return !disabledPluginShorts.has(item.source);
    }
    return !disabledSkillKeys.has(skillKeyForItem(item));
  });
}

function collectDisabledPluginShorts(
  view: AgentCapabilityViewResponse | undefined,
): Set<string> {
  const shorts = new Set<string>();
  if (!view) return shorts;
  for (const row of view.items) {
    if (row.appliedEnabled ?? row.effectiveState.enabled) continue;
    const shortName = pluginShortFromId(row.itemId);
    if (shortName) shorts.add(shortName);
  }
  return shorts;
}

function collectDisabledSkillKeys(
  view: AgentCapabilityViewResponse | undefined,
): Set<string> {
  const keys = new Set<string>();
  if (!view) return keys;
  for (const row of view.items) {
    if (row.appliedEnabled ?? row.effectiveState.enabled) continue;
    if (row.source.kind === "plugin") {
      const shortName = pluginShortFromId(row.source.pluginId);
      if (shortName) keys.add(`${shortName}:${row.itemId}`);
      continue;
    }
    keys.add(row.itemId);
  }
  return keys;
}

function skillKeyForItem(item: CommandItem): string {
  const stripped = item.name.replace(/^[/$]/, "");
  return stripped;
}

function pluginShortFromId(pluginId: string): string | undefined {
  const short = pluginId.split("@")[0];
  return short && short.length > 0 ? short : undefined;
}
