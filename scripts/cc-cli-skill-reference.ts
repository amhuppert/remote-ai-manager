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
import { allHelpEntries } from "../src/cli/help-registry";
import { pathKey, type CommandHelpEntry } from "../src/cli/help-types";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
export const SKILL_MD_PATH = path.join(
  repoRoot,
  "plugins/command-center/command-center/skills/cc-cli/SKILL.md",
);

export const BEGIN_MARKER = "<!-- BEGIN GENERATED COMMAND REFERENCE -->";
export const END_MARKER = "<!-- END GENERATED COMMAND REFERENCE -->";

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
 * Splice the fresh block between the markers in `source`. Throws when either
 * marker is missing or they are out of order — the SKILL.md must declare exactly
 * where the generated block lives.
 */
export function spliceReference(source: string, block: string): string {
  const begin = source.indexOf(BEGIN_MARKER);
  const end = source.indexOf(END_MARKER);
  if (begin === -1 || end === -1) {
    throw new Error(
      `SKILL.md is missing the ${begin === -1 ? BEGIN_MARKER : END_MARKER} marker — ` +
        "the generated command reference has no anchor.",
    );
  }
  if (end < begin) {
    throw new Error(
      `SKILL.md markers are out of order (${END_MARKER} precedes ${BEGIN_MARKER}).`,
    );
  }
  const before = source.slice(0, begin + BEGIN_MARKER.length);
  const after = source.slice(end);
  return `${before}\n${block}\n${after}`;
}

/**
 * Extract the current block text (between the markers, trimmed) from a SKILL.md
 * source, for the drift comparison. Returns null when a marker is missing.
 */
export function extractReference(source: string): string | null {
  const begin = source.indexOf(BEGIN_MARKER);
  const end = source.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) return null;
  return source.slice(begin + BEGIN_MARKER.length, end).trim();
}

function main(): void {
  const checkMode = process.argv.includes("--check");
  const block = renderCommandReference(allHelpEntries());
  const source = readFileSync(SKILL_MD_PATH, "utf8");

  if (checkMode) {
    const current = extractReference(source);
    if (current === null) {
      console.error(
        `cc-cli SKILL.md is missing the command-reference markers ` +
          `(${BEGIN_MARKER} / ${END_MARKER}). Run 'bun scripts/cc-cli-skill-reference.ts'.`,
      );
      process.exit(1);
    }
    if (current !== block.trim()) {
      console.error(
        "cc-cli SKILL.md command reference is stale — the help registry changed.\n" +
          "Regenerate it with `bun scripts/cc-cli-skill-reference.ts` and commit the result.",
      );
      process.exit(1);
    }
    console.log("cc-cli SKILL.md command reference is up to date.");
    return;
  }

  const next = spliceReference(source, block);
  if (next === source) {
    console.log("cc-cli SKILL.md command reference already up to date.");
    return;
  }
  writeFileSync(SKILL_MD_PATH, next);
  console.log(
    `Wrote the command reference into ${path.relative(repoRoot, SKILL_MD_PATH)}.`,
  );
}

if (import.meta.main) {
  main();
}
