/**
 * The `cctl` help registry (docs/design/cc-cli/04 §2). Aggregates the colocated
 * `src/cli/commands/*.help.ts` entries into one `Map` keyed by `pathKey`, and is
 * the single source from which help text, per-command `checkFlags` allowlists,
 * the parse-time boolean-flag set, and the top-level usage derive.
 *
 * The aggregation + resolution logic is exported as pure functions (they take an
 * explicit registry) so the validation rules can be unit-tested against crafted
 * entry sets without the module singleton (engineering-principles: extract pure
 * functions). The singleton-backed convenience wrappers (`helpEntryFor`,
 * `flagNamesFor`, …) are what the CLI dispatch and command modules call.
 *
 * Must not import from `shared.ts` — that would cycle the import graph
 * (`shared.ts` → `help-registry.ts`).
 */

import { askHelpEntries } from "./commands/ask.help";
import { charterHelpEntries } from "./commands/charter.help";
import { agentHelpEntries } from "./commands/agent.help";
import { conversationHelpEntries } from "./commands/conversation.help";
import { decisionsHelpEntries } from "./commands/decisions.help";
import { docsHelpEntries } from "./commands/docs.help";
import { devHelpEntries } from "./commands/dev.help";
import { fixtureHelpEntries } from "./commands/fixture.help";
import { metaHelpEntries } from "./commands/meta.help";
import { notifyHelpEntries } from "./commands/notify.help";
import { specHelpEntries } from "./commands/spec/spec.help";
import { ticketHelpEntries } from "./commands/ticket.help";
import { workflowHelpEntries } from "./commands/workflow.help";
import {
  buildHelpJson,
  renderGroupHelpText,
  renderLeafHelpText,
  renderTopUsageText,
  type HelpContextBlock,
} from "./help-render";
import type { CommandHelpEntry } from "./help-types";
import { pathKey } from "./help-types";

/**
 * Build the registry map from a flat entry list, throwing at build time on a
 * malformed registry so a bad entry fails every test run rather than surfacing
 * in an agent session (docs/design/cc-cli/04 §2.2):
 *   (a) two entries share a path key, or
 *   (b) a length-≥2 entry's immediate parent group node is absent.
 */
export function buildHelpRegistry(
  entries: CommandHelpEntry[],
): Map<string, CommandHelpEntry> {
  const registry = new Map<string, CommandHelpEntry>();
  for (const entry of entries) {
    const key = pathKey(entry.path);
    if (registry.has(key)) {
      throw new Error(`help registry: duplicate command path "${key}"`);
    }
    registry.set(key, entry);
  }
  for (const entry of entries) {
    if (entry.path.length < 2) continue;
    const parentKey = pathKey(entry.path.slice(0, -1));
    if (!registry.has(parentKey)) {
      throw new Error(
        `help registry: entry "${pathKey(entry.path)}" has no parent group node "${parentKey}"`,
      );
    }
  }
  return registry;
}

/**
 * Longest-prefix resolution: return the deepest registered entry that is a
 * prefix of `path`. `["workflow","create","extra"]` resolves `["workflow",
 * "create"]`; an entirely unknown root resolves nothing.
 */
export function resolveHelpEntry(
  registry: Map<string, CommandHelpEntry>,
  path: string[],
): CommandHelpEntry | undefined {
  for (let len = path.length; len >= 1; len--) {
    const entry = registry.get(pathKey(path.slice(0, len)));
    if (entry) return entry;
  }
  return undefined;
}

/** Direct children of `path` (entries exactly one segment longer), in registry order. */
export function childHelpEntries(
  registry: Map<string, CommandHelpEntry>,
  path: string[],
): CommandHelpEntry[] {
  const prefix = pathKey(path);
  const children: CommandHelpEntry[] = [];
  for (const entry of registry.values()) {
    if (
      entry.path.length === path.length + 1 &&
      pathKey(entry.path.slice(0, path.length)) === prefix
    ) {
      children.push(entry);
    }
  }
  return children;
}

/** A group node is any entry that has ≥ 1 direct child. */
export function isGroupNode(
  registry: Map<string, CommandHelpEntry>,
  entry: CommandHelpEntry,
): boolean {
  return childHelpEntries(registry, entry.path).length > 0;
}

/** The command-specific flag names for a path key, for `checkFlags`. */
export function flagNamesFrom(
  registry: Map<string, CommandHelpEntry>,
  key: string,
): string[] {
  const entry = registry.get(key);
  if (!entry) {
    throw new Error(
      `help registry: no entry for "${key}" — cannot derive flag names`,
    );
  }
  return entry.flags.map((flag) => flag.name);
}

/** The union of every `kind: "boolean"` flag name across the registry. */
export function booleanFlagNamesFrom(
  registry: Map<string, CommandHelpEntry>,
): string[] {
  const names = new Set<string>();
  for (const entry of registry.values()) {
    for (const flag of entry.flags) {
      if (flag.kind === "boolean") names.add(flag.name);
    }
  }
  return [...names];
}

/**
 * The boolean-flag arg forms (`--name`) for the command `path` resolves to
 * (longest-prefix). The parse-time boolean set is resolved PER COMMAND, not
 * globally, so a flag name may be `boolean` for one command and `value` for
 * another — e.g. `workflow get --config` (boolean section selector, doc 05) vs
 * `workflow live get --config <id>` (value, doc 06). Falls back to the global
 * union when `path` resolves no entry (an unknown command — classification is
 * moot, dispatch fails regardless).
 */
export function booleanFlagArgsFrom(
  registry: Map<string, CommandHelpEntry>,
  path: string[],
): string[] {
  const entry = resolveHelpEntry(registry, path);
  if (!entry) return booleanFlagNamesFrom(registry).map((name) => `--${name}`);
  return entry.flags
    .filter((flag) => flag.kind === "boolean")
    .map((flag) => `--${flag.name}`);
}

/** Level-1 (top-level) entries, in registry order. */
export function level1Entries(entries: CommandHelpEntry[]): CommandHelpEntry[] {
  return entries.filter((entry) => entry.path.length === 1);
}

/**
 * The aggregated entry list — spreads the colocated `*.help.ts` exports. The
 * migration context extends this to the full command inventory (doc 04 §2.4).
 */
const ENTRIES: CommandHelpEntry[] = [
  ...askHelpEntries,
  ...notifyHelpEntries,
  ...docsHelpEntries,
  ...devHelpEntries,
  ...fixtureHelpEntries,
  ...workflowHelpEntries,
  ...charterHelpEntries,
  ...decisionsHelpEntries,
  ...agentHelpEntries,
  ...conversationHelpEntries,
  ...ticketHelpEntries,
  ...specHelpEntries,
  ...metaHelpEntries,
];

/** The module singleton — throws at import time on a malformed registry. */
const REGISTRY = buildHelpRegistry(ENTRIES);

export function allHelpEntries(): CommandHelpEntry[] {
  return ENTRIES;
}

export function helpEntryFor(path: string[]): CommandHelpEntry | undefined {
  return resolveHelpEntry(REGISTRY, path);
}

export function childEntriesOf(path: string[]): CommandHelpEntry[] {
  return childHelpEntries(REGISTRY, path);
}

export function isGroup(entry: CommandHelpEntry): boolean {
  return isGroupNode(REGISTRY, entry);
}

export function flagNamesFor(key: string): string[] {
  return flagNamesFrom(REGISTRY, key);
}

export function booleanFlagNames(): string[] {
  return booleanFlagNamesFrom(REGISTRY);
}

export function booleanFlagArgsForCommand(path: string[]): string[] {
  return booleanFlagArgsFrom(REGISTRY, path);
}

export function renderTopUsage(): string {
  return renderTopUsageText(level1Entries(ENTRIES));
}

/**
 * Render an entry to help text, dispatching leaf-vs-group by whether it has
 * children. `extraContextBlocks` is the seam for server-rendered dynamic context
 * (docs/design/cc-cli/04 §4) — empty until that context lands.
 */
export function renderHelpText(
  entry: CommandHelpEntry,
  extraContextBlocks: HelpContextBlock[] = [],
): string {
  const children = childEntriesOf(entry.path);
  return children.length > 0
    ? renderGroupHelpText(entry, children)
    : renderLeafHelpText(entry, extraContextBlocks);
}

/**
 * The JSON help envelope for an entry (docs/design/cc-cli/04 §3.3), with any
 * server-rendered dynamic context blocks (§4) threaded through under
 * `context.blocks`. `extraContextBlocks` is empty for static/fail-open help.
 */
export function helpJsonFor(
  entry: CommandHelpEntry,
  extraContextBlocks: HelpContextBlock[] = [],
): {
  ok: true;
  help: ReturnType<typeof buildHelpJson>["help"];
} {
  return buildHelpJson(entry, extraContextBlocks);
}
