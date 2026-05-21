import type { AgentCapabilityViewResponse, CommandItem } from "@/types";

/**
 * Filter a flat catalog of slash/skill items down to those that the active
 * agent backend will actually accept, given Command Center's effective
 * capability configuration.
 *
 * The popup catalog comes from a filesystem scan and includes everything the
 * user has installed — even plugins/skills that CC has disabled at the
 * global/project/session/conversation layer. The SDK only loads items whose
 * `effectiveState.enabled` is true in the corresponding cascade view, so items
 * disabled in CC must be hidden from the autocomplete or the user will pick
 * commands the agent will reject as "Unknown command".
 */
export function filterDisabledCommandItems(
  items: CommandItem[],
  pluginsView: AgentCapabilityViewResponse | undefined,
  skillsView: AgentCapabilityViewResponse | undefined,
): CommandItem[] {
  const disabledPluginShorts = collectDisabledPluginShorts(pluginsView);
  const disabledSkillKeys = collectDisabledSkillKeys(skillsView);

  return items.filter((item) => {
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
    if (row.effectiveState.enabled) continue;
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
    if (row.effectiveState.enabled) continue;
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
