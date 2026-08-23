import { describe, it, expect } from "vitest";
import { isWithTracingWrapped } from "./tracing";
import * as unwrappedFixture from "./__fixtures__/unwrapped-route";

/**
 * Architecture guardrail (Design 6.1): every API route handler must go through
 * `withTracing`, or it ships outside the request-scoped tracing net and its
 * worst-case latency is unattributable from logs — exactly the blind spot the
 * 2026-07 audit hit. Wrapping is not statically detectable (route shells
 * re-export handlers wrapped inside lib modules), so the test imports each route
 * module and checks the runtime `WITH_TRACING_MARKER` on every method export.
 */

/** HTTP method exports Next.js App Router treats as route handlers. */
const HTTP_METHOD_EXPORTS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

/**
 * Method-handler exports on a route module that are functions but were NOT
 * produced by `withTracing`. An empty array means the module is fully wrapped.
 */
function collectUnwrappedHandlers(
  moduleNamespace: Record<string, unknown>,
): string[] {
  return HTTP_METHOD_EXPORTS.filter((method) => {
    const value = moduleNamespace[method];
    return typeof value === "function" && !isWithTracingWrapped(value);
  });
}

// Every route.ts under src/app/api, lazily importable. `import.meta.glob` is
// resolved by Vite at build time, so a newly added route is picked up with no
// test edit — the enumeration can never silently miss a route. `import.meta.glob`
// is a Vite runtime feature not in the base ImportMeta type, so narrow it here.
type RouteModuleImporter = () => Promise<Record<string, unknown>>;
const routeModules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, RouteModuleImporter>;
  }
).glob("/src/app/api/**/route.ts");
const ROUTE_IMPORT_CONCURRENCY = 8;

async function collectOffenders(
  modules: Record<string, RouteModuleImporter>,
): Promise<string[]> {
  const entries = Object.entries(modules);
  const offenders: string[] = [];

  for (
    let index = 0;
    index < entries.length;
    index += ROUTE_IMPORT_CONCURRENCY
  ) {
    const batch = entries.slice(index, index + ROUTE_IMPORT_CONCURRENCY);
    const batchOffenders = await Promise.all(
      batch.map(async ([routePath, importModule]) => {
        const moduleNamespace = await importModule();
        return collectUnwrappedHandlers(moduleNamespace).map(
          (method) => `${routePath} → ${method}`,
        );
      }),
    );
    offenders.push(...batchOffenders.flat());
  }

  return offenders;
}

describe("withTracing wrapper marker", () => {
  it("stamps a detectable marker on wrapped handlers only", () => {
    expect(isWithTracingWrapped(unwrappedFixture.POST)).toBe(true);
    expect(isWithTracingWrapped(unwrappedFixture.GET)).toBe(false);
    // A bare function, and non-functions, are never mistaken for wrapped.
    expect(isWithTracingWrapped(() => undefined)).toBe(false);
    expect(isWithTracingWrapped(undefined)).toBe(false);
    expect(isWithTracingWrapped({})).toBe(false);
  });

  it("flags an intentionally unwrapped route export (red proof)", () => {
    // The fixture's GET is exported without withTracing; POST is wrapped. The
    // detector must catch GET and clear POST — if it could not, the enumeration
    // below would pass vacuously and never guard anything.
    expect(collectUnwrappedHandlers(unwrappedFixture)).toEqual(["GET"]);
  });
});

describe("every API route export is withTracing-wrapped", () => {
  it("discovers route modules to check", () => {
    // Guards against a glob that silently matches nothing (which would make the
    // per-route assertion vacuously green).
    expect(Object.keys(routeModules).length).toBeGreaterThan(50);
  });

  // Importing every route module pulls in most of the app's dependency graph,
  // so this test bounds concurrency instead of firing 200+ imports at once.
  // The guard still covers every route, but it avoids the import stampede that
  // can push the architecture check past its timeout budget.
  it("wraps every HTTP method export under src/app/api", async () => {
    const offenders = await collectOffenders(routeModules);
    expect(offenders).toEqual([]);
  }, 300_000);
});
