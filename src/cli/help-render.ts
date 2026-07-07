/**
 * Text + JSON rendering for help-registry entries (docs/design/cc-cli/04 §3).
 *
 * Pure functions that take the data they render — a leaf entry, a group entry +
 * its children, or the level-1 entries for top usage — so they import ONLY
 * `help-types.ts` and never cycle back through `help-registry.ts`. The registry
 * decides leaf-vs-group and supplies children; these functions only format.
 */

import type {
  CommandHelpEntry,
  FlagSpec,
  HelpExample,
  RelatedRef,
  SkillRef,
} from "./help-types";
import { pathKey } from "./help-types";

/** A dynamic context block (docs/design/cc-cli/04 §4); the seam is here even though nothing supplies blocks yet. */
export interface HelpContextBlock {
  title: string;
  body: string;
}

const GLOBAL_FLAGS_POINTER = "global flags: run 'cctl --help'";

/** The hand-written global-flags block shared by the top-level usage (doc 04 §2.3). */
const GLOBAL_FLAGS_BLOCK = `global flags:
  --server <url>         CC server base URL (default: $CC_SERVER_URL)
  --token <token>        API token (default: $CC_API_TOKEN, then <configDir>/api-token)
  --project <name>       project identity (default: $CC_PROJECT)
  --session <name>       session identity (default: $CC_SESSION)
  --conversation <id>    conversation identity (default: $CC_CONVERSATION_ID)
  --json                 structured output envelope`;

function indentLines(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${pad}${line}` : line))
    .join("\n");
}

/** `--file <path>` for value flags; `--wait` for boolean flags. */
function flagSignature(flag: FlagSpec): string {
  if (flag.kind === "value") {
    const placeholder = flag.valuePlaceholder ?? "<value>";
    return `--${flag.name} ${placeholder}`;
  }
  return `--${flag.name}`;
}

function flagsBlock(flags: FlagSpec[]): string | null {
  if (flags.length === 0) return null;
  const width = Math.max(...flags.map((f) => flagSignature(f).length));
  const lines = flags.map(
    (f) => `  ${flagSignature(f).padEnd(width)}    ${f.description}`,
  );
  return `flags:\n${lines.join("\n")}`;
}

function examplesBlock(examples: HelpExample[]): string | null {
  if (examples.length === 0) return null;
  const lines = examples.flatMap((ex) => [
    `  $ ${ex.invocation}`,
    `      ${ex.explanation}`,
  ]);
  return `examples:\n${lines.join("\n")}`;
}

function contextBlock(
  entry: CommandHelpEntry,
  extraBlocks: HelpContextBlock[],
): string | null {
  if (entry.domainContext === undefined && extraBlocks.length === 0)
    return null;
  const parts: string[] = [];
  if (entry.domainContext !== undefined) {
    parts.push(indentLines(entry.domainContext, 2));
  }
  for (const block of extraBlocks) {
    parts.push(`  ${block.title}\n${indentLines(block.body, 2)}`);
  }
  return `context:\n${parts.join("\n\n")}`;
}

function relatedBlock(related: RelatedRef[]): string | null {
  if (related.length === 0) return null;
  const width = Math.max(...related.map((r) => r.command.length));
  const lines = related.map(
    (r) => `  ${r.command.padEnd(width)} — ${r.oneLiner}`,
  );
  return `related:\n${lines.join("\n")}`;
}

function skillsBlock(skills: SkillRef[] | undefined): string | null {
  if (skills === undefined || skills.length === 0) return null;
  const lines = skills.flatMap((s) => [
    `  ${s.name} — ${s.loadWhen}`,
    `    (${s.path})`,
  ]);
  return `skills:\n${lines.join("\n")}`;
}

function joinSections(sections: Array<string | null>): string {
  return `${sections.filter((s): s is string => s !== null).join("\n\n")}\n`;
}

/**
 * Leaf-node help (doc 04 §3.2): header, description, usage, flags, examples,
 * context (domainContext + any dynamic blocks), related, skills, then a single
 * global-flags pointer. Empty sections are omitted entirely.
 */
export function renderLeafHelpText(
  entry: CommandHelpEntry,
  extraContextBlocks: HelpContextBlock[] = [],
): string {
  const header = `cctl ${pathKey(entry.path)} — ${entry.summary}`;
  const usage = `usage:\n${entry.usage.map((u) => `  ${u}`).join("\n")}`;
  return joinSections([
    header,
    entry.description,
    usage,
    flagsBlock(entry.flags),
    examplesBlock(entry.examples),
    contextBlock(entry, extraContextBlocks),
    relatedBlock(entry.related),
    skillsBlock(entry.skills),
    GLOBAL_FLAGS_POINTER,
  ]);
}

/**
 * Group-node index (doc 04 §3.2b): header, description, one line per child
 * (`<child path> — <summary>`), then the group's own related/skills. No
 * usage/flags/examples — the hub points at leaves, it does not restate them.
 */
export function renderGroupHelpText(
  entry: CommandHelpEntry,
  children: CommandHelpEntry[],
): string {
  const header = `cctl ${pathKey(entry.path)} — ${entry.summary}`;
  const width =
    children.length === 0
      ? 0
      : Math.max(...children.map((c) => pathKey(c.path).length));
  const commands =
    children.length === 0
      ? null
      : `commands:\n${children
          .map(
            (child) =>
              `  ${pathKey(child.path).padEnd(width)} — ${child.summary}`,
          )
          .join("\n")}`;
  return joinSections([
    header,
    entry.description,
    commands,
    relatedBlock(entry.related),
    skillsBlock(entry.skills),
    GLOBAL_FLAGS_POINTER,
  ]);
}

/**
 * Top-level usage (doc 04 §2.3/§3.2c): the level-1 entries' summaries in the
 * existing USAGE layout plus the hand-written global-flags block. Not wired into
 * dispatch here — the migration context swaps the hand-written USAGE for this.
 */
export function renderTopUsageText(level1: CommandHelpEntry[]): string {
  const commandLines = level1
    .map((entry) => `  ${pathKey(entry.path).padEnd(12)}  ${entry.summary}`)
    .join("\n");
  return `usage: cctl <command> [flags]

commands:
${commandLines}

${GLOBAL_FLAGS_BLOCK}
`;
}

interface HelpJsonBody {
  command: string;
  summary: string;
  description: string;
  usage: string[];
  flags: FlagSpec[];
  examples: HelpExample[];
  domainContext?: string;
  related: RelatedRef[];
  skills?: SkillRef[];
  context?: { blocks: HelpContextBlock[] };
}

/**
 * JSON help (doc 04 §3.3): the structured entry, with NO duplicated rendered
 * text — machine callers do not pay for prose twice. Any server-rendered
 * dynamic `context` blocks (doc 04 §4) ride under `context.blocks`; the key is
 * omitted entirely when none were fetched, so static and fail-open renderings
 * are byte-identical.
 */
export function buildHelpJson(
  entry: CommandHelpEntry,
  contextBlocks: HelpContextBlock[] = [],
): {
  ok: true;
  help: HelpJsonBody;
} {
  const help: HelpJsonBody = {
    command: pathKey(entry.path),
    summary: entry.summary,
    description: entry.description,
    usage: entry.usage,
    flags: entry.flags,
    examples: entry.examples,
    ...(entry.domainContext !== undefined
      ? { domainContext: entry.domainContext }
      : {}),
    related: entry.related,
    ...(entry.skills !== undefined ? { skills: entry.skills } : {}),
    ...(contextBlocks.length > 0 ? { context: { blocks: contextBlocks } } : {}),
  };
  return { ok: true, help };
}
