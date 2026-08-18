#!/usr/bin/env bun
/**
 * Generate the cc-cli SKILL.md "Command reference" block from the help registry
 * (steering `cli.md` "single source of truth"; docs/design/cc-cli/04 §7.1 rule 6).
 *
 * The registry (`src/cli/help-registry.ts`) is the one source of every command's
 * path, summary, and usage shapes. The skill's command reference used to be a
 * hand-maintained mirror of that — the last item on the `cli.md` add-a-command
 * checklist ("Update the cc-cli SKILL.md command reference (manual sync until
 * generation exists)"). This closes that gap: a fenced block between two markers
 * in SKILL.md is rendered from the registry, and CI (`--check`) fails when the
 * committed block drifts from what the registry would produce.
 *
 * Scope: this generates ONLY the command-reference index (every portable command
 * path + summary + usage). Retired runtime compatibility nodes opt out in their
 * registry entry. The skill's rich per-group prose sections stay hand-authored —
 * the registry has no equivalent, and prose is where domain guidance lives.
 *
 * Usage:
 *   bun scripts/cc-cli-skill-reference.ts          # rewrite the block in place
 *   bun scripts/cc-cli-skill-reference.ts --check   # CI gate: read-only; non-zero
 *                                                    # exit if the block is stale
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_TAXONOMY, type ExitCodeMeaning } from "../src/cli/exit-taxonomy";
import {
  allHelpEntries,
  buildHelpRegistry,
  childHelpEntries,
} from "../src/cli/help-registry";
import { pathKey, type CommandHelpEntry } from "../src/cli/help-types";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
export const SKILL_MD_PATH = path.join(
  repoRoot,
  "plugins/command-center/command-center/skills/cc-cli/SKILL.md",
);

export const BEGIN_MARKER = "<!-- BEGIN GENERATED COMMAND REFERENCE -->";
export const END_MARKER = "<!-- END GENERATED COMMAND REFERENCE -->";
export const EXIT_CODES_BEGIN_MARKER = "<!-- BEGIN GENERATED EXIT CODES -->";
export const EXIT_CODES_END_MARKER = "<!-- END GENERATED EXIT CODES -->";

/**
 * The exit-code table as markdown, rendered from the taxonomy the binary itself
 * exits with. A skill that tells an agent what exit `4` means while the binary
 * behaves differently is worse than silence — the agent acts on the doc.
 */
export function renderExitCodeTable(
  taxonomy: readonly ExitCodeMeaning[] = EXIT_TAXONOMY,
): string {
  const lines = [
    "_Generated from `EXIT_TAXONOMY` (`src/cli/exit-taxonomy.ts`) — do not edit" +
      " by hand; run `bun scripts/cc-cli-skill-reference.ts`. `cctl exit-codes`" +
      " prints the same table offline._",
    "",
    "| Code | Meaning | Recovery |",
    "|---|---|---|",
    ...taxonomy.map(
      (row) =>
        `| \`${row.code}\` | ${row.meaning} | ${
          row.recovery === null ? "—" : `\`${row.recovery}\``
        } |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

export interface ProseUsageFinding {
  /** 1-indexed line in the SKILL.md source. */
  line: number;
  text: string;
  reason: "unknown-command" | "usage-drift";
  /** The registry's shapes for the entry the line names, on a drift. */
  expected: string[];
}

/**
 * A usage SHAPE carries at least one placeholder — `<name>` or an `[optional]`
 * fragment. A concrete example carries argument VALUES instead, and the registry
 * has no opinion about those; only a shape is a restatement of the contract, so
 * only a shape has to match the contract. The `<` must open a word so an
 * example's prose comparison (`<10k sessions`) is not read as a placeholder.
 */
const USAGE_PLACEHOLDER = /<[A-Za-z][^>]*>|\[[^\]]*\]/u;

/** Drop a trailing ` # …` annotation; `project#number` has no space before it. */
function withoutTrailingComment(text: string): string {
  const comment = text.indexOf(" #");
  return (comment === -1 ? text : text.slice(0, comment)).trim();
}

/** The command-segment run after `cctl`, stopping at the first argument or flag. */
function commandTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const token of text.slice("cctl ".length).split(/\s+/u)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(token)) break;
    tokens.push(token);
  }
  return tokens;
}

type PathResolution =
  | { kind: "entry"; entry: CommandHelpEntry }
  | { kind: "unknown"; command: string };

/**
 * Resolve a mentioned path, stopping at a LEAF: everything after a leaf is an
 * argument (`cctl spec show native-sdd` names a slug, not a subcommand), while
 * an unrecognized token under a GROUP is a verb the registry does not have.
 */
function resolvePath(
  registry: Map<string, CommandHelpEntry>,
  tokens: string[],
): PathResolution | null {
  const head = tokens[0];
  if (head === undefined) return null;
  let entry = registry.get(head);
  if (entry === undefined) return { kind: "unknown", command: head };
  for (let depth = 2; depth <= tokens.length; depth++) {
    const candidate = tokens.slice(0, depth);
    const deeper = registry.get(pathKey(candidate));
    if (deeper !== undefined) {
      entry = deeper;
      continue;
    }
    if (childHelpEntries(registry, entry.path).length > 0) {
      return { kind: "unknown", command: candidate.join(" ") };
    }
    break;
  }
  return { kind: "entry", entry };
}

/**
 * The hand-prose drift gate (docs/design/cc-cli/09 §10). The generated blocks
 * cannot drift by construction; the rich prose sections around them can, and the
 * 2026-08 audit found three usage lines in them that the binary no longer
 * accepted. Every `cctl …` line inside a fenced block outside the generated
 * markers must therefore either name a real command (an example) or be one of
 * that command's registry usage shapes verbatim (a restatement).
 *
 * The scan is deliberately its own small lexer rather than a markdown parse: it
 * reasons about the LINES a reader copies, and a fence plus a leading `cctl` is
 * exactly what makes a line copyable.
 */
export function proseUsageFindings(
  source: string,
  entries: CommandHelpEntry[],
): ProseUsageFinding[] {
  const registry = buildHelpRegistry(entries);
  const findings: ProseUsageFinding[] = [];
  let inGenerated = false;
  let inFence = false;

  source.split("\n").forEach((raw, index) => {
    if (raw.includes(BEGIN_MARKER) || raw.includes(EXIT_CODES_BEGIN_MARKER)) {
      inGenerated = true;
      return;
    }
    if (raw.includes(END_MARKER) || raw.includes(EXIT_CODES_END_MARKER)) {
      inGenerated = false;
      return;
    }
    if (raw.trimStart().startsWith("```")) {
      inFence = !inFence;
      return;
    }
    if (inGenerated || !inFence) return;

    const text = withoutTrailingComment(raw.trim());
    if (!text.startsWith("cctl ")) return;
    const resolution = resolvePath(registry, commandTokens(text));
    if (resolution === null) return;
    if (resolution.kind === "unknown") {
      findings.push({
        line: index + 1,
        text,
        reason: "unknown-command",
        expected: [],
      });
      return;
    }
    if (!USAGE_PLACEHOLDER.test(text)) return;
    if (resolution.entry.usage.includes(text)) return;
    findings.push({
      line: index + 1,
      text,
      reason: "usage-drift",
      expected: [...resolution.entry.usage],
    });
  });

  return findings;
}

/**
 * Render the registry as the markdown reference block (between, not including,
 * the markers). Pure — takes entries, returns the block text — so the format is
 * unit-tested against crafted entry sets without touching disk.
 *
 * Grouped by top-level command in registry order; each portable entry is one bullet
 * `` `cctl <path>` — <summary> `` followed by its usage shapes as inline code.
 * A trailing newline is included so the block sits cleanly between its markers.
 */
export function renderCommandReference(entries: CommandHelpEntry[]): string {
  const portableEntries = entries.filter(
    (entry) => entry.includeInGeneratedReference !== false,
  );
  const level1 = portableEntries.filter((entry) => entry.path.length === 1);
  const lines: string[] = [
    "### Command reference",
    "",
    "_Generated from the `cctl` help registry — do not edit by hand; run" +
      " `bun scripts/cc-cli-skill-reference.ts`. Every command's `--help` is the" +
      " authoritative, always-current node._",
    "",
  ];

  for (const top of level1) {
    const family = portableEntries
      .filter((entry) => entry.path[0] === top.path[0])
      .sort((a, b) => a.path.length - b.path.length);
    for (const entry of family) {
      const key = pathKey(entry.path);
      lines.push(`- \`cctl ${key}\` — ${entry.summary}`);
      for (const shape of entry.usage) {
        lines.push(`  - \`${shape}\``);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Splice the fresh block between the named markers in `source`. Throws when
 * either marker is missing or they are out of order — the SKILL.md must declare
 * exactly where each generated block lives.
 */
export function spliceBlock(
  source: string,
  beginMarker: string,
  endMarker: string,
  block: string,
): string {
  const begin = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker);
  if (begin === -1 || end === -1) {
    throw new Error(
      `SKILL.md is missing the ${begin === -1 ? beginMarker : endMarker} marker — ` +
        "that generated block has no anchor.",
    );
  }
  if (end < begin) {
    throw new Error(
      `SKILL.md markers are out of order (${endMarker} precedes ${beginMarker}).`,
    );
  }
  const before = source.slice(0, begin + beginMarker.length);
  const after = source.slice(end);
  return `${before}\n${block}\n${after}`;
}

/**
 * Extract the current block text (between the markers, trimmed) from a SKILL.md
 * source, for the drift comparison. Returns null when a marker is missing.
 */
export function extractBlock(
  source: string,
  beginMarker: string,
  endMarker: string,
): string | null {
  const begin = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker);
  if (begin === -1 || end === -1 || end < begin) return null;
  return source.slice(begin + beginMarker.length, end).trim();
}

interface GeneratedBlock {
  label: string;
  beginMarker: string;
  endMarker: string;
  block: string;
}

function generatedBlocks(): GeneratedBlock[] {
  return [
    {
      label: "command reference",
      beginMarker: BEGIN_MARKER,
      endMarker: END_MARKER,
      block: renderCommandReference(allHelpEntries()),
    },
    {
      label: "exit-code table",
      beginMarker: EXIT_CODES_BEGIN_MARKER,
      endMarker: EXIT_CODES_END_MARKER,
      block: renderExitCodeTable(),
    },
  ];
}

function main(): void {
  const checkMode = process.argv.includes("--check");
  const source = readFileSync(SKILL_MD_PATH, "utf8");
  const blocks = generatedBlocks();

  if (checkMode) {
    let stale = false;
    for (const generated of blocks) {
      const current = extractBlock(
        source,
        generated.beginMarker,
        generated.endMarker,
      );
      if (current === null) {
        console.error(
          `cc-cli SKILL.md is missing the ${generated.label} markers ` +
            `(${generated.beginMarker} / ${generated.endMarker}). Run 'bun scripts/cc-cli-skill-reference.ts'.`,
        );
        stale = true;
        continue;
      }
      if (current !== generated.block.trim()) {
        console.error(
          `cc-cli SKILL.md ${generated.label} is stale — its source of truth changed.\n` +
            "Regenerate it with `bun scripts/cc-cli-skill-reference.ts` and commit the result.",
        );
        stale = true;
      }
    }
    for (const finding of proseUsageFindings(source, allHelpEntries())) {
      console.error(
        `cc-cli SKILL.md:${finding.line} "${finding.text}" ${
          finding.reason === "unknown-command"
            ? "names a command the registry does not have"
            : `does not match the registry usage: ${finding.expected.join(" | ")}`
        }`,
      );
      stale = true;
    }
    if (stale) process.exit(1);
    console.log("cc-cli SKILL.md generated blocks and prose are up to date.");
    return;
  }

  let next = source;
  for (const generated of blocks) {
    next = spliceBlock(
      next,
      generated.beginMarker,
      generated.endMarker,
      generated.block,
    );
  }
  if (next === source) {
    console.log("cc-cli SKILL.md generated blocks already up to date.");
    return;
  }
  writeFileSync(SKILL_MD_PATH, next);
  console.log(
    `Wrote the generated blocks into ${path.relative(repoRoot, SKILL_MD_PATH)}.`,
  );
}

if (import.meta.main) {
  main();
}
