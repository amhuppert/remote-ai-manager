#!/usr/bin/env bun
/**
 * Generate the cc-cli command reference from the public native HelpNode API.
 * --check also checks hand-authored command paths and flags in SKILL.md and
 * its references against the registry.
 *
 * Usage:
 *   bun scripts/cc-cli-skill-reference.ts
 *   bun scripts/cc-cli-skill-reference.ts --check
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { helpNode, type HelpNode } from "cli-for-agents/runtime";
import { createCommandCenterCli } from "../src/cli/framework/application";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
export const SKILL_MD_PATH = path.join(
  repoRoot,
  "plugins/command-center/command-center/skills/cc-cli/SKILL.md",
);

export const REFERENCE_DIR = path.join(
  path.dirname(SKILL_MD_PATH),
  "references",
);
export const COMMAND_REFERENCE_PATH = path.join(
  REFERENCE_DIR,
  "command-reference.md",
);

export function skillDocumentPaths(): string[] {
  const visit = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) =>
        entry.isDirectory()
          ? visit(path.join(directory, entry.name))
          : entry.name.endsWith(".md")
            ? [path.join(directory, entry.name)]
            : [],
      );
  return visit(path.dirname(path.dirname(SKILL_MD_PATH)));
}

export const BEGIN_MARKER = "<!-- BEGIN GENERATED COMMAND REFERENCE -->";
export const END_MARKER = "<!-- END GENERATED COMMAND REFERENCE -->";
/** Traverse the public native projection; context and handler loaders stay cold. */
export function nativeHelpNodes(cli = createCommandCenterCli()): HelpNode[] {
  const nodes: HelpNode[] = [];
  const visit = (commandPath: string): void => {
    const node = helpNode(cli, commandPath);
    nodes.push(node);
    for (const child of node.children) visit(child.path);
  };
  visit("");
  return nodes;
}

export interface ProseUsageFinding {
  /** 1-indexed source line. */
  line: number;
  text: string;
  reason: "unknown-command" | "unknown-flag";
  expected: string[];
}

/** Mask quoted prose so literal command-looking content cannot become a flag. */
function unquoted(text: string): string {
  let quote: string | undefined;
  let escaped = false;
  let result = "";
  for (const character of text) {
    if (escaped) {
      result += "x";
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      result += "x";
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      result += "x";
    } else if (character === '"' || character === "'") {
      quote = character;
      result += "x";
    } else {
      result += character;
    }
  }
  return result;
}

/** Check copyable paths and flags against HelpNode, allowing values/placeholders. */
export function proseUsageFindings(
  source: string,
  nodes: readonly HelpNode[],
): ProseUsageFinding[] {
  const registry = new Map(nodes.map((node) => [node.path, node]));
  const findings: ProseUsageFinding[] = [];
  let inGenerated = false;
  let inFence = false;
  let pending = "";
  let pendingLine = 0;

  source.split("\n").forEach((raw, index) => {
    if (raw.includes(BEGIN_MARKER)) {
      inGenerated = true;
      return;
    }
    if (raw.includes(END_MARKER)) {
      inGenerated = false;
      return;
    }
    if (inGenerated) return;
    if (raw.trimStart().startsWith("```")) {
      inFence = !inFence;
      return;
    }
    if (!inFence) return;
    const line = raw.trim();
    if (!pending && !line.startsWith("cctl ")) return;
    if (!pending) pendingLine = index + 1;
    pending += ` ${line}`;
    if (line.endsWith("\\")) {
      pending = pending.slice(0, -1);
      return;
    }
    const text = pending.trim();
    pending = "";
    const comment = unquoted(text).indexOf(" #");
    const tokens = unquoted(
      comment === -1 ? text : text.slice(0, comment),
    ).split(/\s+/u);
    // exit-codes is the runtime's built-in offline route, outside the command tree.
    if (tokens[1] === "exit-codes") return;
    let node = registry.get("");
    let cursor = 1;
    while (node && (node.kind === "root" || node.kind === "group")) {
      const token = tokens[cursor];
      if (!token || !/^[a-z][a-z0-9-]*$/u.test(token)) break;
      const nextPath = [node.path, token].filter(Boolean).join(" ");
      const next = registry.get(nextPath);
      if (!next) {
        findings.push({
          line: pendingLine,
          text,
          reason: "unknown-command",
          expected: node.children.map((child) => `cctl ${child.path}`),
        });
        return;
      }
      node = next;
      cursor++;
    }
    if (!node) return;
    const known = new Set(
      node.flags.flatMap((flag) => [
        flag.name,
        ...(flag.fileAlternative ? [flag.fileAlternative.name] : []),
      ]),
    );
    const flags =
      tokens
        .slice(cursor)
        .join(" ")
        .split(/(?:^|\s)--(?:\s|$)/u)[0] ?? "";
    for (const match of flags.matchAll(/(?:^|[\s[(|])--([a-z][a-z0-9-]*)/gu)) {
      if (known.has(match[1] ?? "")) continue;
      findings.push({
        line: pendingLine,
        text,
        reason: "unknown-flag",
        expected: [...known].map((name) => `--${name}`),
      });
      return;
    }
  });
  return findings;
}

export function renderCommandReference(nodes: readonly HelpNode[]): string {
  const root = nodes.find((node) => node.kind === "root");
  const sharedFlags = new Set(root?.flags.map((flag) => flag.name));
  const lines = [
    "### Command reference",
    "",
    "_Generated from the native `cctl` registry. Leaf `--help` owns descriptions, examples, input limits, and recovery edges. Use `cctl --help` for global flags and `cctl exit-codes` for the runtime error catalog._",
    "",
  ];
  for (const node of nodes) {
    if (node.kind === "root") continue;
    lines.push(`- \`cctl ${node.path}\` — ${node.summary}`);
    for (const shape of node.usage) lines.push(`  - \`${shape}\``);
    const flags = node.flags.filter((flag) => !sharedFlags.has(flag.name));
    if (flags.length)
      lines.push(
        `  - Flags: ${flags.map((flag) => `\`--${flag.name}\`${flag.fileAlternative ? ` / \`--${flag.fileAlternative.name}\`` : ""}${flag.required ? " (required)" : ""}`).join(", ")}.`,
      );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Splice the fresh block between the named markers in `source`. Throws when
 * either marker is missing or they are out of order — the document must declare
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
      `Document is missing the ${begin === -1 ? beginMarker : endMarker} marker — ` +
        "that generated block has no anchor.",
    );
  }
  if (end < begin) {
    throw new Error(
      `Document markers are out of order (${endMarker} precedes ${beginMarker}).`,
    );
  }
  const before = source.slice(0, begin + beginMarker.length);
  const after = source.slice(end);
  return `${before}\n${block}\n${after}`;
}

/**
 * Extract the current block text (between the markers, trimmed) from a document
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
  filePath: string;
  label: string;
  beginMarker: string;
  endMarker: string;
  block: string;
}

function generatedBlocks(): GeneratedBlock[] {
  return [
    {
      filePath: COMMAND_REFERENCE_PATH,
      label: "command reference",
      beginMarker: BEGIN_MARKER,
      endMarker: END_MARKER,
      block: renderCommandReference(nativeHelpNodes()),
    },
  ];
}

function main(): void {
  const checkMode = process.argv.includes("--check");
  const blocks = generatedBlocks();
  let stale = false;
  let changed = false;

  for (const generated of blocks) {
    const source = readFileSync(generated.filePath, "utf8");
    const current = extractBlock(
      source,
      generated.beginMarker,
      generated.endMarker,
    );
    if (current === generated.block.trim()) continue;
    if (checkMode) {
      console.error(
        `${path.relative(repoRoot, generated.filePath)} ${generated.label} is stale or missing markers. ` +
          "Run `bun scripts/cc-cli-skill-reference.ts` and commit the result.",
      );
      stale = true;
      continue;
    }
    writeFileSync(
      generated.filePath,
      spliceBlock(
        source,
        generated.beginMarker,
        generated.endMarker,
        generated.block,
      ),
    );
    changed = true;
  }

  if (checkMode) {
    for (const filePath of skillDocumentPaths()) {
      for (const finding of proseUsageFindings(
        readFileSync(filePath, "utf8"),
        nativeHelpNodes(),
      )) {
        console.error(
          `${path.relative(repoRoot, filePath)}:${finding.line} "${finding.text}" ${
            finding.reason === "unknown-command"
              ? "names a command the registry does not have"
              : `names an unknown flag; accepted: ${finding.expected.join(", ")}`
          }`,
        );
        stale = true;
      }
    }
    if (stale) process.exit(1);
    console.log("cc-cli skill generated blocks and prose are up to date.");
    return;
  }

  console.log(
    changed
      ? "Updated cc-cli skill generated blocks."
      : "cc-cli skill generated blocks already up to date.",
  );
}

if (import.meta.main) {
  main();
}
