/**
 * Which commands a backend's composer offers, decided from registered data.
 *
 * The composer used to ask "is this Codex?" twice — once to pick the capability
 * cascades and once to pick the catalog. Both questions have registered
 * answers: the capability metadata registry knows which cascades a backend
 * owns, and the backend metadata declares the prefix its skills are triggered
 * by. A backend that owns no cascade and discovers no commands therefore gets
 * an honest, empty answer instead of another backend's (spec D14).
 */

import type { SkillTriggerPrefix } from "@/lib/agent-backends/descriptor";
import { BUILT_IN_COMMANDS } from "./built-in-commands";
import type { CommandItem } from "./schemas";

/** The prefix Command Center's own slash commands are triggered by. */
const SLASH_COMMAND_PREFIX = "/";

export interface BackendCommandCatalogInput {
  /** Items the backend's command discovery returned, capability-filtered. */
  discovered: readonly CommandItem[];
  /** The backend's declared skill trigger, from its catalog metadata. */
  skillTriggerPrefix: SkillTriggerPrefix;
  /** The character the user typed to open the popup. */
  triggerChar: string;
}

/**
 * A backend whose skill trigger is NOT the slash owns two separate surfaces:
 * its discovered items are skills reached under that prefix, and the slash
 * belongs to Command Center's own commands alone.
 */
function usesDedicatedSkillTrigger(prefix: SkillTriggerPrefix): boolean {
  return prefix !== SLASH_COMMAND_PREFIX;
}

/**
 * Whether the popup is listing the backend's skills rather than commands —
 * true only for a backend whose skills have their own prefix, opened under it.
 */
export function isSkillTriggerActive(
  skillTriggerPrefix: SkillTriggerPrefix,
  triggerChar: string,
): boolean {
  return (
    usesDedicatedSkillTrigger(skillTriggerPrefix) &&
    triggerChar === skillTriggerPrefix
  );
}

export function composeBackendCommandCatalog({
  discovered,
  skillTriggerPrefix,
  triggerChar,
}: BackendCommandCatalogInput): CommandItem[] {
  if (usesDedicatedSkillTrigger(skillTriggerPrefix)) {
    return isSkillTriggerActive(skillTriggerPrefix, triggerChar)
      ? discovered.filter((item) => item.name.startsWith(skillTriggerPrefix))
      : [...BUILT_IN_COMMANDS];
  }

  // The slash is both surfaces at once: a discovered command shadows the
  // built-in of the same name rather than appearing twice beside it.
  const discoveredSlashCommands = discovered.filter(
    (item) =>
      item.name.startsWith(SLASH_COMMAND_PREFIX) && item.name !== "/spec",
  );
  const discoveredNames = new Set(
    discoveredSlashCommands.map((item) => item.name),
  );
  return [
    ...BUILT_IN_COMMANDS.filter((item) => !discoveredNames.has(item.name)),
    ...discoveredSlashCommands,
  ];
}
