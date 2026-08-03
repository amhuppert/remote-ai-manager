import { describe, expect, it } from "vitest";
import { runCli } from "./core";
import type { CliEnv, CliHost, FetchInit } from "./shared";

/**
 * R2.4's "project-supported commands select a project route" is a claim about the
 * SERVER, but a CLI unit test cannot see the server: its host accepts any path and
 * answers 200, so `cctl ask` kept passing while the project ask route did not
 * exist. This file closes that gap by checking the path the real command dispatch
 * constructs against the real Next.js route tree, so a project-supported command
 * that points at a missing route fails here instead of at an agent's runtime.
 */

// Every route.ts under src/app/api. Only the KEYS are used — the modules are
// imported lazily and only for the handful of routes the CLI actually hits, so
// this does not pull the app's dependency graph into a CLI unit test. Vite
// resolves the glob at build time, so a new route needs no edit here.
type RouteModuleImporter = () => Promise<Record<string, unknown>>;
const routeModules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, RouteModuleImporter>;
  }
).glob("/src/app/api/**/route.ts");

interface ApiRoute {
  /** URL-shaped segments, dynamic ones still bracketed: ["api","projects","[name]",…]. */
  segments: string[];
  importModule: RouteModuleImporter;
}

/** `/src/app/api/projects/[name]/x/route.ts` → segments `["api","projects","[name]","x"]`. */
function toApiRoute(
  filePath: string,
  importModule: RouteModuleImporter,
): ApiRoute {
  const segments = filePath
    .replace(/^\/src\/app\//, "")
    .replace(/\/route\.ts$/, "")
    .split("/");
  return { segments, importModule };
}

const API_ROUTES: ApiRoute[] = Object.entries(routeModules).map(
  ([filePath, importModule]) => toApiRoute(filePath, importModule),
);

function isDynamic(segment: string): boolean {
  return segment.startsWith("[") && segment.endsWith("]");
}

function isCatchAll(segment: string): boolean {
  return segment.startsWith("[...") || segment.startsWith("[[...");
}

/** Does a concrete request path match this route's segment pattern? */
function routeMatches(route: ApiRoute, requestSegments: string[]): boolean {
  const { segments } = route;
  for (let i = 0; i < segments.length; i++) {
    const pattern = segments[i];
    if (pattern === undefined) return false;
    // A catch-all consumes every remaining segment (and requires at least one).
    if (isCatchAll(pattern)) return requestSegments.length > i;
    const actual = requestSegments[i];
    // A dynamic segment matches any single NON-EMPTY segment. Requiring
    // non-empty is what makes a neutralized `CC_SESSION` produce a real miss
    // rather than silently matching `/sessions//…`.
    if (actual === undefined || actual === "") return false;
    if (isDynamic(pattern)) continue;
    if (pattern !== actual) return false;
  }
  return requestSegments.length === segments.length;
}

function findRoute(requestPath: string): ApiRoute | null {
  const requestSegments = requestPath.replace(/^\//, "").split("/");
  return (
    API_ROUTES.find((route) => routeMatches(route, requestSegments)) ?? null
  );
}

/** The env a PROJECT conversation's agent receives (R2.2). */
const projectEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_CONVERSATION_SCOPE: "project",
  CC_SESSION: "",
  CC_CONVERSATION_ID: "conv-1",
};

interface RecordedRequest {
  path: string;
  method: string;
}

function makeHost(body: unknown): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    async fetch(url: string, init: FetchInit) {
      requests.push({
        path: new URL(url).pathname,
        method: (init.method ?? "GET").toUpperCase(),
      });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async readTextFile() {
      return JSON.stringify({ summary: "s", objective: "o", decisions: [] });
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

/**
 * Project-supported commands that issue a request with inline arguments. Each
 * entry is a real `cctl` invocation driven through the production dispatch; the
 * response body only has to satisfy the command's own output parsing.
 */
const PROJECT_SCOPE_INVOCATIONS: {
  name: string;
  argv: string[];
  body: unknown;
}[] = [
  { name: "notify", argv: ["notify", "done"], body: { ok: true } },
  {
    name: "ask",
    argv: [
      "ask",
      "--question",
      "Ship it?",
      "--option",
      "Yes",
      "--option",
      "No",
      "--header",
      "Ship",
    ],
    body: { ok: true, questionBatchId: "b-1" },
  },
  {
    name: "conversation read",
    argv: ["conversation", "read", "conv-1"],
    body: {
      ok: true,
      conversationId: "conv-1",
      messages: [],
      window: { from: 0, to: 0, total: 0 },
    },
  },
  {
    name: "doctor",
    argv: ["doctor"],
    body: {
      serverBuild: "dev",
      identity: { project: "cc", session: null, conversation: "conv-1" },
      tokenValid: true,
    },
  },
  { name: "ticket list", argv: ["ticket", "list"], body: { tickets: [] } },
  {
    name: "spec abandon",
    argv: ["spec", "abandon", "feat", "--reason", "x"],
    body: { spec: { slug: "feat", status: "abandoned" } },
  },
  {
    name: "spec withdraw-proposal",
    argv: ["spec", "withdraw-proposal", "feat", "--revision", "revision-1"],
    body: {
      withdrawn: {
        id: "revision-1",
        specId: "spec-1",
        number: 2,
        state: "withdrawn",
        authoringStage: "plan",
        basedOnRevisionId: null,
        contentHash: "hash",
        proposedAt: "2026-08-02T00:00:00.000Z",
        approvedAt: null,
        createdAt: "2026-08-02T00:00:00.000Z",
      },
      draft: {
        id: "revision-2",
        specId: "spec-1",
        number: 3,
        state: "draft",
        authoringStage: "plan",
        basedOnRevisionId: "revision-1",
        contentHash: null,
        proposedAt: null,
        approvedAt: null,
        createdAt: "2026-08-02T00:00:00.000Z",
      },
    },
  },
  {
    name: "workflow list",
    argv: ["workflow", "list"],
    body: { workflows: [] },
  },
  {
    name: "workflow templates",
    argv: ["workflow", "templates"],
    body: { templates: [] },
  },
];

describe("route enumeration", () => {
  it("discovers the API route tree", () => {
    // A glob that matched nothing would make every assertion below vacuous.
    expect(API_ROUTES.length).toBeGreaterThan(100);
  });

  it("rejects a path with no route, and an empty dynamic segment (red proof)", () => {
    // Without these, `findRoute` returning a match for everything would let the
    // per-command assertions pass no matter what the CLI built.
    expect(
      findRoute("/api/projects/cc/conversations/conv-1/definitely-not-a-route"),
    ).toBeNull();
    // The exact shape a non-neutralized session env would produce.
    expect(
      findRoute("/api/projects/cc/sessions//conversations/conv-1/read"),
    ).toBeNull();
  });

  it("matches a known concrete route and a catch-all route", () => {
    expect(
      findRoute("/api/projects/cc/conversations/conv-1/ask"),
    ).not.toBeNull();
    expect(
      findRoute(
        "/api/projects/cc/sessions/s1/graph-workflow/shared-documents/a/b.md",
      ),
    ).not.toBeNull();
  });
});

describe("every project-supported cctl command reaches a real Next.js route", () => {
  for (const { name, argv, body } of PROJECT_SCOPE_INVOCATIONS) {
    it(`${name} builds a path served by an existing route module`, async () => {
      const host = makeHost(body);
      await runCli(argv, projectEnv, host);

      expect(host.requests.length).toBeGreaterThan(0);
      for (const { path, method } of host.requests) {
        const route = findRoute(path);
        // The failure message names the path, because "expected null not to be
        // null" would not say which route is missing.
        expect(route === null ? `NO ROUTE for ${path}` : path).toBe(path);
        if (route === null) continue;

        // Existing is not enough: the route must export the METHOD the CLI uses,
        // or the request 405s in production while this test would still pass.
        const moduleNamespace = await route.importModule();
        expect(
          typeof moduleNamespace[method] === "function"
            ? method
            : `${path} exports no ${method} (has: ${Object.keys(moduleNamespace).join(", ")})`,
        ).toBe(method);
      }
    });
  }
});
