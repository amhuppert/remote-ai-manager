/**
 * Visual-inertness guard for the Tailwind integration (requirement 1.3).
 *
 * Tailwind v4 auto-scans the codebase and emits a utility for every token it
 * sees. A token that is (a) a generated Tailwind utility, (b) used as a bare
 * className on an element, and (c) has NO legacy CSS rule, would start applying
 * a style the element never had before — a visual change. (The cascade backstop
 * only protects classNames that DO have a legacy unlayered rule; a className with
 * no rule has nothing to win the cascade against.)
 *
 * Example this guards against: an unstyled label using the conventional
 * "screen reader only" utility class rendered normally before integration, but
 * Tailwind's matching utility would hide it.
 *
 * This test compiles the real `globals.css` through the real `@tailwindcss/postcss`,
 * then asserts there are ZERO such collisions. A new collision (a freshly added
 * bare-token className matching a utility) fails this test; resolve it by renaming
 * the className to a non-utility BEM name in the same change.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { describe, it, expect } from "vitest";

const repoRoot = process.cwd();
const srcDir = path.join(repoRoot, "src");

/**
 * Paths (directories or specific files) that are migrated, utility-first BY
 * DESIGN: every className is an intentional Tailwind utility composed via `cn()`
 * (the sanctioned `cn("…", cond && "utility")` pattern from
 * docs/tailwind-conventions.md §1.1) or a static utility map, not a legacy bare
 * class that might collide silently. The bare-token collision heuristic (which
 * exists to protect UN-migrated legacy elements) does not apply to them. As
 * feature waves migrate more surfaces to utilities, append their paths here —
 * same spirit as the css-migration-progress ratchet's per-owner allowlist. File
 * entries (not whole dirs) are used when only one component in a feature folder
 * is migrated so far, keeping its still-legacy siblings under the guard.
 */
const UTILITY_FIRST_PATHS = [
  `${path.sep}components${path.sep}ui${path.sep}`,
  // Pilot slice (design task 5.1): ProjectCard is fully utility-first.
  `${path.sep}features${path.sep}projects-index${path.sep}components${path.sep}ProjectCard.tsx`,
];

function srcFiles(ext: string): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(ext))
    .map((rel) => path.join(srcDir, rel));
}

/** Simple single-class utility selectors Tailwind generates (e.g. `flex`, `grid`). */
async function generatedSimpleUtilities(): Promise<Set<string>> {
  const globals = readFileSync(path.join(srcDir, "app/globals.css"), "utf8");
  const result = await postcss([tailwindcss()]).process(globals, {
    from: path.join(srcDir, "app/globals.css"),
  });
  const utils = new Set<string>();
  result.root.walkAtRules("layer", (layerRule) => {
    if (!layerRule.nodes) return;
    if (!/(^|[\s,])utilities(\s|,|$)/.test(layerRule.params)) return;
    layerRule.walkRules((rule) => {
      for (const sel of rule.selectors ?? [rule.selector]) {
        const m = /^\.([a-z][a-z0-9-]*)$/.exec(sel.trim());
        if (m?.[1]) utils.add(m[1]);
      }
    });
  });
  return utils;
}

/** Every class name defined by a rule anywhere in CC's CSS. */
function legacyCssClasses(): Set<string> {
  const classes = new Set<string>();
  for (const file of srcFiles(".css")) {
    const css = readFileSync(file, "utf8");
    for (const m of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
      if (m[1]) classes.add(m[1]);
    }
  }
  return classes;
}

/** Bare (space/quote-delimited, lowercase) className tokens used in JSX → sample file. */
function jsxClassNameTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const file of srcFiles(".tsx")) {
    if (UTILITY_FIRST_PATHS.some((p) => file.includes(p))) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(
      /className\s*=\s*(?:"([^"]*)"|\{([^}]*)\})/g,
    )) {
      const strings: string[] = [];
      if (m[1] != null) strings.push(m[1]);
      if (m[2] != null) {
        for (const s of m[2].matchAll(/["'`]([^"'`]*)["'`]/g)) {
          if (s[1] != null) strings.push(s[1]);
        }
      }
      for (const str of strings) {
        for (const tok of str.split(/\s+/)) {
          if (/^[a-z][a-z0-9-]*$/.test(tok) && !tokens.has(tok)) {
            tokens.set(tok, path.relative(repoRoot, file));
          }
        }
      }
    }
  }
  return tokens;
}

describe("Tailwind utility collisions (visual inertness)", () => {
  it("no bare-token className matches a generated utility without a legacy CSS rule", async () => {
    const [utilities, legacy, jsxTokens] = [
      await generatedSimpleUtilities(),
      legacyCssClasses(),
      jsxClassNameTokens(),
    ];

    const collisions: string[] = [];
    for (const [token, file] of jsxTokens) {
      if (utilities.has(token) && !legacy.has(token)) {
        collisions.push(`.${token} (first used in ${file})`);
      }
    }

    expect(
      collisions,
      collisions.length
        ? `Tailwind would silently style these bare classNames (no legacy CSS rule):\n  ${collisions.join("\n  ")}\nRename each to a non-utility BEM name to keep the integration visually inert.`
        : undefined,
    ).toEqual([]);
  }, 20000);
});
