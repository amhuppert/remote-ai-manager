/**
 * Lexical scanning of the CLI's own sources, for the convention ratchets that
 * construction cannot reach (docs/design/cc-cli/09 §10): a legacy field name
 * that must stay contained, a guidance vocabulary that must not grow a fourth
 * spelling, and a hint that must not name a command the registry retired.
 *
 * The scan is deliberately lexical, not a type-aware AST walk: the conventions
 * it holds are about the TEXT an agent reads, every violation of them is a
 * string literal, and a scanner small enough to be read in one sitting is what
 * keeps a ratchet honest. It sees comments and code as non-literal text, and
 * renders an interpolation as an opaque `${}` marker so a template's fixed
 * words stay analyzable while its runtime values do not masquerade as prose.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface CliSourceFile {
  /** Path relative to the scan root, POSIX-style, e.g. `commands/workflow.ts`. */
  readonly relativePath: string;
  readonly source: string;
}

/**
 * Every non-test TypeScript file under `root`. Test files are excluded: a
 * ratchet describes what ships, and a test naming a retired command or a
 * competing prefix is usually pinning the very behaviour under test.
 */
export async function readCliSources(root: string): Promise<CliSourceFile[]> {
  const files: CliSourceFile[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const nested of await readCliSources(full)) {
        files.push({
          relativePath: path
            .join(entry.name, nested.relativePath)
            .split(path.sep)
            .join("/"),
          source: nested.source,
        });
      }
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.includes(".test.")) continue;
    files.push({
      relativePath: entry.name,
      source: await readFile(full, "utf8"),
    });
  }
  return files;
}

/**
 * The string literals of a TypeScript source, in source order, with comments
 * skipped and every `${…}` rendered as `${}`.
 */
export function stringLiterals(source: string): string[] {
  const literals: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const read = readLiteral(source, index, char);
      literals.push(read.text);
      index = read.end;
      continue;
    }
    index += 1;
  }
  return literals;
}

/** Read one literal opened at `start`; returns its text and the index after it. */
function readLiteral(
  source: string,
  start: number,
  quote: string,
): { text: string; end: number } {
  let text = "";
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      // `\n` in a quoted literal is a rendered line break, so keep it readable
      // as one: the guidance sweep reasons about the lines an agent sees.
      text += source[index + 1] === "n" ? "\n" : (source[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (char === quote) return { text, end: index + 1 };
    if (quote !== "`" && char === "\n") return { text, end: index };
    if (quote === "`" && char === "$" && source[index + 1] === "{") {
      text += "${}";
      index = skipInterpolation(source, index + 2);
      continue;
    }
    text += char;
    index += 1;
  }
  return { text, end: index };
}

/** Skip a template interpolation's expression, returning the index after `}`. */
function skipInterpolation(source: string, start: number): number {
  let depth = 1;
  let index = start;
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === '"' || char === "'" || char === "`") {
      index = readLiteral(source, index, char).end;
      continue;
    }
    index += 1;
  }
  return index;
}

/**
 * The `label` of every `label: …` that opens a line inside a literal. These are
 * the positions an agent reads as a prefix; an indented `  label: value` is
 * detail under a primary line and is not one.
 */
export function lineLeadingLabels(literal: string): string[] {
  const labels: string[] = [];
  for (const line of literal.split("\n")) {
    const match = /^([a-z][a-z0-9-]{1,18}): \S/u.exec(line);
    if (match?.[1] !== undefined) labels.push(match[1]);
  }
  return labels;
}

/**
 * The command-shaped token runs that follow `cctl` in a literal, e.g.
 * `cctl workflow live get exec-7 --full` yields
 * `["workflow","live","get","exec-7"]`. A run stops at the first token that
 * cannot be a command segment — a flag, a placeholder, an interpolation — so a
 * templated command still contributes the fixed path it names.
 */
export function cctlCommandMentions(literal: string): string[][] {
  const mentions: string[][] = [];
  const pattern = /\bcctl\s+([^\n]*)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(literal)) !== null) {
    const tokens: string[] = [];
    for (const token of (match[1] ?? "").split(/\s+/u)) {
      if (!/^[a-z][a-z0-9-]*$/u.test(token)) break;
      tokens.push(token);
    }
    if (tokens.length > 0) mentions.push(tokens);
  }
  return mentions;
}
