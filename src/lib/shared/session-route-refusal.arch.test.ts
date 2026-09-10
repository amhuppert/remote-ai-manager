// @vitest-inputs src/app/** src/lib/**/*.{ts,tsx}
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Structural backstop for R1.2 / D2: EVERY public session route refuses the
 * internal project sentinel.
 *
 * The behavioural refusal tests prove the guard works on the routes that call
 * it. What they cannot prove is that a route calls it at all — and a route that
 * resolves the project itself instead of going through the session resolution
 * seam silently opts out. That is how `workflow-envelopes`, `alignment`, and the
 * graph-workflow lane endpoints accepted the sentinel: each hand-rolled
 * `resolveProjectOr404` + `params["session"]`, so nothing on their path ever saw
 * the guard, and the defect was invisible to every test that exercised them.
 *
 * This test closes the class instead of those three instances: a new session
 * route that skips the seam fails here rather than shipping the next silent
 * alias.
 *
 * The check is on IMPORTED SYMBOLS, not on module reachability or raw text.
 * `shared/route-resolution.ts` both declares the guard and is imported by nearly
 * every handler, so "does the import graph reach the guard's module" would pass
 * vacuously — and matching the identifier anywhere in a file would too, since
 * the declaring module contains it. A handler must IMPORT one of the entry
 * points below, which the declaring module by definition does not.
 */

const SRC_ROOT = path.resolve(__dirname, "..", "..");
const SESSION_ROUTE_ROOT = path.join(
  SRC_ROOT,
  "app",
  "api",
  "projects",
  "[name]",
  "sessions",
  "[session]",
);

/**
 * The entry points that refuse the sentinel before the session name is used.
 * `refuseProjectSentinelSessionParam` is the guard itself; the resolvers call it
 * as their first step. `resolveProjectSentinelRefusalTarget` is the entry point
 * for a handler that refuses by throwing its own domain error rather than
 * returning a Response (agent capabilities), so it names the same replacement
 * route with the same code. Each is pinned by its own behavioural test.
 */
const REFUSAL_ENTRY_POINTS = [
  "refuseProjectSentinelSessionParam",
  "resolveProjectSessionOr404",
  "resolveSessionRoute",
  "resolveSessionConversationRoute",
  "resolveProjectSentinelRefusalTarget",
] as const;

/**
 * How far to follow imports out of a `route.ts`. Route files delegate to a
 * handler module, and some delegate through a thin bindings module that only
 * wires production deps — two hops covers both shapes without widening into the
 * transitive graph, where the vacuous-truth problem returns.
 */
const MAX_DEPTH = 2;

function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listRouteFiles(full));
      continue;
    }
    if (name === "route.ts") out.push(full);
  }
  return out;
}

/** Resolve an import specifier to a file under `src/`, or null if it is external. */
function resolveModule(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith("@/")
    ? path.join(SRC_ROOT, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(fromFile), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this extension; try the next candidate.
    }
  }
  return null;
}

interface ModuleImports {
  /** Identifiers named in an `import … from` / `export … from` clause. */
  names: Set<string>;
  /** The in-`src` files those specifiers resolve to. */
  files: string[];
}

/**
 * Both forms matter: handler modules `import` the guard, while App Router route
 * files are pure `export … from` re-exports and would otherwise look like they
 * import nothing at all.
 */
function readImports(file: string): ModuleImports {
  const source = readFileSync(file, "utf8");
  const names = new Set<string>();
  const files: string[] = [];
  for (const match of source.matchAll(
    /(?:import|export)\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g,
  )) {
    const clause = match[1] ?? "";
    const specifier = match[2] ?? "";
    for (const name of clause.matchAll(/[A-Za-z_$][\w$]*/g)) {
      names.add(name[0]);
    }
    const resolved = resolveModule(specifier, file);
    if (resolved !== null) files.push(resolved);
  }
  return { names, files };
}

/**
 * Only routing modules are followed. A handler module imports its whole domain,
 * and any one of those neighbours may import a resolver for its own reasons —
 * following them would let a route pass on someone else's guard. The delegation
 * chain this test cares about is `route.ts` → `*route-handlers` /
 * `*route-bindings`, so it stays inside it.
 */
function isRoutingModule(file: string): boolean {
  return path.basename(file).includes("route");
}

/** Does `routeFile` import a refusal entry point within `MAX_DEPTH` hops? */
function reachesRefusal(routeFile: string): boolean {
  const seen = new Set<string>();
  let frontier = [routeFile];
  for (let depth = 0; depth <= MAX_DEPTH; depth += 1) {
    const next: string[] = [];
    for (const file of frontier) {
      if (seen.has(file)) continue;
      seen.add(file);
      const imports = readImports(file);
      if (REFUSAL_ENTRY_POINTS.some((symbol) => imports.names.has(symbol))) {
        return true;
      }
      next.push(...imports.files.filter(isRoutingModule));
    }
    frontier = next;
  }
  return false;
}

describe("every public session route refuses the project sentinel", () => {
  const routeFiles = listRouteFiles(SESSION_ROUTE_ROOT);

  it("finds the session route tree", () => {
    expect(routeFiles.length).toBeGreaterThan(50);
  });

  it("routes every session-addressed endpoint through a refusal entry point", () => {
    const unguarded = routeFiles
      .filter((file) => !reachesRefusal(file))
      .map((file) => path.relative(SRC_ROOT, file))
      .sort();

    expect(unguarded).toEqual([]);
  });
});
