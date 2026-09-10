// @vitest-inputs src/app/**/{page,layout}.tsx
/**
 * Build-time guard: a page that reads the global config must not prerender.
 *
 * `readConfig()` parses the machine's live `config.json`. A server component
 * that calls it without opting out of static rendering runs that parse during
 * `next build`, against whatever shape the developer's (or CI's) config
 * happens to have — including a shape that predates a config migration, since
 * migrations run at server startup, strictly after the build. When a schema
 * tightens, every such page turns a stale local config into a hard build
 * failure that no code change on the branch explains.
 *
 * `export const dynamic = "force-dynamic"` defers the read to request time,
 * which is after startup migrations have normalized the file.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const appDir = path.join(process.cwd(), "src", "app");

function routeEntrypoints(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return routeEntrypoints(entryPath);
    if (!entry.isFile()) return [];
    return /^(page|layout)\.tsx$/.test(entry.name) ? [entryPath] : [];
  });
}

describe("app-router config reads", () => {
  it("keeps every config-reading route entrypoint out of the prerender pass", () => {
    const offenders = routeEntrypoints(appDir).filter((filePath) => {
      const source = readFileSync(filePath, "utf8");
      if (!/\breadConfig\b/.test(source)) return false;
      return !/export const dynamic\s*=\s*["']force-dynamic["']/.test(source);
    });

    expect(
      offenders.map((filePath) => path.relative(process.cwd(), filePath)),
    ).toEqual([]);
  });
});
