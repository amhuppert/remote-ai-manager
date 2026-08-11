import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { storybookBrowserAliases } from "../../.storybook/browser-aliases";

/**
 * Architecture guardrail: no module a story reaches at runtime may import a
 * Node or Bun builtin.
 *
 * Storybook builds with Vite, which externalizes `node:*` for the browser and
 * throws on first property access — so a single `import { createHash } from
 * "node:crypto"` anywhere in a story's import graph blanks the story with
 * "Module has been externalized for browser compatibility". Next.js tolerates
 * the same import (it resolves per-environment), so neither `tsc` nor the
 * production build catches this; the Storybook browser project is not part of
 * registered validation either. Nothing else fails, which is how 16 of 197
 * story files came to be silently broken.
 *
 * The remedy is never to make the story avoid the module — it is to keep the
 * builtin out of the shared module, as `agent-profiles/hashing.ts` and
 * `document-comments/anchor.ts` already document: schemas, types, and pure
 * view logic stay browser-safe, and the hashing or filesystem work that needs
 * a builtin lives in its own server-side sibling. Where the server subtree is
 * the module's whole point, the Storybook build cuts it to a stub instead, and
 * this walk replays those same cuts from the one table that declares them.
 *
 * Story files are read as text, never imported: unit tests must not load
 * `*.stories.*` modules.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "../..");
const srcDir = path.join(repoRoot, "src");

const STORY_PATTERN = /\.stories\.tsx?$/;
const MODULE_EXTENSIONS = [".ts", ".tsx"];

function collectStoryFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectStoryFiles(entryPath);
    return entry.isFile() && STORY_PATTERN.test(entry.name) ? [entryPath] : [];
  });
}

/**
 * Every module specifier a file pulls in at runtime.
 *
 * `import type` and `export type` are erased before the bundler sees them, so
 * they are not edges. Everything else counts — including a mixed
 * `import { value, type T }`, whose value binding keeps the module live. The
 * rule is deliberately conservative: a bundler may elide an edge this counts,
 * and over-reporting costs one correctly-placed module split, while
 * under-reporting ships another blank story.
 */
function runtimeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticRe =
    /\b(?:import|export)\s+(type\s+)?([^;]*?)from\s+["']([^"']+)["']/g;
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  const sideEffectRe = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;

  for (const match of source.matchAll(staticRe)) {
    if (match[1] !== undefined) continue;
    const specifier = match[3];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  for (const re of [dynamicRe, sideEffectRe]) {
    for (const match of source.matchAll(re)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** Resolve a project-internal specifier the way the Storybook build does. */
function resolveProjectModule(
  specifier: string,
  fromFile: string,
): string | null {
  const aliased = storybookBrowserAliases.find((alias) =>
    alias.find.test(specifier),
  );
  if (aliased !== undefined) return aliased.replacement;

  const base = specifier.startsWith("@/")
    ? path.join(srcDir, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(fromFile), specifier)
      : null;
  if (base === null) return null;

  const candidates = [
    ...MODULE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...MODULE_EXTENSIONS.map((extension) =>
      path.join(base, `index${extension}`),
    ),
    base,
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function isBrowserUnsafe(specifier: string): boolean {
  return specifier.startsWith("node:") || specifier.startsWith("bun:");
}

function relative(filePath: string): string {
  return path.relative(repoRoot, filePath);
}

/**
 * The shortest import chain from each story to a builtin, one entry per
 * offending module so the report names the module to split rather than the
 * many stories that happen to reach it.
 */
function browserUnsafeChains(): string[] {
  const sourceCache = new Map<string, string[]>();
  const specifiersOf = (filePath: string): string[] => {
    const cached = sourceCache.get(filePath);
    if (cached !== undefined) return cached;
    const parsed = runtimeImportSpecifiers(readFileSync(filePath, "utf8"));
    sourceCache.set(filePath, parsed);
    return parsed;
  };

  const chainByOffender = new Map<string, string>();
  for (const storyFile of collectStoryFiles(srcDir)) {
    const visited = new Set([storyFile]);
    const queue: Array<{ file: string; chain: string[] }> = [
      { file: storyFile, chain: [relative(storyFile)] },
    ];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      for (const specifier of specifiersOf(current.file)) {
        if (isBrowserUnsafe(specifier)) {
          const offender = `${relative(current.file)} imports ${specifier}`;
          if (!chainByOffender.has(offender)) {
            chainByOffender.set(
              offender,
              [...current.chain, specifier].join("\n    -> "),
            );
          }
          continue;
        }
        const resolved = resolveProjectModule(specifier, current.file);
        if (resolved === null || visited.has(resolved)) continue;
        visited.add(resolved);
        queue.push({
          file: resolved,
          chain: [...current.chain, relative(resolved)],
        });
      }
    }
  }
  return [...chainByOffender.values()].toSorted();
}

describe("story import graphs", () => {
  it("reach no Node or Bun builtin", () => {
    expect(browserUnsafeChains()).toEqual([]);
  });
});
